---
'@noy-db/core': minor
---

feat(core): `.groupBy(field)` + `.groupBy().aggregate()` (#98)

New `Query.groupBy(field)` operator that partitions matching records
into buckets keyed by a field, then terminates with
`.aggregate(spec)` to compute per-bucket reducers:

```ts
const byClient = invoices.query()
  .where('status', '==', 'open')
  .groupBy('clientId')
  .aggregate({ total: sum('amount'), n: count() })
  .run()
// → [ { clientId: 'c1', total: 5250, n: 3 }, … ]
```

Result rows carry the group key under the grouping field name plus
every reducer output from the spec. Buckets are emitted in
first-seen insertion order (JS `Map` preserves it natively);
consumers who want a specific ordering should `.sort()` downstream.

**Cardinality caps:**
- One-shot warning at **10_000 distinct groups** (`GROUPBY_WARN_CARDINALITY`)
- Hard `GroupCardinalityError` at **100_000 distinct groups** (`GROUPBY_MAX_CARDINALITY`)

The hard cap is fixed in v0.6 — grouping on a high-uniqueness field
like `id` or `createdAt` is almost always a query mistake rather
than legitimate use, and a hard error is better than silent OOM.
Consumers hitting the cap see an actionable message naming the
field and observed cardinality with guidance to narrow the query
with `.where()` first. A `{ maxGroups }` override can be added
later without a break if a real consumer asks.

**Null / undefined keys:** records with a missing group field get
their own bucket, separate from records with an explicit `null`
value. `Map`-based partitioning distinguishes the two — consumers
who want them merged should coalesce upstream with `.filter()`.

**Live mode:** `.groupBy().aggregate().live()` returns a
`LiveAggregation<R[]>` that re-runs the full group-and-reduce
pipeline on every source change. Reuses the same reactive primitive
as `.aggregate().live()` (#97) via a new `buildLiveAggregation`
helper exported from `aggregate.ts`. Same error-isolation and
idempotent-stop contract. Per-bucket incremental maintenance is a
future optimization — the reducer protocol's `remove()` hook
admits it but v0.6 ships naive re-grouping for simplicity.

**Joins skipped** in grouped pipelines — same rationale as
`.count()` and `.aggregate()`. Joined fields in v0.6 are
projection-only, so running a join inside a grouping pipeline would
be wasteful and could trigger `DanglingReferenceError` in strict
mode. Grouping by a joined field is explicitly out of scope.

**New public surface:**
- `Query.groupBy(field)` chain method
- `GroupedQuery<T, F>`, `GroupedAggregation<R>` — wrapper classes
- `groupAndReduce` — pure helper (reused by future `scan().groupBy()`)
- `GroupCardinalityError` — structured error with `field`,
  `cardinality`, `maxGroups`
- `GROUPBY_WARN_CARDINALITY`, `GROUPBY_MAX_CARDINALITY` — constants
- `buildLiveAggregation` — shared live-primitive factory
- `GroupedRow<F, R>` — result row type
- `resetGroupByWarnings` — test-only warning dedup reset

**Type-level stable-key narrowing (v0.8 #85 prep):** v0.6 types
the group key as `unknown` at the result shape. When `dictKey`
lands in v0.8, a `groupBy<DictField>()` overload will narrow the
group key type to the stable dictionary key rather than the
resolved locale label — preventing the silent bug where grouping
by a localized label produces different buckets per reader. The
overload layers on top without an API break.

**Out of scope (separate issues):**
- Multi-level groupBy (nested groupings)
- `.having(predicate)` filtering on grouped results
- Index-backed aggregation planner
- Groupings across joins
- `scan().groupBy().aggregate()` — gated on #99 streaming story
- Per-bucket incremental delta maintenance for live mode (v2)

Tests: 20 new cases covering basic bucketing, composition with
`.where()`, multiple reducers per bucket, insertion-order
emission, empty result sets, null/undefined key distinction, 10k
warn threshold with dedup across runs, 100k hard cap with error
details, the `groupAndReduce` pure helper, and live-mode
insert/update/delete across bucket creation, mutation, and
removal.

463/463 core tests passing (443 from #97 + 20 new for #98).
