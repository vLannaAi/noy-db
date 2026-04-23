# Issue #258 — feat(to-ssh): @noy-db/to-ssh — SSH/SFTP store with public-key auth

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-23
- **Closed:** 2026-04-23
- **Milestone:** Fork · Stores (@noy-db/to-*)
- **Labels:** type: feature, area: adapters

---

## Target package

`@noy-db/to-ssh` (new)

## Problem

Between `to-file` (local), `to-webdav` (HTTP), and `to-smb`/`to-nfs` (LAN-only plaintext protocols), there's an obvious gap: **any Linux/macOS box with sshd running.** Dev servers, personal VPS, home NAS with SSH enabled, bastion hosts — a huge chunk of existing infrastructure. Most users already have working SSH keys in `~/.ssh/` or a running ssh-agent. No new credentials, no server-side deployment, no protocol translation layer.

`to-webdav` covers "I have a web server." `to-ssh` covers "I have shell access."

## Scope

- **Protocol: SFTP over SSH**, not per-call SCP. One long-lived ssh2 channel serves all six store methods — 10K records shouldn't mean 10K handshakes.
- **Driver: `ssh2` as peer dep.** Pure JS, no native build, de-facto standard. Consumer installs alongside `@noy-db/to-ssh`.
- **Auth modes:**
  - Private key bytes (inline `Buffer` / `string`)
  - Private key path (read from `~/.ssh/id_ed25519` etc.)
  - SSH agent via `SSH_AUTH_SOCK` (most common on dev boxes)
  - Optional passphrase for encrypted keys
  - Password auth explicitly NOT supported (keys only — zero-knowledge positioning)
- **Indexed layout** (same shape as `to-file` / `to-webdav`):
  ```
  {remotePath}/{vault}/{collection}/{id}.json
  {remotePath}/{vault}/_keyring/{userId}.json
  ```
- **Per-record atomic write:** `SFTP_WRITE` to `{id}.json.tmp` → `SFTP_RENAME` to `{id}.json`. POSIX rename is atomic, so readers never see a partial write.
- **Capabilities:**
  ```ts
  {
    casAtomic: false,          // no file-system metadata CAS on remote
    auth: { kind: 'ssh', flow: 'key', required: true },
  }
  ```
- **Known host verification** — consumer supplies a `hostKeyVerifier(host, fingerprint)` callback (defaults to reading `~/.ssh/known_hosts`). MITM protection is the caller's responsibility; the store surfaces the fingerprint cleanly.

## Non-goals

- Password auth. Use `to-webdav` over HTTPS if you genuinely don't have a key.
- Jump hosts / ProxyCommand chaining — v0.2 follow-up.
- Multi-factor auth (TOTP, YubiKey challenge-response). Out of scope.
- Rsync-style delta sync. Per-record writes only.

## Recommended role

| Role | Verdict |
|---|---|
| Primary (single user, remote dev) | ✅ |
| Primary (multi-user, concurrent writes) | ❌ — `casAtomic: false`, use `routeStore` with a primary that supports CAS |
| Sync / backup target | ✅ |

## Acceptance

- [ ] `@noy-db/to-ssh` package implementing `NoydbStore`
- [ ] `ssh2` as peer dependency (not direct)
- [ ] Key-only auth; private key from bytes, path, or ssh-agent
- [ ] Atomic per-record write via temp + SFTP rename
- [ ] Tests use a duck-typed mock SFTP client (no real sshd required for CI)
- [ ] README covers the common setup patterns (VPS, home server, bastion)

## Related

- #103 `NoydbBundleStore` (not used — this is indexed, not bundle)
- #101 `syncPolicy` scheduling
- #141 `casAtomic` + `acknowledgeRisks`
- #144 `@noy-db/to-smb` (LAN sibling)
- #145 `@noy-db/to-nfs` (LAN sibling)
- #181 `@noy-db/to-webdav` (HTTP sibling — already landed)
