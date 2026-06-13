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

### Commit-time invariants (#342)

`withTransactions({ invariants: [...] })` declares set-level invariants
that run at commit over the change-set of an ORDINARY `db.transaction()`
(and amendments). No role gate — this generalizes `amendment.invariant`
to plain transactions.

```ts
txStrategy: withTransactions({
  invariants: [{
    scope: 'lines',  // collection name
    check: (changes, ctx) => {
      const total = (s: 'before' | 'after') =>
        changes.reduce((t, c) => t + (c[s]?.amount ?? 0), 0)
      if (total('before') !== total('after')) {
        throw new InvariantError('lines total must be preserved')
      }
    },
  }],
})
```

`scope` is the collection name; `check(changes, ctx)` receives a
`ReadonlyArray<GuardChange>` for that scope — `before` is the plaintext
prior record (`null` on insert), `after` is the written record (`null`
on delete). A throw reverts the whole transaction with `InvariantError`.
The plaintext `before` is captured in Phase 1 before Phase 2 overwrites,
so invariants see the true prior state.

## Behavior when NOT opted in

- `db.transaction(fn)` throws with a pointer to `@noy-db/hub/tx`
- `db.transaction(vaultName)` (the legacy `SyncTransaction` overload) throws same

## Pairs well with

- **history** — every committed op fires a ledger entry per op after commit
- **sync** — staged ops still flow through dirty tracking
- **crdt** — staged ops on CRDT collections merge through the strategy
- **refs** — cascade-delete (ref mode `'cascade'`) is now transaction-atomic (#346): cascaded child deletes roll back with the parent on a mid-batch failure

## Edge cases & limits

- Pre-flight CAS captures the prior envelope per staged op; mid-commit failure reverts executed ops via the raw adapter
- Body errors propagate — wrap in try/catch if you want graceful UX
- Cross-vault transactions need both vaults already opened on the Noydb instance

## See also

- [SUBSYSTEMS.md](../../SUBSYSTEMS.md)
- `__tests__/transaction.test.ts`
