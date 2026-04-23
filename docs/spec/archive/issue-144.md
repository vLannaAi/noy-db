# Issue #144 — feat(to-smb): @noy-db/to-smb — SMB/CIFS network file store

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-09
- **Closed:** 2026-04-23
- **Milestone:** Fork · Stores (@noy-db/to-*)
- **Labels:** type: feature, priority: low, area: adapters

---

## Summary

A dedicated store for SMB (Server Message Block / CIFS) network shares — Windows file servers, NAS devices (Synology, QNAP, Netgear), and corporate shared drives.

`@noy-db/to-file` technically works on a mounted SMB share but has no awareness of SMB-specific behavior. This package adds direct SMB protocol support without requiring an OS-level mount.

## Why not just `@noy-db/to-file` on a mounted path

| Concern | `to-file` on mount | `to-smb` |
|---|---|---|
| Auth | OS handles; no noy-db config | NTLM / Kerberos credentials in `createStore()` |
| File locking | OS advisory locks — unreliable across clients | SMB oplocks (opportunistic locking) — better cross-client safety |
| Reconnection | Transparent or silent failure | Explicit retry with credential refresh |
| CI / headless | Requires pre-mounted volume | Direct connection, no mount step |
| NAS without domain | Needs manual mount | Username + password in config |

## Authentication

```ts
const store = smb({
  host: '192.168.1.10',
  share: 'accounting',
  path: 'noydb',           // subdirectory within the share
  username: 'alice',
  password: '…',           // or: domain + kerberos ticket
  domain: 'CORP',          // optional, for NTLM domain auth
})
```

- **NTLM** — username + password, with optional domain. Most NAS and workgroup setups.
- **Kerberos** — domain-joined environments. Credentials from the OS ticket cache (`kinit`). No password in config.

Credentials stored in `_sync_credentials` (encrypted, #110) — never in plaintext config beyond initial setup.

## Granularity and file layout

Indexed store — same layout as `to-file`:

```
\\\\server\\share\\noydb\\{vault}\\{collection}\\{id}.json
\\\\server\\share\\noydb\\{vault}\\_keyring\\{userId}.json
```

## StoreCapabilities

```ts
{
  casAtomic: false,        // SMB advisory locks are unreliable across clients
  auth: { kind: 'smb', flow: 'ntlm' | 'kerberos', required: true },
}
```

## Library

Leverage `@marsaud/smb2` or `smb2-promise` for Node. Browser use is not supported (browsers cannot speak SMB).

## Related

- #103 — `NoydbBundleStore` interface
- #101 — `syncPolicy` scheduling
- #141 — `casAtomic` + `acknowledgeRisks`
- #145 — `@noy-db/to-nfs` (sibling network file store)

---
**Naming convention update (2026-04-23):** Renamed from `@noy-db/store-smb` to `@noy-db/to-smb`; `@noy-db/store-file` → `@noy-db/to-file`; `NoydbStore` / `StoreCapabilities` naming aligned to v0.11+ spec.
