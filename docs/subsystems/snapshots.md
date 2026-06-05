# Snapshots Subsystem

**Subpath:** `@noy-db/hub/snapshots`  
**Cluster:** snapshot-and-portability  
**Showcase:** 93

---

## Overview

`withSnapshots({ store })` is an opt-in strategy that adds three methods to the `Noydb` instance:

| Method | Description |
|---|---|
| `db.snapshot(vaultId, opts?)` | Take an on-demand whole-vault checkpoint |
| `db.listSnapshots(vaultId)` | List all snapshots (newest first), metadata-only |
| `db.restoreSnapshot(vaultId, version)` | Restore a vault to a prior snapshot; integrity-verified |

Snapshot bytes are produced by `writeNoydbBundle(vault, {})` — the keyring is inherited as-is, so no credentials need to be re-supplied. Each snapshot is stored in a `NoydbBundleStore` (any adapter that implements `readBundle` / `writeBundle` / `deleteBundle` / `listBundles` — `to-drive`, `to-webdav`, etc.) under a unique key `${vaultId}__snap_N`. A sidecar index blob at `${vaultId}__index` holds `SnapshotMeta[]` for fast listing without downloading snapshot bytes.

After `restoreSnapshot()`, existing collection handles become stale — `vault.load()` clears the collection cache internally. Re-obtain collection references via `db.vault(vaultId).collection(name)` after restore.

---

## Setup

```typescript
import { createNoydb } from '@noy-db/hub'
import { withSnapshots } from '@noy-db/hub/snapshots'
import { toDrive } from '@noy-db/to-drive'  // or to-webdav, to-s3, etc.

const db = await createNoydb({
  store: memory(),
  user,
  secret,
  snapshotStrategy: withSnapshots({
    store: toDrive({ ... }),         // where snapshot blobs are kept
    retention: { keepLast: 10 },    // optional; default = keep all
  }),
})
```

---

## API

### `db.snapshot(vaultId, opts?): Promise<SnapshotMeta>`

Creates a checkpoint. The vault must be open (`openVault()` called first).

```typescript
const snap = await db.snapshot('acct', { label: 'before-year-close', note: 'FY2026' })
// snap.version → 'acct__snap_000001' (pass to restoreSnapshot)
// snap.integrity → 'verified'
```

Options:
- `label?: string` — human-readable name shown in the chooser UI
- `note?: string` — freeform memo

### `db.listSnapshots(vaultId): Promise<SnapshotMeta[]>`

Returns snapshots newest-first, from the sidecar index only (no blob downloads).

```typescript
const snaps = await db.listSnapshots('acct')
// [{ version, label, exportedAt, exportedBy, size, integrity }, ...]
```

### `db.restoreSnapshot(vaultId, version): Promise<void>`

Restores the vault in-place. Runs `verifyBackupIntegrity()` automatically.
Throws `SnapshotNotFoundError` if the version doesn't exist (pruned or typo).
Throws `BackupCorruptedError` or `BackupLedgerError` on tamper detection.

After this call, re-obtain all collection references (cache is cleared).

```typescript
await db.restoreSnapshot('acct', snap.version)
const inv = db.vault('acct').collection<Invoice>('invoices') // re-obtain after restore
```

---

## SnapshotMeta

```typescript
interface SnapshotMeta {
  version: string          // lookup key; pass to restoreSnapshot()
  label?: string
  note?: string
  exportedAt: string       // ISO 8601
  exportedBy: string       // NoydbOptions.user at snapshot time
  size: number             // bytes
  integrity: 'verified' | 'legacy-unverifiable'
}
```

---

## Retention Policy

```typescript
interface RetentionPolicy {
  keepLast?: number     // keep only the most recent N snapshots per vault
  maxAgeDays?: number   // delete snapshots older than N days
  prune?: boolean       // false → never call deleteBundle (delegate to infra). Default true.
}
```

Retention is enforced eagerly after each `snapshot()` call. Both `keepLast` and `maxAgeDays` can be combined. Set `prune: false` to use S3 lifecycle rules or similar infra-level expiry instead.

---

## Non-goals

- Not a replacement for `@noy-db/hub/history` (per-record, intra-vault point-in-time). Snapshots are external, whole-vault checkpoints.
- Auto-snapshot cadence — deferred to v2. For now, call `db.snapshot()` on demand.
- Per-collection snapshots — whole-vault only.
- Conflict resolution on restore — in-place `vault.load()`. The app is responsible for checking unsaved state before calling `restoreSnapshot()`.

---

## Error Reference

| Error class | Code | Thrown when |
|---|---|---|
| `SnapshotNotFoundError` | `SNAPSHOT_NOT_FOUND` | `version` not in snapshot store (pruned or invalid) |
| `BackupCorruptedError` | `BACKUP_CORRUPTED` | Envelope hash mismatch on restore (tamper detected) |
| `BackupLedgerError` | `BACKUP_LEDGER` | Hash-chain mismatch on restore (tamper detected) |
