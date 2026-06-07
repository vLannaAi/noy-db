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
- Multi-writer concurrency — `snapshot()` is safe for single-writer use (local-first, single tab). Two concurrent `snapshot()` calls on the same vault may derive the same blob key and silently produce a corrupted index entry. Multi-writer deployments (server workers, etc.) should serialize calls to `snapshot()` at the application layer.

---

## Automatic cadence

`withSnapshots({ snapshotPolicy })` enables automatic whole-vault snapshots driven
by vault writes. Automatic snapshots overwrite a single rolling key
(`<vault>__auto`) and are **exempt from retention** — the timer can never evict
your labeled on-demand checkpoints, and on-demand `snapshot()` calls preserve the
rolling slot.

```ts
const db = await createNoydb({
  store,
  snapshotStrategy: withSnapshots({
    store: snapshotStore,
    snapshotPolicy: { mode: 'debounce', debounceMs: 60_000, minIntervalMs: 300_000 },
    retention: { keepLast: 10 }, // applies to on-demand checkpoints only
  }),
})
```

| `mode` | Trigger |
|---|---|
| `'manual'` (default) | No timers — `db.snapshot()` only. |
| `'debounce'` | `debounceMs` of write-idle, with a `minIntervalMs` floor. |
| `'interval'` | Fixed `intervalMs` timer. |

`onUnload` (default true for non-manual) flushes a pending auto-snapshot on
tab-hide / process exit. The auto snapshot appears first in `listSnapshots()`
(flagged `auto: true`) and restores like any other
(`db.restoreSnapshot(vault, '<vault>__auto')`). The cadence is wired off the
db's `onAfterWrite` hook; an OCC conflict during an auto-snapshot is logged and
retried on the next cycle, never thrown. The scheduler is torn down by
`db.close()`.

## S3 bundle store

`@noy-db/to-aws-s3` ships `s3Bundle()` — a `NoydbBundleStore` for whole-vault
`.noydb` blobs (distinct from the per-record `s3()` adapter), suitable as a
snapshot destination.

```ts
import { s3Bundle } from '@noy-db/to-aws-s3'

const snapshotStore = s3Bundle({ bucket: 'my-backups', prefix: 'noydb', region: 'us-east-1' })
const db = await createNoydb({ store, snapshotStrategy: withSnapshots({ store: snapshotStore }) })
```

Key scheme is `{prefix}/{vaultId}.noydb`; the version token is the object ETag.
OCC uses S3 conditional writes (`IfMatch` on the ETag); a lost race throws
`BundleVersionConflictError`. `listBundles()` derives metadata from a single
`ListObjectsV2` (no per-object GET). Requires `@aws-sdk/client-s3` ≥ 3.696.

---

## Error Reference

| Error class | Code | Thrown when |
|---|---|---|
| `SnapshotNotFoundError` | `SNAPSHOT_NOT_FOUND` | `version` not in snapshot store (pruned or invalid) |
| `BackupCorruptedError` | `BACKUP_CORRUPTED` | Envelope hash mismatch on restore (tamper detected) |
| `BackupLedgerError` | `BACKUP_LEDGER` | Hash-chain mismatch on restore (tamper detected) |
| `BundleVersionConflictError` | `BUNDLE_VERSION_CONFLICT` | Snapshot/index write lost an OCC race (e.g. S3 `IfMatch` 412) |
