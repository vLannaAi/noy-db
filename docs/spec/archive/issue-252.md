# Issue #252 — feat(as-noydb): @noy-db/as-noydb — encrypted .noydb bundle export (encrypted tier of as-*)

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-21
- **Closed:** 2026-04-23
- **Milestone:** Fork · As (@noy-db/as-*)
- **Labels:** type: feature, area: core

---

## `@noy-db/as-noydb` — encrypted `.noydb` bundle export (encrypted tier)

The sole member of the Fork · As **encrypted tier**. Wraps the core `.noydb` container format (`writeNoydbBundle()` / `readNoydbBundle()` in `@noy-db/hub`) with the authorization gate, audit-ledger entry, and ergonomic helpers that parallel the plaintext-tier siblings (`as-xlsx`, `as-csv`, `as-json`, …).

**Zero-knowledge preserved.** Unlike the plaintext tier, this package never reveals a single byte of plaintext to its caller — the vault's DEKs re-encrypt the body before it leaves the gate. That's why it has its own capability bit (`canExportBundle`) with default-on for owner/admin: a bundle is inert without the KEK, so the default friction differs from the plaintext tier's default-off policy.

See the authorization RFC #249 for the full gate design.

## Why a dedicated `as-noydb` package when `writeNoydbBundle()` already exists?

Three reasons:

1. **Gate enforcement** — `writeNoydbBundle()` stays un-gated for legitimate internal use (e.g., the `.noydb` snapshot in `routeStore` ephemeral routing, or test fixtures). The gated path for end users is a new `vault.writeBundle()` wrapper, and `@noy-db/as-noydb` is the canonical public surface that routes through it.
2. **Discoverability** — consumers looking for "how do I export my vault" find one place: the `@noy-db/as-*` family. `as-noydb` sits alongside `as-xlsx` etc. so the mental model is uniform.
3. **Ergonomic helpers** — parallel to `as-json.download()` / `as-json.write()`, this package ships `asNoydb.download()` (browser → Blob → Save-As prompt) and `asNoydb.write(path, { acknowledgeRisks: true })` (Node → filesystem), plus a header-peek helper for consumers doing due diligence on received bundles.

## API sketch

```ts
import { asNoydb } from '@noy-db/as-noydb'

// Browser download — Tier 2 in the plaintext model, but encrypted-tier here
await asNoydb.download(vault, {
  filename: 'company-2026-04-backup.noydb',
  // Note: no `resolveDictionaryLabels` option — bundle preserves stable keys.
  // No `collections` option — bundle is whole-vault by design.
})

// Node file write — bundle to disk is a legitimate encrypted-tier destination
await asNoydb.write(vault, '/backups/company-2026-04-backup.noydb')
// Note: no `acknowledgeRisks` required — the bytes are ciphertext. The
// risk model is "don't also store the passphrase here", not "don't write".

// In-memory bytes (for custom sinks — S3 upload, WebDAV put, email attachment)
const bytes: Uint8Array = await asNoydb.toBytes(vault)

// Peek at a received bundle without decrypting
const header = await asNoydb.readHeader(bytes)
console.log(header.handle, header.bodyBytes, header.bodySha256)
```

## Authorization + audit

Gated by `canExportBundle` (default on for `owner` and `admin`, off for `operator`/`viewer`/`client`). Emits a single audit-ledger entry per call:

```ts
{
  type: 'as-export',
  encrypted: true,
  package: '@noy-db/as-noydb',
  collection: null,          // whole-vault
  recordCount: 1842,
  actor: 'owner@firm.example',
  mechanism: 'noydb-bundle',
  grantedBy: null,            // default-on for owner
  reauthFresh: true,
  bundleHandle: '01HMQ...',   // ULID from the bundle header
  bundleBytes: 2_483_901,
  timestamp: '2026-04-23T10:45:00Z',
}
```

## Differences from plaintext-tier siblings

| Aspect | Plaintext tier (`as-xlsx`/`as-csv`/…) | Encrypted tier (`as-noydb`) |
|--------|---------------------------------------|-----------------------------|
| Capability bit | `canExportPlaintext` | `canExportBundle` |
| Default for owner | off (grant required) | on |
| Default for operator | off (grant required) | off (grant required) |
| Dict-label expansion | yes (for as-xlsx) — render-time exception to stable-key invariant | **no** — bundle preserves stable keys, labels resolve when the bundle is opened in another vault |
| `acknowledgeRisks` flag | required for Tier-3 on-disk writes | not required — bytes are ciphertext |
| Ledger `encrypted` field | `false` | `true` |
| Scope | per-collection (ACL-scoped) | whole-vault (requires owner/admin-level KEK access by design) |

## Acceptance

- [ ] Package skeleton under `packages/as-noydb/`
- [ ] Three entry points: `download()` (browser), `write()` (node), `toBytes()`, plus `readHeader()`
- [ ] Honours `canExportBundle` capability (blocked by #249)
- [ ] Writes audit-ledger entry with `encrypted: true` + bundle header fields
- [ ] Uses `vault.writeBundle()` gated path, NOT the un-gated `writeNoydbBundle()`
- [ ] Unit tests: owner happy path, operator without grant refused, operator with grant succeeds, header-peek works on received bytes, session-policy refusal
- [ ] Showcase demonstrating round-trip backup + restore
- [ ] README documents the asymmetric default policy vs plaintext tier

Blocked by #249.
