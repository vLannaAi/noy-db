# Issue #135 — feat(core): sync transactions — two-phase commit at the sync engine level

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-09
- **Closed:** 2026-04-09
- **Milestone:** v0.9.0
- **Labels:** type: feature, area: core

---

## Summary

Atomic sync of a multi-record set — either all records land on the remote or none do.

## Proposed API

```ts
const tx = sync.transaction()

// Stage changes (does not write yet)
tx.put('invoices', 'inv-1', updatedInvoice)
tx.put('payments', 'pay-1', newPayment)
tx.delete('drafts', 'draft-1')

// Commit atomically
const result = await tx.commit()
if (result.status === 'conflict') {
  // Handle partial conflict
}
```

## Design

Two-phase commit at the sync engine level:
1. **Prepare phase** — all records written to local adapter as a batch with a shared transaction tag in metadata
2. **Commit phase** — sync pushes all records; any conflict rolls back the entire transaction

The adapter does not need to support native transactions — the two-phase protocol is implemented in core using the existing optimistic concurrency (`_v`) mechanism.

## Related

- Partial sync (can limit transaction scope to specific collections)
- Conflict policies (transaction-level conflict resolution)
