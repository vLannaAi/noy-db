# Join/Projection Materialized View (#810)

**Status:** approved-for-implementation · **Milestone:** 40 (Federated read-model: hub support [api])
**Consumer:** niwat federated read-model (klum-db#44) — per-shard projected rows (bill/payment/dashboard) materialized natively instead of app-side custom refresh.

## Problem

`withMaterializedView` has two forms: `query` (single-source; forward `.join()` legs already auto-tracked by the dependency analyzer) and `unionSources` (multi-source same-shape, per-arm forward `join?` + `map`). Neither can produce the niwat row: **primary record enriched with child SETS resolved by reverse FK** (receipts *pointing at* the bill, credit notes, applications…) plus forward lookups (client name), shaped by a projection function, **kept fresh when any referenced source changes**.

The two gaps, precisely:
1. **No reverse (one-to-many) join** anywhere in the query DSL or MV forms — `Query.join()` is forward-only (left FK field → right record).
2. **No row-shaping hook on the query form** — UNION arms have `map`; query-form rows are the raw query result.

Everything else already exists: multi-source dependency dispatch (`registry._bySource`), auto-analyzed forward-join deps, ViaGraph cycle edges from the dependency set, full-rebuild executor with diff/tombstone, eager/lazy/manual refresh, `_materializedFrom` metadata envelope, queryHash.

## Design: a third strategy form — `projection`

`MaterializedViewStrategy<TRow>` gains `projection?`, mutually exclusive with `query`/`unionSources` (exactly-one-of-three, validated in `withMaterializedView()` with `MaterializedViewConfigError`).

```ts
projection?: {
  /** Primary collection. One output row per primary record (unless map omits). */
  readonly source: string
  /** Join legs attached to each primary row BEFORE map runs. */
  readonly joins: ReadonlyArray<ProjectionJoinLeg>
  /** Pure projection: primary row + attachments → MV row. null/undefined omits. */
  readonly map: (row: Record<string, unknown>) => TRow | null | undefined
}

type ProjectionJoinLeg =
  /** Forward FK leg — identical shape + machinery as UnionArmJoin / Query.join(). */
  | { readonly field: string; readonly as: string
      readonly maxRows?: number; readonly strategy?: JoinStrategy }
  /** Reverse one-to-many "collect" leg — NEW. All rows of `from` whose `on`
      field references the primary record's id, attached as an ARRAY under `as`. */
  | { readonly collect: string          // sibling collection to collect from
      readonly on: string               // FK field on `collect` (ref() → source required)
      readonly as: string
      readonly maxRows?: number }       // per-primary-row ceiling; default DEFAULT_JOIN_MAX_ROWS
```

Discriminant: presence of `collect` vs `field`. Both leg kinds may repeat; `as` aliases must be unique across legs and non-empty.

### The niwat acceptance shape

```ts
withMaterializedView<BillRow>({
  name: 'billRows',
  projection: {
    source: 'bills',
    joins: [
      { field: 'clientId', as: 'client' },                       // forward
      { collect: 'receipts', on: 'billId', as: 'receipts' },     // reverse
      { collect: 'receiptBillApplications', on: 'billId', as: 'applications' },
      { collect: 'creditNotes', on: 'billId', as: 'creditNotes' },
      { collect: 'disbursements', on: 'billId', as: 'disbursements' },
    ],
    map: (r) => projectBillRow(r),  // window sums, coverage, status — app-pure
  },
  rowKey: (r) => r.billId,
  refresh: 'eager',
})
```

## Semantics

- **Forward legs** reuse the existing join machinery (`applyJoins`/`JoinLeg` path, same as UNION arms): `ref()`-declared FK required, resolved record attached under `as` (record | null), `maxRows`/`strategy` pass through.
- **Collect legs**: one snapshot pass over `from`, hash-grouped by `on` (O(N+M), mirrors the hash-join fallback), attached as a possibly-empty array. The `on` field **must have a `ref()` declared targeting `source`** — semantic validation at first materialization (parity with join-time ref errors), shape validation at factory time. Exceeding `maxRows` for one primary row throws the join-ceiling error (same family as `JoinTooLargeError`).
- **Filtering lives in `map`** (return null to omit) — no `where` in v1 (YAGNI; niwat's windowing is in-map over child arrays).
- **Post-map `groupBy`/`aggregate`**: supported, same as UNION (mapped stream → shared `groupAndReduce`). `onEmpty`, `strict`, `maxRows`, `output`, `partition` all inherit unchanged.
- **Dependencies — all AUTO**: `{source} ∪ forward-ref targets ∪ collect froms` (better DX than UNION's manual `sources` requirement; explicit `sources` still additive). Feeds `_bySource` dispatch, so a write to ANY referenced collection triggers eager refresh / lazy stale-marking — the freshness half of #810 for free. Same set feeds `registry.edges()` → ViaGraph `'mv'` edges → cycle detection needs no change.
- **Refresh** = full rebuild (parity with existing executor: re-run, diff `newIds`, tombstone via `_internalDelete`). Incremental per-primary-row refresh is a possible follow-up, out of scope.
- **queryHash**: structural summary `JSON{projection:{source, legs:[sorted leg descriptors]}}` — the `map` body is NOT hashed (documented; identical limitation as UNION `map`).
- **Tier posture**: the projection sees what the refreshing session sees (existing MV law; no new leak surface — collect legs read through the same collection read path).

## Where the code lives

All inside `src/with-formula/materialized-views/*` (the lazy-import chunk — must stay dynamically imported; no floor-bundle growth):
- `types.ts` — `ProjectionSpec`, `ProjectionJoinLeg` + strategy field
- `with-materialized-view.ts` — exactly-one-of-three + leg shape validation
- `registry.ts` — third branch: dependencies + `summarizeProjectionPlan`
- `executor.ts` — `materializeProjectionResult` (hydrate source → forward legs via existing helper → collect legs via hash-group → map → optional groupAndReduce → shared diff/write path)
- No kernel-spine changes expected (dispatch is dependency-set-driven) → no line-ceiling bumps.

## Tests

`__tests__/materialized-views/projection-mv.test.ts`:
1. niwat-shaped 5-leg acceptance (bills/clients/receipts/applications/creditNotes) — row content byte-exact vs hand-computed
2. freshness: eager refresh on child write (new receipt updates bill row); lazy stale-marker + resolve-on-read
3. map null-omission; empty collect arrays
4. collect `maxRows` ceiling throws; missing ref() on `on` throws at first materialize
5. config validation: two forms declared, dup `as`, empty legs
6. cycle refusal: projection MV whose collect target is another MV's output forming a loop
7. queryHash stability across re-open; change of leg set forces refresh
8. surface goldens updated (`with-surface`, root barrel) for the new exported types

## Implementation note (deviation, accepted)

**Forward-leg auto-dependencies resolve lazily, not at registration.** MV registration runs at vault open — before user code declares collections and their `ref()`s — so a forward leg's target is unknowable then (and constructing the source collection early would silently drop later ref declarations). The registry records pending forward fields with a non-constructive ref-registry probe and retries on each dispatch (`mvsForSource`) until resolved, then folds targets into the dependency set. Net freshness behavior matches the spec. Two documented residuals: (a) a cycle routed *exclusively* through a forward leg is not visible to the open-time cycle pass (source + collect edges are); (b) `queryHash` deliberately excludes late-folded forward targets so hash inputs stay deterministic at registration.

## Out of scope

- Reverse joins in the general query DSL (`Query.collect()`) — only the MV form
- Incremental (per-primary-row) refresh
- Cross-vault anything (that's `broadcastJoin` / klum-db#44's composition layer)
