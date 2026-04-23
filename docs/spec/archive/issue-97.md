# Issue #97 — feat(core): aggregation reducers + .aggregate() terminal + .live() incremental

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-08
- **Closed:** 2026-04-09
- **Milestone:** v0.6.0
- **Labels:** type: feature, area: core

---

## Target package

`@noy-db/core`

## Spawned from

Discussion #65 — Query DSL: aggregations. See the discussion for the full design rationale and the open questions around incremental maintenance.

## Problem

The query DSL today has no reducer primitives. Consumers who want `count`, `sum`, `avg`, `min`, or `max` over a filtered record set have to call `.toArray()` and fold in JS. Costs:

1. **Iteration shape is lost** — folding in userland bypasses any planner optimization the DSL could apply.
2. **Not reactive** — a userland fold has to be wrapped in a Vue/Pinia `computed` and re-run on every change, re-decrypting the full matching set each tick. A DSL-level `.aggregate()` can plug directly into `.live()` and maintain running totals incrementally.

## Scope (v1)

- **Reducer factories** — `count()`, `sum(field)`, `avg(field)`, `min(field)`, `max(field)`. Each returns a reducer descriptor the planner understands.
- **`.aggregate({ ... })` terminal** on `QueryBuilder` — takes a record of named reducers, returns a promise of the reduced shape:
  ```ts
  const { total, n, avg } = await invoices.query()
    .where('status', '==', 'open')
    .aggregate({ total: sum('amount'), n: count(), avg: avg('amount') })
  ```
- **`.aggregate(...).live()`** — returns a reactive ref (matching v0.3 reactive query conventions) that maintains running totals incrementally on change-stream updates.
- **Incremental maintenance:**
  - `sum` / `count` / `avg` → O(1) per add/remove/update delta.
  - `min` / `max` → O(1) add, O(1) non-extremum update, **O(N) worst case** on removal of the current extremum (documented caveat in the DSL docs).
- **Seed parameter (load-bearing — required by #87 constraint #2)** — every reducer factory accepts an optional `{ seed }`:
  ```ts
  sum('amount', { seed: 0 })
  ```
  v0.6 always ignores the seed at execution time. Its presence is required so v0.10 partitioned collections can pass a carry value without an API break. See #87 for rationale.
- **No projection** — field-level projection is not possible today (records are encrypted as a single envelope). `.aggregate()` decrypts the same shape `.toArray()` would. This is iteration-shape optimization + reactivity, not a crypto optimization. Document clearly.

## Out of scope (deferred)

- `groupBy(field)` — tracked separately
- `scan().aggregate()` memory-bounded variant — tracked separately
- Per-row callback reducers `.reduce(fn, init)` — wait for consumer ask
- Index-backed aggregation planner — optional optimization
- Aggregations across joins — v2

## Acceptance

- [ ] `count()`, `sum(field, opts?)`, `avg(field, opts?)`, `min(field, opts?)`, `max(field, opts?)` reducer factories exported from `@noy-db/core`
- [ ] `QueryBuilder.aggregate(reducers)` terminal returning a promise of the reduced record
- [ ] `.aggregate(...).live()` returning a reactive ref that incrementally maintains values from the underlying change stream
- [ ] Every reducer factory accepts `{ seed }` in its options object, plumbed through the reducer protocol (unused at execution in v0.6)
- [ ] Documented O(N) caveat on `min`/`max` extremum removal
- [ ] Tests covering: one-shot `.aggregate()`, `.live()` add/remove/update deltas, the extremum-removal O(N) path, seed parameter plumbing
- [ ] Changeset (`@noy-db/core: minor`)
- [ ] Full turbo pipeline green

## Invariant compliance

- [x] No new runtime crypto dependencies
- [x] Adapters never see plaintext
- [x] Reads do not touch the ledger
- [x] KEK/DEK handling unchanged

## Related

- #87 (v0.6 design-forward partition seams — constraint #2 is load-bearing here)
- Depends-on sibling issue for `groupBy`
- Depends-on sibling issue for `scan().aggregate()`

v0.6.0.
