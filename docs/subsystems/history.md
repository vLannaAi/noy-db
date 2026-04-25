# history

> **Subpath:** `@noy-db/hub/history`
> **Factory:** `withHistory()`
> **Cluster:** B — Write & Mutate
> **LOC cost:** ~1,880 (off-bundle when not opted in)

## What it does

Per-record version snapshots, hash-chained tamper-evident audit ledger, JSON Patch deltas, point-in-time reads via `vault.at(timestamp)`, and backup integrity verification. Every successful `put` / `delete` writes a full envelope snapshot to `_history` and appends a ledger entry to `_ledger`.

## When you need it

- Compliance / audit trails ("who changed this and when")
- Undo / revert UX
- "What did this record look like on date X" — point-in-time reads
- Tamper detection — `vault.verifyBackupIntegrity()` walks the chain
- Diff visualisation between versions

## Opt-in

```ts
import { createNoydb } from '@noy-db/hub'
import { withHistory } from '@noy-db/hub/history'

const db = await createNoydb({
  store: ...,
  user: ...,
  historyStrategy: withHistory(),
})
```

Per-collection retention via `historyConfig`:

```ts
vault.openVault('firm', { historyConfig: { maxVersions: 50 } })
```

## API

- `collection.history(id, options?)` — list versions newest-first
- `collection.getVersion(id, version)` — load a specific version
- `collection.revert(id, version)` — write old content back as a new version
- `collection.diff(id, vA, vB?)` — typed field-level diff
- `collection.clearHistory(id?)` / `pruneRecordHistory(id, options)` — retention
- `vault.ledger()` — `LedgerStore` for direct append/verify/entries
- `vault.at(timestamp)` — `VaultInstant` for point-in-time reads
- `vault.verifyBackupIntegrity()` — chain + data envelope cross-check

## Behavior when NOT opted in

- `put` / `delete` succeed but no snapshot or ledger entry is written
- `collection.history`, `getVersion`, `diff` throw with a pointer to `@noy-db/hub/history`
- `vault.ledger()`, `vault.at()` throw
- `vault.verifyBackupIntegrity()` returns `{ ok: true }` trivially (no chain to diverge from)

## Pairs well with

- **periods** — close-period write-guards check ledger membership
- **consent** — consent audit appends to the ledger when present
- **shadow** — `vault.at(t).collection(...)` is a `CollectionInstant`, a typed shadow

## Edge cases & limits

- Ledger is single-writer. Concurrent appends from two workers can race the head. Multi-writer hardening tracked for v0.6 follow-up
- Time-machine accuracy is bounded by retention: pruned versions are unrecoverable
- Known issue: dictionary writes append empty `payloadHash` (#290) — verifyBackupIntegrity false-negatives until fixed

## See also

- [SUBSYSTEMS.md](../../SUBSYSTEMS.md)
- `docs/recipes/accounting-app.md`
- `__tests__/history.test.ts`, `__tests__/ledger.test.ts`, `__tests__/time-machine.test.ts`
