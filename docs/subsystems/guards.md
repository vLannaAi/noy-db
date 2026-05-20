# guards

> **Subpath:** `@noy-db/hub/guards`
> **Factory:** `withGuard()`
> **Cluster:** B — Write & Mutate
> **LOC cost:** ~310 (off-bundle when not opted in)

## What it does

Three write-boundary primitives in one strategy: a per-record **lock** (`check`),
per-field **freeze** (`frozenFields`), and an **amendment invariant** that
permits controlled multi-record edits inside `db.transaction({ amendment: true,
reason })`. Guard callbacks run after DEK unwrap on plaintext, before
encryption and before the period seal — the store never sees plaintext.

## When you need it

- Accounting / financial books where issued invoices must not change
- Workflows that freeze specific fields after a status transition (e.g.
  `amount` immutable once `status === 'paid'`)
- Audit-tracked corrections that must preserve an invariant (totals,
  balanced double-entry pairs)
- Any domain where a single permission bit ("can write") is too coarse

## Opt-in

```ts
import { createNoydb } from '@noy-db/hub'
import { withGuard, RecordLockedError, InvariantError } from '@noy-db/hub/guards'
import { withTransactions } from '@noy-db/hub/tx'

const disbursementGuard = withGuard<Disbursement>({
  collection: 'disbursements',
  check: async (incoming, { vault }) => {
    const inv = await vault.collection<Invoice>('invoices').get(incoming.invoiceId)
    if (inv?.status === 'issued') {
      throw new RecordLockedError('disbursements', incoming.id, 'invoice is issued')
    }
  },
  amendment: {
    roles: ['admin', 'owner'],
    invariant: (changes) => {
      const sum = (s: 'before' | 'after') =>
        changes.reduce((t, c) => t + ((c[s])?.amount ?? 0), 0)
      if (sum('before') !== sum('after')) {
        throw new InvariantError('total must be preserved')
      }
    },
  },
})

const db = await createNoydb({
  store: ...,
  user: ...,
  guardStrategies: [disbursementGuard],
  txStrategy: withTransactions(), // required for amendment mode
})
```

## API

Four primitives, one strategy:

| Primitive | When it fires | Throws |
|---|---|---|
| `check` | Every `put()` (skipped in amendment mode) | Anything; conventionally `RecordLockedError` |
| `onDelete` | Every `delete()` of an existing record (skipped in amendment mode); skipped for delete-of-absent | Anything; conventionally `RecordLockedError` |
| `frozenFields` | Every `put()` after `when(existing)` becomes true | `FieldFrozenError` listing changed frozen fields |
| `amendment` | Inside `withTransactions({ amendment: true, reason })` | `InvariantError` if the rule fails |

`check` is put-only — `onDelete` is the dedicated delete-time hook. The
argument shapes mirror each other but the semantics are explicit:
`check(incoming, ctx)` validates a record being **written**;
`onDelete(existing, ctx)` validates a record being **removed**.

### `onDelete` bypass paths

Two paths skip the `onDelete` callback. Both are by design:

1. **Amendment transactions** (`db.transaction({ amendment: true })`)
   for admin/owner — amendments are the generic unlock primitive,
   consistent with how `frozenFields` lets staged writes through. The
   `amendment.invariant` block (if declared) DOES still see the
   `{ before, after: null }` change pair and can reject the delete at
   commit time.
2. **System-internal deletes** — derivation tombstones (#144) and MV
   refresh deletes (Dim 14 v2) route through an internal-only delete
   path. Housekeeping ops are not user-initiated and would otherwise
   trip user invariants registered against output collections. **If
   the internal delete fires while an amendment window is open**
   (e.g. an admin amendment edits a source row → triggers a
   derivation cascade → cascades a tombstone), the change pair IS
   pushed onto the amendment's change-set and surfaces to
   `amendment.invariant`. This keeps the "truly unconditional" paired
   pattern below honest.

### Truly unconditional delete-block — pair the two hooks

`onDelete: () => { throw }` alone is NOT unconditional. An admin
amendment can still bypass it. For legal-document immutability rules
(e.g. Thai Revenue Code §86: receipts are append-only forever) pair
`onDelete` with an `amendment.invariant` that re-throws on any
delete-shaped change:

```ts
withGuard<Receipt>({
  collection: 'receipts',
  onDelete: () => {
    throw new RecordLockedError('receipts', '', 'receipts are append-only')
  },
  amendment: {
    roles: ['admin', 'owner'],
    invariant: (changes) => {
      for (const c of changes) {
        if (c.before !== null && c.after === null) {
          throw new RecordLockedError('receipts', '', 'amendment cannot delete')
        }
      }
    },
  },
})
```

The thrown `RecordLockedError` inside `invariant` is wrapped in
`InvariantError` by `GuardExecutor.runInvariant` (the message survives);
the staged delete rolls back, the record stays.

### Amendment flow

```
db.transaction({ amendment: true, reason }, async tx => {
  await tx.vault('books').collection('lines').put(...)
  await tx.vault('books').collection('lines').put(...)
})

  → 1. Validate reason (ValidationError if missing/empty)
  → 2. First tx.vault(name): role check (admin | owner) — AmendmentForbiddenError fail-fast
  → 3. beginAmendment() on touched vault's registry
  → 4. Writes buffered — check + frozenFields skipped, collectChange records (before, after) + (id, vBefore, vAfter)
  → 5. Invariant at commit (over full change-set) — InvariantError = rollback
  → 6. Audit entry to ledger (op: 'amendment') if historyStrategy is configured
```

### Composition order

`withGuard` runs **before encryption** and **before** the period seal check:

```
Collection.put
  1. Permission check
  2. GuardRegistry.check           ← this doc
  3. PeriodGuard
  4. Schema validation
  5. i18n auto-translate
  6. Ref enforcement
  7. Encrypt + store.put
  8. Ledger append
```

### Errors

All four extend `NoydbError`:

- `RecordLockedError(collection, id, reason)` — `check` threw
- `FieldFrozenError(collection, id, fields[])` — frozen field changed
- `InvariantError(message)` — amendment invariant rejected
- `AmendmentForbiddenError(userId, role)` — caller can't open amendment

## Behavior when NOT opted in

- `createNoydb({ guardStrategies: [...] })` is the only way to register guards;
  without it, no guard fires
- Amendment mode requires `withTransactions`; without `withGuard` it's a silent
  no-op (the empty change-set short-circuits before the role check, invariant,
  and audit append)
- `RecordLockedError` / `FieldFrozenError` / `InvariantError` /
  `AmendmentForbiddenError` are still importable from `@noy-db/hub/guards`
  but are never thrown by core

## Pairs well with

- **transactions** — amendment mode is layered on `withTransactions`
- **history** — successful amendments append a multi-record summary entry to
  the hash-chained ledger (per-record entries always fire from `Collection.put`)
- **periods** — guards run before the period seal, so a lock can preempt a
  `PeriodClosedError` with a more specific reason

## Edge cases & limits

- **Guards see the pre-schema-validation incoming record.** If a schema
  validator coerces values (trims strings, applies defaults), the guard
  observes the raw user-supplied shape; the stored shape is post-coercion.
  Guards should only consume fields declared in `frozenFields.fields` or
  read via `ctx.vault` — those paths are stable across schema transforms.
- **On `delete`, `incoming === ctx.existing`.** Conceptually `incoming` is
  absent for a delete, but the guard's `check` callback receives the
  existing record so it can inspect status before allowing the deletion.
  Read `ctx.existing` to be explicit.
- **`delete` of a non-existent record is a no-op.** Guards are not consulted
  in that case; the call returns without error.
- **Multiple guards on the same collection** run in registration order;
  first throw wins (short-circuits remaining guards).
- **Amendment authorization is binary in v1.** The `amendment.roles` field
  on a guard is declarative documentation — runtime authorization is
  enforced by the vault's keyring role (must be `admin` or `owner`). A
  future v2 may consult the per-guard list for finer-grained roles.
- **Amendment audit append is conditional on `historyStrategy`.** Vaults
  without history still enforce amendment rules (role check + invariant +
  rollback) but skip the multi-record summary entry.
- **`verifyBackupIntegrity` and `reconstructAtVersion` skip amendment
  entries** — they're audit-only and don't reflect per-record state.

### Zero-knowledge guarantee

Guard functions run **after DEK unwrap, on plaintext, inside the encrypted
boundary**. The store sees only ciphertext envelopes. The
`ReadOnlyVaultFacade` passed as `ctx.vault` decrypts on access — no
plaintext leaks to the store.

### `ReadOnlyVaultFacade` surface

```ts
ctx.vault.collection<T>(name).get(id)    // single record
ctx.vault.collection<T>(name).list()     // every record (decrypts all)
ctx.vault.collection<T>(name).query()    // chainable read-only builder
```

`query()` returns the same `Query<T>` builder used elsewhere in the
library. Its terminals (`toArray`, `first`, `count`, `aggregate`,
`groupBy`, `live`) are read-only — there is no `.update()` / `.delete()`
on a `Query`. Prefer `.query().aggregate({ ... })` over `.list()` +
manual reduce when enforcing Σ-style invariants: only the records the
predicate touches get materialised, and the aggregate path is the same
one used by the rest of the library.

```ts
// Σ-over-siblings invariant — payment-allocation sum must not exceed payment
import { sum } from '@noy-db/hub'

withGuard<Allocation>({
  collection: 'allocations',
  check: async (incoming, { vault, existing }) => {
    const payment = await vault.collection<Payment>('payments').get(incoming.paymentId)
    const { total } = await vault
      .collection<Allocation>('allocations')
      .query()
      .where('paymentId', '==', incoming.paymentId)
      .aggregate({ total: sum<Allocation>('appliedAmount') })
      .run()
    const otherTotal = total - (existing?.appliedAmount ?? 0)
    if (otherTotal + incoming.appliedAmount > payment.amount) {
      throw new InvariantError('allocations', incoming.id, '…')
    }
  },
})
```

Aggregates require the `aggregateStrategy: withAggregate()` opt-in (the
same opt-in everything else in the query DSL respects) — `query()`
itself is always present on the facade.

### Audit-entry shape

```ts
{
  op: 'amendment',
  actor: 'alice',
  ts: '2026-05-18T...',
  collection: '',  // amendment is multi-record; collection/id are empty
  id: '',
  version: 0,
  payloadHash: '',  // per-record entries carry real hashes
  amendment: {
    reason: 'correct split between travel and meals',
    role: 'admin',
    changes: [
      { collection: 'disbursements', id: 'd1', vBefore: 2, vAfter: 3 },
      { collection: 'disbursements', id: 'd2', vBefore: 1, vAfter: 2 },
    ],
    invariantsPassed: ['disbursements'],
  },
}
```

Visible via `vault.ledger().entries()` like every other ledger entry.

### Deferred to v2

- Per-field amendment (amend only specific frozen fields)
- Time-limited amendment windows
- Cross-vault guards (a guard on vault A that reads vault B)
- Guards on `loadAll` / `saveAll`
- Per-guard role list enforcement (currently keyring-role-only)
- Multi-vault amendment audit entries (architectural support exists but is
  untested in v1)

## See also

- [SUBSYSTEMS.md](../../SUBSYSTEMS.md)
- `docs/superpowers/specs/2026-05-18-guards-design.md`
- `__tests__/guards/*.test.ts`, `showcases/src/79-with-guard.showcase.test.ts`
