# Issue #242 — feat(core): bulk operations — collection.putMany() / getMany() / deleteMany()

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-21
- **Closed:** 2026-04-21
- **Milestone:** v0.16.0 — Advanced core features
- **Labels:** type: feature, area: core

---

Reported by pilot #1 (2026-04-23): *"approveAll() today loops with one put per record. A batch API would cut round-trips to the IDB/Dynamo adapter by an order of magnitude."*

## The gap

Today `Collection<T>` exposes single-record `put / get / delete / list`. Workflows that touch N records issue N adapter round-trips; on DynamoDB that is N × HTTP latency, on IndexedDB it is N × tx open-commit, on file adapter it is N × fsync.

## Proposed API

```ts
// Bulk put — returns per-record success/failure; never partial commit (atomic if tx supported)
await invoices.putMany([
  ["inv-1", record1],
  ["inv-2", record2],
  ["inv-3", record3],
])

// Bulk get — single call, returns Map<id, T | null>
const fetched = await invoices.getMany(["inv-1", "inv-2", "inv-3"])

// Bulk delete
await invoices.deleteMany(["inv-1", "inv-2", "inv-3"])
```

## Implementation notes

- Each bulk op calls `store.batch(ops)` where supported, fallback to per-item loop otherwise. Adapter capability flag: `StoreCapabilities.bulk: boolean`.
- **Composes cleanly with transactions** (`db.transaction` — see sibling issue). A putMany inside a transaction uses the same atomicity primitive.
- `putMany` + OCC: each item can carry its own `expectedVersion`; on conflict, whole batch rolls back (tx-atomic) or reports per-item failures (lossy mode). Default: tx-atomic.
- Event-emission: one `change` event per mutated record, or a single batched `changes` event. The latter is more efficient for UI updates but breaks existing subscribers. Ship as `changes-batch` event alongside existing per-record events.
- Cascade: every `to-*` adapter gets follow-up work in Fork · Stores to implement native `batch`.

## Success criteria

- 100-record putMany on DynamoDB: 1 TransactWriteItems call (vs 100 PutItem), 10x+ latency reduction.
- 100-record putMany on IndexedDB: 1 readwrite transaction spanning all puts.
- Event-emission honors both legacy per-record subscribers and new batch-aware ones.

Interface expansion — fits v0.16 Advanced core. Cascades to Fork · Stores.
