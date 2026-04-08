---
'@noy-db/core': minor
---

feat(core): Query DSL `.join()` — eager, single-FK, intra-compartment joins (#73)

Chain `.join(field, { as })` on any `Query` built from `collection.query()`
to resolve a `ref()`-declared foreign key into an attached right-side record
under an alias:

```ts
const rows = invoices.query()
  .where('status', '==', 'open')
  .join<'client', Client>('clientId', { as: 'client' })
  .toArray()
// → [{ id, amount, client: { id, name, ... } }, ...]
```

Two planner strategies, auto-selected:
- **nested-loop** — right-side source exposes `lookupById` (the common
  path for Collection targets), O(1) per left row.
- **hash** — materialize the right side into a `Map<id, record>` once,
  probe per left row. Fallback for custom `QuerySource` implementations
  without id-indexed access.

Manual override for test purposes via `{ strategy: 'hash' | 'nested' }`.

Hard row ceiling of 50,000 per side (override with `{ maxRows }`), throws
`JoinTooLargeError` on the tripped side with both row counts. One-shot warning
at 80% of the ceiling on the existing warn channel. Streaming joins over
`scan()` that bypass this ceiling are tracked in #76.

Ref-mode semantics on dangling refs:
- `strict` → throws `DanglingReferenceError` with `field` / `target` / `refId`
- `warn` → attaches `null` + one-shot warning per unique dangling pair
- `cascade` → attaches `null` silently (cascade is a delete-time mode)

Left-side records with `null`/`undefined` FK values are never dangling —
they attach `null` regardless of mode, matching the write-time
`enforceRefsOnPut` policy.

Same-compartment only — cross-compartment correlation goes through
`Noydb.queryAcross` (v0.5 #63), not `.join()`. This is an architectural
invariant, not a limitation we plan to lift.

**New public API:**
- `Query.join<As, R>(field, opts)` — chain method on `Query<T>`
- `JoinTooLargeError` — thrown on row-ceiling overflow
- `DanglingReferenceError` — thrown on strict-mode dangling ref
- `JoinLeg`, `JoinContext`, `JoinableSource`, `JoinStrategy` — types
- `DEFAULT_JOIN_MAX_ROWS`, `applyJoins`, `resetJoinWarnings` — internals
  exported for custom planners and tests

**v0.6 design-forward partition seams (#87 constraint #1):** every
`JoinLeg` carries a `partitionScope` field that is always `'all'` in
v0.6 and never read by the executor. v0.10 partition-aware joins will
start populating it from `where()` predicates on the partition key
without changing the planner's external shape — shipping the seam now
means no API break later.

**Known v0.6 limitations** (tracked separately):
- `.join().live()` merged change-stream reactivity — #74
- `.join().join()` multi-FK chaining — #75
- Streaming join over `scan()` — #76
- Sorting by joined fields — not in scope for v1; post-sort in userland
