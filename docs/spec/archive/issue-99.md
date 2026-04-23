# Issue #99 — feat(core): scan().aggregate() — memory-bounded aggregation over streaming scan

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

Discussion #65 — Query DSL: aggregations. Companion to #97 (reducers + `.aggregate()`) and #98 (`groupBy`).

## Problem

`.aggregate()` on `.query()` materializes the matching set into memory before reducing (same shape as `.toArray()`). For collections beyond the in-memory ceiling (`scan()` territory, 50k+ records), this defeats the purpose of having reducers — the whole point of `sum` over a huge collection is to avoid holding the full set in memory at once.

`scan()` already exists for streaming iteration. It needs an `.aggregate(...)` tail to make memory-bounded reducers a real capability.

## Scope (v1)

- **`scan().aggregate({ ... })`** — consumes the scan stream one record at a time, feeds each record through every declared reducer, returns the final reduced shape:
  ```ts
  const { total, n } = await invoices.scan()
    .where('year', '==', 2025)
    .aggregate({ total: sum('amount'), n: count() })
  ```
- **Memory ceiling is O(reducers)**, not O(records). `sum`/`count`/`avg` are O(1) state per reducer. `min`/`max` are O(1) state per reducer. The scan iterator is the only thing touching records.
- **Works with the same reducer factories** as `.query().aggregate()` — no duplicated reducer protocol. A reducer that plugs into `.query().aggregate()` plugs into `.scan().aggregate()` with no changes.
- **Seed parameter honored** (required by #87 constraint #2) — identical semantics to `.query().aggregate()`.
- **Pagination-friendly** — scans already page through the adapter's `list()`; aggregation just folds across pages.
- **No `.live()` for scan aggregations in v1.** A live streaming aggregation over an unbounded scan is a different design problem (change-stream + scan reconciliation). Defer until a consumer asks.
- **`groupBy` over scan is NOT in v1 scope** — grouping requires O(groups) state, and groups can be high-cardinality on huge collections. Separate issue if a consumer needs it.

## Out of scope

- `.scan().aggregate().live()` — live mode over streaming scan
- `.scan().groupBy().aggregate()` — grouped streaming aggregation
- Parallel/chunked scan execution — optimization

## Acceptance

- [ ] `ScanBuilder.aggregate(reducers)` terminal reusing the `@noy-db/core` reducer protocol
- [ ] Memory footprint is O(reducers), validated by a test that aggregates a 100k-record collection and asserts no full materialization
- [ ] Seed parameter plumbed through (required by #87)
- [ ] Tests: happy path over a large collection, empty-scan edge case, mid-scan abort (reducer errors)
- [ ] Docs note: no `.live()` on scan aggregations in v1 — use `.query().aggregate().live()` for reactive bounded queries
- [ ] Changeset (`@noy-db/core: minor`)
- [ ] Full turbo pipeline green

## Invariant compliance

- [x] No new runtime crypto dependencies
- [x] Adapters never see plaintext
- [x] Reads do not touch the ledger
- [x] Records are decrypted one at a time in the stream — no full-collection plaintext in memory

## Related

- #97 — reducer protocol (blocks this)
- #87 — design-forward partition seams

v0.6.0.
