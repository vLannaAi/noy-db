# Guards — record lock, field freeze, amendment invariant (v1 design)

> Companion to `2026-05-01-dim14-derivation-v1-design.md`. Together, derivations and guards form the
> two sides of the "computed + constrained" data model for noy-db. This document covers the guards
> primitive only; derivation is out of scope here.

## Goal

Ship a `withGuard` strategy in `@noy-db/hub` that lets a vault declare:

1. **Cross-collection lock** — writes to a collection are blocked when a related record in another
   collection has reached a specific state (e.g. disbursements locked when their invoice is `issued`).
2. **Field-level freeze** — specific fields on a record become immutable once a condition on that
   same record is true (e.g. `invoice.total` can't change after `invoice.status === 'issued'`).
3. **Invariant amendment** — an authorized user (`admin` | `owner`) can bypass both locks inside a
   `withTransactions({ amendment: true })` block, but only if a declared invariant over the full set
   of changes holds at commit time. Every amendment is written to the tamper-evident audit ledger.

The mechanism lives in noy-db. The policy (what collection, what condition, what invariant, what
fields) is declared by the application. noy-db never knows what an invoice or disbursement is.

## Motivating use case

Accounting domain: collection `disbursements` and `services` feed into `invoices` via a foreign key
`invoiceId`. Once `invoice.status` reaches `'issued'`, line items in those collections must not
change (audit integrity). However, an admin user may still amend the split of amounts between
line items on the same invoice, provided the total is preserved. Every such amendment must be
auditable.

## Success criteria (acceptance)

- Normal `put()` / `delete()` on a locked record throws `RecordLockedError`.
- `put()` that attempts to change a frozen field throws `FieldFrozenError`.
- `withTransactions({ amendment: true })` with a non-admin/owner role throws `AmendmentForbiddenError`
  immediately (before any write is attempted).
- A valid amendment (correct role, invariant passes) commits atomically and writes an
  `AmendmentAuditEntry` to the ledger.
- An amendment whose invariant fails rolls back all writes in the transaction (including
  non-locked ones) and throws `InvariantError`.
- Zero-knowledge is preserved: guard functions run on plaintext inside the encrypted boundary;
  the store never sees the guard logic or the plaintext.
- Conformance tests pass on `to-memory` and `to-file`.

## v1 scope — what's in

| Feature | In v1 |
|---|:---:|
| `withGuard({ collection, check, frozenFields, amendment })` factory | ✓ |
| Cross-collection lock via async `check` (read-only vault facade) | ✓ |
| Field-level freeze via `frozenFields.when` + `frozenFields.fields` | ✓ |
| `withTransactions({ amendment, reason })` role gate (admin \| owner) | ✓ |
| Invariant runner over full transaction change-set at commit | ✓ |
| `AmendmentAuditEntry` in hash-chained ledger | ✓ |
| `RecordLockedError`, `FieldFrozenError`, `InvariantError`, `AmendmentForbiddenError` | ✓ |
| Guard on `delete()` (locked records can't be deleted either) | ✓ |
| Multiple guards on the same collection (all run; first throw wins) | ✓ |
| Conformance test pack | ✓ |
| Showcase `79-with-guard.showcase.test.ts` | ✓ |
| Subsystem doc `docs/subsystems/guards.md` | ✓ |
| `features.yaml` `guards` section | ✓ |

## v1 scope — what's deferred

| Feature | Deferred | Why |
|---|---|---|
| Per-field amendment (amend only specific frozen fields) | v2 | Requires field-level amendment context threading |
| Time-limited amendment windows (`unlockForAmendment` + expiry) | v2 | Separate UX flow; pairs with session-tiers work |
| Guard on `loadAll` / `saveAll` (bulk store ops) | v2 | Uncommon path; validate single-record case first |
| Cross-vault guards | v3 | Requires cross-vault plaintext access; security design needed |
| Guard DAG (guard whose check reads a derived collection) | v3 | Compose carefully with derivation cycles |

## Architecture

### Layers

```
┌───────────────────────────────────────────────────────┐
│ Application                                            │
│   vault.collection('disbursements').put(record)        │
└──────────────────────┬────────────────────────────────┘
                       ▼
┌───────────────────────────────────────────────────────┐
│ Collection.put — existing entrypoint                   │
│   1. Permission check                  (existing)      │
│   2. GuardRegistry.check()          ← NEW              │
│        ├─ amendment context? check role immediately    │
│        ├─ normal: run check() → RecordLockedError      │
│        └─ normal: diff frozenFields → FieldFrozenError │
│   3. Encrypt + store.put               (existing)      │
│   4. DerivationRegistry.onSourceWrite  (dim14)         │
└───────────────────────────────────────────────────────┘
                       ▼
┌───────────────────────────────────────────────────────┐
│ GuardRegistry — vault-internal singleton               │
│   - Holds guard graph (collection → GuardStrategy[])  │
│   - check(): dispatch per-collection guards            │
│   - collectChanges(): accumulate amendment change-set  │
│   - runInvariants(): called at transaction commit      │
└───────────────────────────────────────────────────────┘
                       ▼
┌───────────────────────────────────────────────────────┐
│ GuardExecutor                                          │
│   - Runs check(incoming, ctx)                         │
│   - Diffs frozen fields (existing vs incoming)        │
│   - Collects {before, after} pairs for invariant      │
│   - Writes AmendmentAuditEntry to ledger on commit    │
└───────────────────────────────────────────────────────┘
```

### Key invariants

- **Zero-knowledge preserved.** Guard functions run after DEK unwrap, on plaintext. The store
  only ever sees the encrypted envelope. The read-only vault facade used inside `check` also
  decrypts on access — no plaintext leaks to the store layer.
- **No new wire format.** Guards are pure runtime enforcement; they write nothing to the store
  except the `AmendmentAuditEntry` on successful amendment commits.
- **Amendment bypasses lock, not invariant.** The invariant is a business rule, not a permission
  check. An admin who violates the invariant gets `InvariantError` + rollback, same as any other
  constraint failure.
- **Fail fast on role.** Role check is at transaction open, not at commit. Expensive writes are
  never attempted for unauthorized callers.

## Type surface

```ts
// --- Registration ---

interface GuardStrategy<T extends Record<string, unknown>> {
  /** Collection this guard applies to. */
  collection: string

  /**
   * Cross-collection lock. Called on every put() / delete() for this collection.
   * Throw any error to block the write. ctx.existing is null on insert.
   * Amendment mode skips this check (uses invariant instead).
   */
  check?: (incoming: T, ctx: GuardContext<T>) => Promise<void> | void

  /**
   * Field-level freeze. When existing[when(existing)] is true, any attempt
   * to change a field listed in `fields` throws FieldFrozenError.
   * Amendment mode also skips this check.
   */
  frozenFields?: {
    when: (existing: T) => boolean
    fields: ReadonlyArray<keyof T>
  }

  /**
   * Amendment gate. Only active inside withTransactions({ amendment: true }).
   * Role check happens at transaction open. Invariant runs at commit over
   * ALL records touched in the transaction for this collection.
   */
  amendment?: {
    roles: ReadonlyArray<'admin' | 'owner'>
    invariant: (
      changes: ReadonlyArray<{ before: T | null; after: T }>,
      ctx: GuardContext<T>,
    ) => Promise<void> | void
  }
}

interface GuardContext<T> {
  /** Current persisted record. Null on insert. */
  existing: T | null
  /** Read-only facade — can get/list other collections, no writes. */
  vault: ReadOnlyVaultFacade
  /** Authenticated user id. */
  userId: string
  /** Authenticated user role. */
  role: Role
}

interface ReadOnlyVaultFacade {
  collection<T = unknown>(name: string): {
    get(id: string): Promise<T | null>
    list(): Promise<T[]>
  }
}

// Factory — returns a strategy handle for vault.use()
declare function withGuard<T extends Record<string, unknown>>(
  strategy: GuardStrategy<T>,
): GuardStrategyHandle

// --- withTransactions amendment extension ---

interface TransactionOptions {
  amendment?: true
  reason?: string   // required when amendment: true; ValidationError thrown at open if absent
}

// Overloads (the second enforces reason at the type level):
// vault.withTransactions(fn)                                  — normal
// vault.withTransactions({ amendment: true, reason }, fn)    — amendment

// Vault.withTransactions gains a new overload:
// vault.withTransactions({ amendment: true, reason: string }, async tx => { ... })
```

## Error types

```ts
class RecordLockedError extends NoydbError {
  code = 'RECORD_LOCKED'
  constructor(
    public readonly collection: string,
    public readonly id: string,
    public readonly reason: string,  // human-readable, from check() throw message
  ) { ... }
}

class FieldFrozenError extends NoydbError {
  code = 'FIELD_FROZEN'
  constructor(
    public readonly collection: string,
    public readonly id: string,
    public readonly fields: string[],  // list of fields that were changed
  ) { ... }
}

class InvariantError extends NoydbError {
  code = 'INVARIANT_VIOLATED'
  constructor(public readonly message: string) { ... }
}

class AmendmentForbiddenError extends NoydbError {
  code = 'AMENDMENT_FORBIDDEN'
  constructor(
    public readonly userId: string,
    public readonly role: string,
  ) { ... }
}
```

## Amendment audit entry

Written to the existing hash-chained ledger on every successful amendment commit.
The `'amendment'` op slots into the existing `LedgerEntry` discriminated union.

```ts
interface AmendmentLedgerEntry {
  op: 'amendment'
  actor: string                          // userId
  role: 'admin' | 'owner'
  reason: string
  changes: ReadonlyArray<{
    collection: string
    id: string
    vBefore: number                      // _v of record before amendment
    vAfter: number                       // _v after
  }>
  invariantsPassed: ReadonlyArray<string> // guard collection names whose invariants ran
  ts: string                             // ISO timestamp
}
```

## Example — accounting registration

```ts
import { withGuard } from '@noy-db/hub'

vault.use(withGuard<Disbursement>({
  collection: 'disbursements',

  // Cross-collection lock: disbursements are locked when their invoice is issued
  check: async (incoming, { vault }) => {
    const inv = await vault.collection<Invoice>('invoices').get(incoming.invoiceId)
    if (inv?.status === 'issued')
      throw new RecordLockedError('disbursements', incoming.id, 'invoice is issued')
  },

  // Amendment gate: admin/owner can amend, but only if total is preserved
  amendment: {
    roles: ['admin', 'owner'],
    invariant: (changes) => {
      const total = (side: 'before' | 'after') =>
        changes.reduce((sum, c) => sum + ((c[side]?.amount) ?? 0), 0)
      if (total('before') !== total('after'))
        throw new InvariantError('disbursement total must be preserved across amendment')
    },
  },
}))

vault.use(withGuard<Invoice>({
  collection: 'invoices',

  // Field-level freeze: once issued, financial fields can't change
  frozenFields: {
    when: (existing) => existing.status === 'issued',
    fields: ['total', 'netAmount', 'vatAmount', 'lineItems'],
  },
}))

// Normal write — throws RecordLockedError
await disbursements.put('d1', { ...d1, amount: 999 })

// Amendment — commits atomically + audit entry if invariant holds
await vault.withTransactions({ amendment: true, reason: 'correct split per client request' }, async tx => {
  await tx.collection('disbursements').put('d1', { ...d1, amount: 800 })
  await tx.collection('disbursements').put('d2', { ...d2, amount: 200 })
})
```

## Components

### New components

| Component | File | Responsibility |
|---|---|---|
| `withGuard()` factory | `packages/hub/src/guards/with-guard.ts` | API surface; returns `GuardStrategyHandle` |
| `GuardRegistry` | `packages/hub/src/guards/registry.ts` | Guard graph; per-collection dispatch; amendment change-set accumulation |
| `GuardExecutor` | `packages/hub/src/guards/executor.ts` | Run `check`, diff frozen fields, collect `{before,after}` pairs, capture failures |
| Error types (4 new) | `packages/hub/src/errors.ts` (extend) | `RecordLockedError`, `FieldFrozenError`, `InvariantError`, `AmendmentForbiddenError` |
| `AmendmentLedgerEntry` | `packages/hub/src/history/ledger/index.ts` (extend) | New `'amendment'` op in `LedgerEntry` union; audit write on commit |
| Subsystem doc | `docs/subsystems/guards.md` | Reader-facing doc + zero-knowledge boundary + amendment flow |
| Showcase | `showcases/src/79-with-guard.showcase.test.ts` | End-to-end accounting scenario |
| `features.yaml` entry | `features.yaml` | New `guards` section |

### Modified components

| Component | Change |
|---|---|
| `Collection.put` | Insert `GuardRegistry.check()` after permission check, before encrypt |
| `Collection.delete` | Same — locked records can't be deleted either |
| `withTransactions` | Accept `{ amendment, reason }` options; role check at open; `GuardRegistry.runInvariants()` at commit; audit write on success |
| `Vault` initialisation | Register guard strategies on open |

## Data flow

### Normal locked write (blocked)

```
Caller: disbursements.put('d1', { ..., amount: 999 })
  │
  ▼
Collection.put
  ├─ permission check → passes (user has write permission on disbursements)
  ├─ GuardRegistry.check('disbursements', 'd1', incoming)
  │    └─ GuardExecutor.runCheck(strategy, incoming, ctx)
  │         └─ check(incoming, ctx) fetches invoice → status === 'issued'
  │              → throws RecordLockedError ← write aborted here
  └─ (encrypt + store.put never reached)
```

### Amendment (commits with audit)

```
Caller: vault.withTransactions({ amendment: true, reason: '...' }, async tx => {
  tx.collection('disbursements').put('d1', ...)
  tx.collection('disbursements').put('d2', ...)
})
  │
  ├─ Role check → role === 'admin' → passes
  │
  ├─ tx.collection('disbursements').put('d1', ...)
  │    Collection.put
  │      ├─ GuardRegistry.check() → SKIPPED (amendment context active)
  │      ├─ GuardRegistry.collectChange('disbursements', { before: d1_old, after: d1_new })
  │      └─ encrypt + store.put (tentative — inside transaction)
  │
  ├─ tx.collection('disbursements').put('d2', ...)  [same path]
  │
  ├─ COMMIT
  │    ├─ GuardRegistry.runInvariants(changeSet)
  │    │    └─ disbursements guard invariant: sum(before) === sum(after) → passes
  │    ├─ ledger.append(AmendmentLedgerEntry)
  │    └─ transaction commit (both puts become permanent)
  │
  └─ Returns void
```

### Amendment invariant failure (full rollback)

```
  ...same as above up to COMMIT...
  ├─ COMMIT
  │    ├─ GuardRegistry.runInvariants(changeSet)
  │    │    └─ disbursements guard invariant: sum(before) ≠ sum(after) → throws InvariantError
  │    └─ withTransactions revert pass (same as any tx failure) → both puts rolled back
  └─ throws InvariantError to caller
```

## Error handling

| Failure | Behavior |
|---|---|
| `check()` throws | Write aborted; error propagated to caller |
| Frozen field diff fails | `FieldFrozenError` thrown; write aborted |
| Amendment with wrong role | `AmendmentForbiddenError` at transaction open; no writes attempted |
| Invariant fails at commit | `InvariantError`; full transaction rollback via existing revert pass |
| `check()` throws inside amendment | Should not happen (check is skipped in amendment mode); if it does (guard bug), treated as invariant failure |
| Ledger write fails after commit | Logged as internal error; commit is NOT rolled back (store is source of truth) |

## Testing strategy

### Showcase (`79-with-guard.showcase.test.ts`)

| Scenario | Expected |
|---|---|
| Normal write to unlocked disbursement | Succeeds |
| Normal write to locked disbursement (invoice issued) | `RecordLockedError` |
| Delete locked disbursement | `RecordLockedError` |
| Edit frozen field on issued invoice | `FieldFrozenError` |
| Edit non-frozen field on issued invoice | Succeeds |
| Viewer attempts amendment | `AmendmentForbiddenError` |
| Admin amendment, invariant passes | Commits; `AmendmentLedgerEntry` in `vault.history()` |
| Admin amendment, invariant fails | `InvariantError`; both records rolled back |
| `withTransactions({ amendment: true })` missing `reason` | `ValidationError` |

### Unit tests (`packages/hub/__tests__/guards/`)

- `GuardRegistry` — strategy registration; multiple guards same collection; dispatch order
- `GuardExecutor` — frozen field diff (changed field, unchanged field, field added, field removed)
- Amendment change-set accumulation across multiple puts in one transaction
- Invariant runner receives correct `{before, after}` pairs
- `AmendmentLedgerEntry` serialization round-trip

### Security tests

- Guard check runs on plaintext (not envelope); store-side ciphertext cannot reveal lock state
- Amendment audit entry appears in `vault.history()` with full `changes` list
- Non-admin cannot construct an `amendment: true` transaction by any means (role check is non-bypassable)

## Relationship to dim14 (derivation)

Guards and derivations compose cleanly at the `Collection.put` level:

```
Collection.put
  1. Permission check
  2. GuardRegistry.check()       ← guards (this spec)
  3. Encrypt + store.put
  4. DerivationRegistry.onSourceWrite  ← derivations (dim14)
```

Guard runs before encrypt; derivation runs after store write. A guard can block a write that
would otherwise trigger a derivation — the derivation never fires if the guard throws.

In amendment mode, derivations still fire on successfully committed writes. The invariant check
happens at commit (step between store.put and derivation dispatch for the batch), so the invariant
sees the pre-derivation state.
