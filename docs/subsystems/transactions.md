# transactions

> **Subpath:** `@noy-db/hub/tx`
> **Factory:** `withTransactions()`
> **Cluster:** B — Write & Mutate
> **LOC cost:** ~280 (off-bundle when not opted in)

## What it does

Multi-record atomic writes via `db.transaction(async (tx) => { ... })`. The body stages put / delete operations on any vault/collection inside the transaction; either every staged op commits together or none of them do. Read-your-writes works inside the body.

## When you need it

- Cross-collection invariants (invoice + payment must both succeed)
- Cross-vault writes (same logical operation across two tenants)
- Optimistic concurrency control via `expectedVersion` on staged ops
- Workflows where a partial write would corrupt downstream state

## Opt-in

```ts
import { createNoydb } from '@noy-db/hub'
import { withTransactions } from '@noy-db/hub/tx'

const db = await createNoydb({
  store: ...,
  user: ...,
  txStrategy: withTransactions(),
})
```

## API

```ts
const result = await db.transaction(async (tx) => {
  const inv = tx.vault('acme').collection<Invoice>('invoices')
  const pay = tx.vault('acme').collection<Payment>('payments')

  inv.put('inv-1', { amount: 100, status: 'paid' })
  pay.put('pay-1', { invoiceId: 'inv-1', amount: 100, paidAt: '...' })

  // Read-your-writes inside the body
  const staged = await inv.get('inv-1')

  return staged.amount  // body return value flows through
})
```

Body throw → no writes. `ConflictError` from a staged `expectedVersion` → no writes (pre-flight CAS).

## Behavior when NOT opted in

- `db.transaction(fn)` throws with a pointer to `@noy-db/hub/tx`
- `db.transaction(vaultName)` (the legacy `SyncTransaction` overload) throws same

## Pairs well with

- **history** — every committed op fires a ledger entry per op after commit
- **sync** — staged ops still flow through dirty tracking
- **crdt** — staged ops on CRDT collections merge through the strategy

## Edge cases & limits

- Pre-flight CAS captures the prior envelope per staged op; mid-commit failure reverts executed ops via the raw adapter
- Body errors propagate — wrap in try/catch if you want graceful UX
- Cross-vault transactions need both vaults already opened on the Noydb instance

## See also

- [SUBSYSTEMS.md](../../SUBSYSTEMS.md)
- `__tests__/transaction.test.ts`
