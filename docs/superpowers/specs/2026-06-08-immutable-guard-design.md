# immutableGuard — declarative WORM / append-only sugar over guards

**Issue:** #301 (Pilot-3 / i3speedex delegation gap) · **Layer:** Schema/Store · **Cluster:** A.

## Problem

Issued invoices and DDTs must be immutable after issue. Today the pilot hand-rolls this per collection with a `withGuard` that blocks `check`/`onDelete` and declares an `amendment` override — repetitive boilerplate that is easy to get subtly wrong (e.g. forgetting the transition write must still be allowed).

## Goal

A declarative `immutableGuard({ collection, after | appendOnly })` helper that **generates** the WORM guard, reusing the guard subsystem wholesale — `check`/`onDelete` rejection, the ledgered `amendment` admin/owner override, and composition with `periods`/`history`.

## Decision: helper, not a collection flag

#301 sketched a per-collection `collection({ immutable })` flag. Investigation showed the amendment + ledger machinery lives entirely in the guard subsystem, and the guard bus-gate only activates when `guardStrategies` are passed at `createNoydb`. A per-collection flag declared *after* `openVault` would require lazily activating the guard subsystem from a late declaration — surgery on a security-critical write-gating path. The helper form delivers identical behavior with **zero write-path change**: it returns a `GuardStrategyHandle` passed to `createNoydb({ guardStrategies })` like any guard. (The collection-flag ergonomic remains a possible future convenience layered on this tested foundation.)

## API

```ts
immutableGuard<T>({
  collection: string,
  after?: (record: T) => boolean,   // immutable once this holds (on the EXISTING record)
  appendOnly?: boolean,             // shorthand for after: () => true
  amendmentRoles?: ReadonlyArray<'admin' | 'owner'>,  // default ['admin','owner']
}): GuardStrategyHandle<T>
```

`after` and `appendOnly` are mutually exclusive; exactly one is required (else `ValidationError` at construction).

## Behavior

Generates a `withGuard` spec:
- **`check`** (fires on put): blocks the write iff `ctx.existing !== null && isImmutable(ctx.existing)`. Inserts (`existing === null`) are allowed, and so is the *transition* write that first makes the record immutable — because `after` reads the **prior** state. Throws `RecordLockedError`.
- **`onDelete`**: blocks deleting a record for which `isImmutable(existing)` holds. Throws `RecordLockedError`.
- **`amendment`**: `{ roles: amendmentRoles ?? ['admin','owner'], invariant: () => {} }`. Inside `db.transaction({ amendment: true, reason }, …)` the guard `check`/`onDelete` are skipped (sanctioned override) and the change is appended to the ledger by the guard amendment mechanism.

`appendOnly: true` ⇒ `isImmutable = () => true`: a record is immutable from creation, so any post-insert update or delete is blocked.

## `amendmentInvariant` — keep a constraint inviolable under amendment (#349)

By default the generated `amendment.invariant` is an empty allow — the amendment IS the sanctioned, ledgered override. Some collections need a constraint that holds *even under amendment* (e.g. an issued document may be corrected but never deleted, or a cross-record sum must stay balanced through a repair). Rather than dropping back to a hand-rolled `withGuard`, `immutableGuard` now accepts an optional `amendmentInvariant`:

```ts
immutableGuard<Invoice>({
  collection: 'invoices',
  after: (r) => r.status === 'issued',
  amendmentInvariant: (changes, ctx) => {
    for (const c of changes) {
      if (c.before !== null && c.after === null) {
        throw new InvariantError('issued invoices cannot be deleted, even by amendment')
      }
    }
  },
})
```

- **Signature** matches `GuardStrategy.amendment.invariant` exactly: `(changes: ReadonlyArray<GuardChange<T>>, ctx: GuardContext<T>) => Promise<void> | void`.
- **Wiring** — `invariant: amendmentInvariant ?? (() => { /* allow */ })`. **Omitting it preserves the prior empty-allow behavior** (backward-compatible, additive).
- **Errors** — a throw is wrapped by the guard executor into `InvariantError` and reverts the whole amendment (the standard amendment-invariant rollback path); no other call site changes.

## Composition

- **periods / history:** unchanged — `immutableGuard` is an ordinary guard, so it composes with the period-close gate and history exactly as a hand-written guard would.
- **transactions:** the amendment override is the standard guard amendment path (rolls back on invariant failure, ledgers on success).

## Boundaries

- The record `id` for `RecordLockedError` is read from the record's `id` field.
- No new write-path code in `collection.ts`/`vault.ts`/`noydb.ts` — the helper lives in `src/guards/`.

### Deferred

- A per-collection `collection({ immutable })` flag layered on this helper (needs lazy guard-subsystem activation).
- Field-level partial immutability beyond the existing `frozenFields` guard primitive.

## Testing

- Factory validation: neither/both of `after`/`appendOnly` → `ValidationError`.
- `after`: create + update-while-mutable + transition-to-immutable all allowed; update and delete once immutable → `RecordLockedError`.
- Amendment: an owner amendment transaction overrides the lock and persists.
- `appendOnly`: any update/delete after insert → `RecordLockedError`.

## Build sequence

1. `src/guards/immutable-guard.ts` — `immutableGuard()` + `ImmutableGuardConfig`.
2. Export from the guards barrel + main entry.
3. Tests (factory + after + amendment + appendOnly).
4. README + features.yaml entry.
