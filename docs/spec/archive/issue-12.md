# Issue #12 — Reactive query DSL in @noy-db/core

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-06
- **Closed:** 2026-04-06
- **Milestone:** v0.3.0
- **Labels:** type: feature, release: v0.3, area: core

---

# Reactive query DSL in `@noy-db/core`

Part of #6 (v0.3 release).

## Scope

Add a chainable, reactive query DSL to `@noy-db/core` exposed via `collection.query()`. Supports operators `==`, `!=`, `<`, `<=`, `>`, `>=`, `in`, `contains`, `startsWith`, `between`, plus an escape hatch `.filter(fn)`. Composition via `.and()` / `.or()`. Ordering via `.orderBy(field, 'asc' | 'desc')`. Live mode via `.live()` returning a reactive subscription. Pagination via `.limit()` / `.offset()` (or via #8). All filtering happens client-side after decryption — preserves zero-knowledge.

## Why

Without a query layer, every consumer rewrites `Array.filter` and `Array.find`. The Pinia store (#4) needs `query()` to be ergonomic for components. The query DSL is the foundation of the v0.3 power surface.

## Technical design

- New module `packages/core/src/query/`:
  - `predicate.ts` — operator implementations against decrypted plain objects.
  - `builder.ts` — chainable builder returning an immutable query plan object.
  - `executor.ts` — runs the plan against the in-memory record array; uses indexes (#7) when available.
  - `live.ts` — wraps the executor in an `EventTarget`-based subscription that re-runs on collection mutations.
- API shape (from ROADMAP.md "6–9. Power features"):
  ```ts
  collection.query()
    .where('status', '==', 'open')
    .orderBy('dueDate')
    .live();
  ```
- `.and()` / `.or()` accept either nested builder callbacks or query plan objects.
- `.live()` returns `{ value: Ref<T[]>, stop(): void }` and is consumed by `defineNoydbStore` to power its `query()` method.
- Plans are serializable (JSON) so devtools can render them.
- Index-aware: when an index from #7 covers the leading `where` clause, the executor short-circuits to a hash/range lookup. Without an index it falls back to a linear scan.
- Tree-shakeable. Importing `Collection` without calling `.query()` must not pull in the executor.

## Acceptance criteria

- [ ] **Implementation:** `packages/core/src/query/` exported via the package's existing barrel; `collection.query()` returns a builder.
- [ ] **Unit tests:** at least 25 `it()` blocks across `predicate.test.ts`, `builder.test.ts`, `executor.test.ts`, `live.test.ts`. Cover: each operator with type-correct values, each operator with type-mismatched values (rejected), `in` with array operand, `between` with inclusive bounds, `contains` on strings and arrays, `.and()` / `.or()` nesting, `orderBy` asc + desc + tiebreak by `_v`, `.filter(fn)` escape hatch, immutability of plans, JSON serialization round-trip, `.live()` re-runs on add/update/remove, `.live().stop()` cleans up listeners, executor uses index when present.
- [ ] **Parity test:** at least one `it()` block that generates 50 random predicates and asserts the query result equals `Array.filter` with the equivalent function. (DoD criterion.)
- [ ] **Integration tests:** end-to-end test against `@noy-db/memory` with 1K records exercising every operator.
- [ ] **Type tests:** `expect-type` ensures `where('status', '==', value)` constrains `value` to the schema field type when a schema is provided.
- [ ] **Docs:** new section in `docs/guides/end-user-features.md`; query DSL reference in core README.
- [ ] **Changeset:** minor bump on `@noy-db/core` to `0.3.0`.
- [ ] **CI:** existing core test job; add the parity test as a guarded fast suite.
- [ ] **Bundle:** total core stays under 30 KB gzipped (the DSL adds <5 KB).

## Dependencies

- Blocked by: nothing (can land in parallel with #7)
- Blocks: #4 (the Pinia store re-exports `query()`), #5 (augmentation plugin uses query types)

## Estimate

L

## Labels

`release: v0.3`, `area: core`, `type: feature`
