# Issue #240 — feat(core): transactional multi-record writes — db.transaction(async (tx) => { ... })

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-21
- **Closed:** 2026-04-21
- **Milestone:** v0.16.0 — Advanced core features
- **Labels:** type: feature, priority: high, area: core, pilot-1

---

Reported by pilot #1 (2026-04-23).

## The gap

Workflows that write to ≥2 collections non-atomically (`approveAll`, `recomputeDerivedStatuses`, `disbursement → invoice` cascades) leave persisted state inconsistent on crash mid-cascade. Today the only atomicity primitive noy-db exposes at the store layer is per-record `expectedVersion` CAS; there is no multi-record transaction API at the hub level.

**Distinct from `SyncTransaction`** (v0.9 #135) which implements two-phase commit at the SYNC engine level for push/pull reconciliation. That is not reachable from application code doing local multi-record writes.

## Proposed API

```ts
await db.transaction(async (tx) => {
  const inv = tx.vault(name).collection<Invoice>("invoices")
  const pay = tx.vault(name).collection<Payment>("payments")
  await inv.put(invoiceId, { ...invoice, status: "paid" })
  await pay.put(paymentId, { invoiceId, amount, paidAt })
  // If throw before return: ALL puts rolled back
})
```

Commits either land all puts on return or discard all on throw. Uses `expectedVersion` on every touched record as the concurrency primitive (any concurrent mutation causes retry or explicit `ConflictError`).

## Implementation notes

- Local-first: the transaction commits against the primary store. Sync engine pushes on the usual schedule — transactions do NOT extend across sync-peer boundaries (a distinct, much harder problem).
- The store needs a `batch(operations)` hint — DynamoDB has `TransactWriteItems`, IndexedDB has `readwrite` transactions, file adapter gets a staging-then-rename strategy. Falls back to per-record OCC for stores without native tx support (store declares `txAtomic: boolean` capability).
- Interface expansion: `NoydbStore` gains optional `tx?(ops: TxOp[]): Promise<void>`. Stores without it use the fallback path.
- Cascade implication: every `to-*` adapter gets follow-up work in Fork · Stores to implement native `tx` where possible.

## Success criteria

- `approveAll` completes atomically or not at all (pilots explicit use case).
- `vault.checkIntegrity()` always passes after a completed (non-thrown) transaction.
- Performance: local memory-store transactions are O(N) in records touched, no overhead over per-record puts.

This is real interface expansion — fits v0.16 Advanced core. Cascades to Fork · Stores.
