# Dimension 11 (hub core / query DSL) — cross-join v1 design

> Extends the query DSL with **cross-join** semantics. Driven primarily by Dim 14 v2's deferred SSO-style use cases (the MV v2 spec — [`2026-05-20-dim14-mv-v2-design.md`](./2026-05-20-dim14-mv-v2-design.md) — defers cross-product to v3), but landing as a general-purpose query primitive: any query consumer can use `.crossJoin()`, not just MVs.

## Goal

Ship a `.crossJoin(targetCollection, { as })` terminal on the `Query<T>` builder so consumers can express **cartesian-product** relations between two collections. Combined with `.wherePredicate(name, ctx?)` (shipped in MV v2), this lets queries express "every left × every right" plus filter — the structural shape SQL `CROSS JOIN ... WHERE` and the niwat `DERIV-SSO-001` rule both need.

## Success criteria (acceptance)

- A query can declare `.crossJoin('rightCollection', { as: 'alias' })` and receive each row of the result with `row.alias` populated from every row of the right collection.
- Multi-step cross-joins compose: `.crossJoin('A', { as: 'a' }).crossJoin('B', { as: 'b' })` produces an L × A × B product.
- `.wherePredicate(name, ctx?)` operates on the cross-joined row (its own fields *and* every joined alias) — closes the DERIV-SSO-001 path.
- Cost ceiling enforced: `CrossJoinTooLargeError` fires when the resulting row count exceeds a configurable limit (default conservative — see § Cost ceiling).
- Query plan + cycle detection extend cleanly: `QueryDependencyAnalyzer` treats cross-joined collections as dependency sources for MV refresh.
- Same DEK semantics as FK joins: read happens after DEK unwrap, on plaintext.
- Conformance tests pass on `to-memory` and `to-file`.

## v3 SCOPE — what's in

| Feature | In v3 | Notes |
|---|:---:|---|
| `.crossJoin(name, { as })` builder terminal | ✓ | Cartesian product against a vault collection by name |
| Multi-step chains (`L × A × B`) | ✓ | Naturally composable; cost ceiling applies to the cumulative product |
| Composition with `.where()` / `.wherePredicate()` on the joined row | ✓ | Where-clauses + declared predicates see all aliases |
| Composition with `.groupBy()` and `.aggregate()` | ✓ | The cross-join feeds the group-by relation as-is |
| Composition with FK `.join(field, { as })` | ✓ | Order independent: cross-join + FK-join in the same query |
| Cost ceiling: `CrossJoinTooLargeError` at `max(50k, leftRows × rightRows)` cumulative cap | ✓ | Same shape as `JoinTooLargeError` / `MaterializedViewTooLargeError` |
| `QueryDependencyAnalyzer` extension — cross-joined collections in dep set | ✓ | MV refreshes correctly when EITHER side writes |
| Lateral cross-join (right side parameterized by left row) | ✓ | `.crossJoin('right', { as, on: (leftRow) => leftSubset })` — restricted form, see § Lateral form |
| Subsystem doc (`docs/subsystems/query-dsl.md`) — new § Cross-join | ✓ | Reader-facing |
| Showcase under `showcases/src/` | ✓ | DERIV-SSO-001 shape end-to-end |

## v3 SCOPE — what's deferred

| Feature | Deferred to | Why |
|---|---|---|
| `.leftJoin` / `.rightJoin` / `.fullOuterJoin` semantics with NULLs | v3.x or later | Different shape — NULLs in result rows propagate through every downstream operator (`.where`, `.aggregate`); needs a coherent null-handling story across the DSL |
| Anti-join (`.where NOT EXISTS`) | v3.x | Sibling primitive; expressible today as `.crossJoin + .where + .groupBy + count() === 0` but ugly. Dedicated terminal can wait. |
| Self cross-join with the SAME alias on both sides | v3.x | Naming collision; requires a `.crossJoinWith({ leftAs, rightAs })` variant. Rare. |
| Cross-join over `withMaterializedView` virtual collections | v3.x | Layering question — `OverlayResolver` from MV v2 has to expand cross-join right-hand-sides through to underlying base + overlay collections. Solvable but cross-cutting; defer until MV v2 stabilizes. |
| Cross-join cost-based query planner (reorder for smaller intermediate) | v3.x or later | v3 always evaluates left-to-right as declared; consumer responsibility to put the smaller side first |
| Index-aware cross-join (skip cartesian when the predicate is field-equality) | v4 | When `.crossJoin('R').where('L.x', '==', 'R.y')` is really a hash-join in disguise, the executor should detect and downgrade. Optimisation, not correctness. |
| Cross-join in streaming MV (Dim 12 sources) | v4 | Streaming joins are a separate primitive territory |

## Architecture

### Where it sits

```
┌──────────────────────────────────────────────────────────┐
│ Application                                              │
│   periods.query()                                        │
│     .crossJoin('workers', { as: 'worker' })              │
│     .wherePredicate('activeInPeriod')                    │
│     .groupBy('id').aggregate({ workerCount: count() })   │
└─────────────────────────┬────────────────────────────────┘
                          ▼
┌──────────────────────────────────────────────────────────┐
│ QueryBuilder.crossJoin — NEW terminal                    │
│   Appends a CrossJoinClause to QueryPlan.clauses         │
└─────────────────────────┬────────────────────────────────┘
                          ▼
┌──────────────────────────────────────────────────────────┐
│ executePlan (modified)                                   │
│   When evaluating clauses, on encountering a CrossJoin:  │
│   1. Fetch right-side snapshot (or lateral subset)       │
│   2. Expand current intermediate × right                 │
│   3. Cost-ceiling check                                  │
│   4. Continue with cartesian-expanded relation           │
└──────────────────────────────────────────────────────────┘
```

### Modified vs new components

| Component | File | Change |
|---|---|---|
| `CrossJoinClause` type | `packages/hub/src/query/predicate.ts` (modify) | New clause variant in the `Clause` union |
| `QueryBuilder.crossJoin()` | `packages/hub/src/query/builder.ts` (modify) | New chainable terminal |
| `executePlan` cross-join branch | `packages/hub/src/query/builder.ts` (modify) | Cartesian expansion at the right point in the clause-loop |
| `CrossJoinTooLargeError` | `packages/hub/src/errors.ts` (modify) | New error class |
| `QueryDependencyAnalyzer` extension | `packages/hub/src/materialized-views/dependency-analyzer.ts` (modify; from MV v2) | Cross-joined collections added to dependency set |
| Subsystem doc | `docs/subsystems/query-dsl.md` (extend) | New § Cross-join |
| Showcase | `showcases/src/86-cross-join-sso.showcase.test.ts` | DERIV-SSO-001 end-to-end |

## Key invariants

- **Zero-knowledge preserved.** The right-hand collection is read after DEK unwrap, on plaintext. The cross-join expansion happens inside the encrypted boundary, identical to FK joins.
- **No new wire format.** Cross-join is a query-time operation; nothing is persisted by the primitive itself. (MVs built atop cross-join still persist their results via the standard `_materializedFrom` envelope.)
- **No new store interface.** The right-side fetch uses the same `Collection.list()` / cached snapshot path FK joins use.
- **Determinism preserved.** `queryHash` in MVs folds the cross-join target collection name + alias. Switching from `.crossJoin('A', { as: 'x' })` to `.crossJoin('B', { as: 'x' })` changes the hash → forces refresh.
- **Cost ceiling is honest.** No silent magic — the ceiling is the product of left-rows × right-rows (or, for chained cross-joins, the cumulative product). Throws before allocating the expanded relation.

## Type surface

```ts
// New clause variant in the existing union
type Clause =
  | FieldClause          // .where(field, op, value)
  | GroupClause          // .or(...)
  | JoinClause           // .join(field, { as }) — existing FK
  | CrossJoinClause      // NEW
  | GroupByClause        // .groupBy(field)
  | AggregateClause      // .aggregate({ ... })

interface CrossJoinClause {
  type: 'crossJoin'
  /**
   * Target collection name. Must be a vault-known collection at MV
   * registration time (or query-execution time for ad-hoc queries).
   */
  target: string
  /**
   * Alias under which the right-side row is exposed on each result
   * row: `result.<as>` carries the entire right-side record.
   */
  as: string
  /**
   * Optional lateral filter — when supplied, the right-side rows are
   * filtered per-left-row by the returned subset/predicate. See §
   * Lateral form. Omit for full cartesian product.
   */
  on?: (leftRow: unknown) => unknown[] | ((rightRow: unknown) => boolean)
  /**
   * Per-clause cost ceiling override. Default is the query-wide
   * `crossJoinMaxRows` (or the package default — see § Cost ceiling).
   */
  maxRows?: number
}

// Added to QueryBuilder<T> (type-only here; the implementation extends
// the chainable builder in packages/hub/src/query/builder.ts)
interface QueryBuilder<T> {
  /**
   * Cartesian product against `target` collection. Each row of the
   * result carries the original `T` fields plus `[as]: TargetRow`.
   *
   * Cost ceiling applies — `CrossJoinTooLargeError` fires before
   * materialization if the product would exceed it.
   */
  crossJoin<TTarget = unknown, TAs extends string = string>(
    target: string,
    options: { as: TAs; on?: (left: T) => TTarget[] | ((right: TTarget) => boolean); maxRows?: number },
  ): QueryBuilder<T & { [K in TAs]: TTarget }>
}
```

## Cost ceiling

Cartesian explosion is the textbook "query goes bad" failure. v3 sets a conservative default:

- **Default cap:** the smaller of `50_000` (matches `JoinTooLargeError`) or `leftRows × rightRows` evaluated at fetch time. The check fires **before** the expanded relation is materialized — no allocation past the limit.
- **Per-clause override:** `crossJoin(target, { as, maxRows: 200_000 })`. Use when the domain warrants it (e.g. small `periods` × medium `workers` at niwat's 30 × ~10 ≈ 300 rows, comfortable under any default).
- **Chained cross-joins:** the cap applies to the **cumulative** product, not the per-step product. `.crossJoin('A', ...).crossJoin('B', ...)` is `L × A × B`; the ceiling sees the running total at each step.
- **Lateral form:** the `on:` filter is applied during expansion. The cost ceiling sees the *post-filter* count, so `.crossJoin('workers', { on: (period) => activeWorkers(period) })` charges only the filtered cross-product.

`CrossJoinTooLargeError(target, expected, limit)` carries the would-be row count and the configured limit. Surfaces at the executor; rolls back transactions the same way `JoinTooLargeError` does.

## Lateral form

Standard SQL `LATERAL JOIN`: the right side's row set depends on the current left row. v3 ships a restricted form via the optional `on:` callback:

```ts
periods.query()
  .crossJoin('workers', {
    as: 'worker',
    on: (period) => (worker) =>
      worker.employmentPeriods.some(p =>
        p.start <= period.start && (p.end === null || p.end >= period.end)),
  })
  .groupBy('id')  // period.id
  .aggregate({ workerCount: count() })
```

Two callback shapes accepted:

- **Subset:** `on: (left) => TTarget[]` — the consumer returns the exact right-side rows that should pair with `left`. Most efficient when the consumer has an index or pre-computed set.
- **Predicate:** `on: (left) => (right) => boolean` — the executor materializes `left × right` then filters. Convenient; pays full cartesian cost (still bounded by ceiling).

The lateral form is **not equivalent** to `.crossJoin + .wherePredicate` because:

- The lateral filter has access to `left` at the callback construction site (closure), avoiding the need to pass it through `ctx`.
- The lateral filter can return a subset directly (`TTarget[]`), enabling index-aware paths.
- The cost ceiling charges the post-filter count, not the pre-filter cartesian.

`.wherePredicate` remains the right choice for filters that look across the whole joined row using a registered/hashed predicate (so MV `queryHash` tracks function changes). Use `on:` for filters that are inherent to the join itself.

### Determinism of `on:`

`on:` callbacks have the same `queryHash` concern as raw predicates: function bodies aren't canonically serializable. For MV use, **the `on:` callback must be paired with a declared predicate name in the MV's `predicates` map**:

```ts
withMaterializedView({
  predicates: {
    activeInPeriod: { hash: 'active-in-period-v1', fn: ... },
  },
  query: () => periods.query()
    .crossJoin('workers', {
      as: 'worker',
      on: { predicate: 'activeInPeriod' },  // refers to predicates map
    })
    ...
})
```

The `on: { predicate: name }` shape is the MV-compatible declaration; the inline `on: (left) => ...` callback shape works for ad-hoc queries (no MV / no hash tracking). Both shapes share the cost ceiling and the lateral-execution path.

## Composition

### With `.where` and `.wherePredicate`

The result row of a cross-join carries both `T` fields and `result[as]` from the joined relation. Where-clauses see all of it:

```ts
.crossJoin('users', { as: 'u' }).where('u.role', '==', 'admin')
```

The dotted-path is the existing convention from FK `.join()` — same access semantics. `.wherePredicate(name)` likewise sees the merged row.

### With `.groupBy` and `.aggregate`

After cross-join, the relation has shape `T & { [as]: TTarget }`. `.groupBy(field)` accepts any path:

```ts
.crossJoin('periods', { as: 'p' }).groupBy('p.id').aggregate({ workers: count() })
```

### With FK `.join`

Order-independent. Both shapes coexist:

```ts
invoices.query()
  .join('clientId', { as: 'client' })           // FK join — invoice's clientId → clients
  .crossJoin('reportingPeriods', { as: 'p' })   // every invoice × every reporting period
  .where('p.year', '==', 2026)
  .groupBy('p.month').aggregate({ total: sum('amount') })
```

## Cycle detection + MV dependency analysis

MV v2's `QueryDependencyAnalyzer` already walks the clause list and adds FK-join targets to the dependency set. Extension for cross-join is symmetric:

```ts
function analyzeDependencies(plan, joinContext, overlayResolver) {
  // ... existing code for root + joins + groups ...
  for (const clause of plan.clauses) {
    if (clause.type === 'join') {
      // existing FK path
    } else if (clause.type === 'crossJoin') {
      // NEW: cross-join target is a dependency source
      expand(clause.target, deps, overlayResolver)
    }
    // ...
  }
}
```

Both sides of the cross-join are MV dependency sources — writes to either trigger refresh. Same shallow-expansion-through-overlays semantics as the v2 spec.

Cycle detection: no new edge type. `crossJoin('R')` adds `R → MV-name` to the graph the same way an FK-join would. The shared `DerivationRegistry` DFS handles it.

## Execution model

```
executePlan walks clauses in declared order. State during walk:
  rel: the current relation (initially a snapshot of the root collection)

On each clause:
  .where           — filter rel
  .or              — group-or filter rel
  .join            — extend each row with FK-joined alias
  .crossJoin       — for each row r in rel, for each right row r':
                     emit { ...r, [as]: r' } if on: passes (or always)
                     CHECK ceiling: |rel| × |right|.post-filter
  .groupBy         — collapse rel by group key
  .aggregate       — produce final result from groups (or whole rel)
```

The cross-join step replaces `rel` with the expanded relation. For chained cross-joins each step charges against the cumulative ceiling.

## Error handling

| Failure | Behavior |
|---|---|
| `target` collection unknown at query construction time | Throw `CrossJoinSourceUnknownError` (the analyzer surfaces this at MV registration; ad-hoc queries surface at first execution) |
| Expanded relation exceeds ceiling | Throw `CrossJoinTooLargeError(target, expected, limit)` before allocating; rolls back transactions |
| `on:` callback throws | Treat as a user-supplied filter throw — propagate normally (matches `.where` predicate-throw behavior) |
| MV uses `on: (left) => ...` inline callback instead of `on: { predicate: name }` | `queryHash` cannot include the function; warn at registration that drift detection is disabled for this MV. Ad-hoc queries are unaffected. |
| Cross-join chained with a collection that doesn't exist on `to-file` (lazy) | The lazy-fetch path triggers materialization; cost ceiling check happens after fetch resolves |

## Testing strategy

### Unit tests

- `QueryBuilder.crossJoin` — basic chainability; multi-step cross-joins; type-flow through `as` aliases
- `executePlan` cross-join — pure cartesian product; lateral form (subset and predicate variants); cost ceiling enforcement before allocation
- `QueryDependencyAnalyzer` extension — cross-joined collections appear in MV dependency sets
- `_materializedFrom` queryHash — folds cross-join target + alias; bump fires refresh
- Conformance suite — passes on `to-memory` and `to-file`

### Integration tests

- DERIV-SSO-001 showcase — `periods.crossJoin('workers', { as, on: predicate-by-name }).groupBy('id').aggregate({ workerCount: count() })`; verifies the niwat-rulebook path in pre-15 (assuming v3 ships with v2)
- Cost ceiling — chained cross-joins where the cumulative product exceeds the cap; assert the executor errors before allocating
- Lateral form vs `.wherePredicate` — both produce the same result for the same logical filter; performance is observably better for `on:` (count comparisons)
- Composition with FK-join + cross-join + `.where` — invoices × clients × periods, filtered on `period.year`; result correctness

### Security tests

- Right-side records are decrypted only after the cross-join clause fires; never appear as ciphertext in the result
- Right-side DEK is the same shape as FK-join right-side (same-DEK by default)
- Cross-join over a public-MV doesn't leak source-collection DEKs (v3 reaffirms what's already true for FK joins)

## Backward compatibility

- Existing queries without `.crossJoin()` are unaffected (no new mandatory parameter on any existing API)
- MV v2 `query()` callbacks compile unchanged; consumers opt in by adding the `.crossJoin()` terminal
- Adding `crossJoin` to `Clause` union is type-additive only — no runtime change for code paths that don't construct a `CrossJoinClause`

## Open implementation questions (resolve during writing-plans)

1. **Snapshot semantics for the right side.** FK joins use the same snapshot the left query uses (cache-of-cache). Should cross-join right-side be a one-shot snapshot at execution time, or a fresh fetch? Eager-MV refreshes happen inside the source-write transaction, so a snapshot-time fetch is consistent. Confirm with implementation.
2. **Cost ceiling default.** `50_000` matches `JoinTooLargeError`. But cross-joins explode multiplicatively faster than FK joins — `1000 × 1000 = 1M` is already 20× the cap. Recommend keeping the conservative default; document that consumers expecting large products must override per-clause.
3. **Streaming / chunked execution.** v3 always materializes the expanded relation in-memory. Pairs poorly with very large products; v4 might add streaming evaluation (process row-by-row through downstream clauses). Out of scope for v3.
4. **Lateral `on:` callback closure-over-`ctx`.** For MV use, the `on: { predicate: name }` shape must thread the left row to the predicate. Confirm the threading mechanism — does the executor pass the left row as the predicate's first argument? As a field in `ctx`?
5. **Type-inference depth.** TypeScript may struggle with deeply-chained cross-joins extending the row type 4–5 levels. Document a recommended limit; recommend `interface` extraction for >2 chains.

## Cross-references

- MV v2 spec ([`2026-05-20-dim14-mv-v2-design.md`](./2026-05-20-dim14-mv-v2-design.md)) — defers cross-product to v3; this spec closes that gap
- v2 ships `declaredDeterministicPredicates` + `withOverlayedView`; this spec composes with both
- DERIV-SSO-001 from the niwat enforcement plan — the load-bearing example
- Query DSL home: `packages/hub/src/query/` (`builder.ts`, `predicate.ts`, `join.ts`)
- Existing `JoinTooLargeError` / `GroupCardinalityError` / `MaterializedViewTooLargeError` family — `CrossJoinTooLargeError` is the next member

## Sequencing for implementation

1. **`CrossJoinClause` type + clause-union extension** (no execution yet) — smallest first piece
2. **`QueryBuilder.crossJoin()` terminal** — chainable, type-flow through `as` alias
3. **`executePlan` cross-join branch** — pure cartesian product; cost ceiling check before allocation
4. **`CrossJoinTooLargeError`** — error class + executor surfacing
5. **Lateral `on:` subset and predicate variants** — both branches of the callback union
6. **`QueryDependencyAnalyzer` extension** — cross-joined collections added to MV dependency sets
7. **`queryHash` extension** — fold cross-join target + alias + `on: { predicate: name }` ref into the canonical form
8. **`.where` / `.wherePredicate` dotted-path access on joined alias** — confirms the existing FK-join dotted-path code works unchanged
9. **`.groupBy` / `.aggregate` on cross-joined rows** — confirms group-by sees the merged row shape
10. **Showcase — DERIV-SSO-001 end-to-end** — periods × workers + predicate + group-by + aggregate
11. **Subsystem doc + `features.yaml` entry** — documentation and verification

Each step produces a green test before the next begins.
