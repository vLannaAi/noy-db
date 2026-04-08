---
'@noy-db/core': minor
---

feat(core): `scan().aggregate()` — memory-bounded aggregation over streaming scan (#99)

`Collection.scan()` now returns a new `ScanBuilder<T>` that
implements `AsyncIterable<T>` (for backward-compatible `for await`
iteration) and exposes chainable `.where()` / `.filter()` clauses
plus a `.aggregate(spec)` async terminal that reduces the scan
stream through the same reducer protocol as `Query.aggregate()`
(#97) — with **O(reducers) memory**, not O(records).

```ts
// Backward-compatible iteration — unchanged from before
for await (const record of invoices.scan({ pageSize: 500 })) {
  await processOne(record)
}

// v0.6 #99 — streaming aggregation with filter
const { total, n } = await invoices.scan({ pageSize: 1000 })
  .where('year', '==', 2025)
  .aggregate({ total: sum('amount'), n: count() })
```

**Memory model.** The aggregate terminal initializes one state per
reducer, iterates through the scan one record at a time, applies
every reducer's `step` per record, and never collects the stream
into an array. This is what makes `scan().aggregate()` suitable
for collections that don't fit in memory — the bound is a
code-level invariant visible in the function body, not a runtime
assertion.

**Reducer reuse.** Every factory from #97 (`count`, `sum`, `avg`,
`min`, `max`) plugs into `scan().aggregate()` unchanged. The
`{ seed }` parameter plumbing from #87 constraint #2 is honored
transparently. No duplicated API — the reducer protocol was
deliberately designed so both `Query.aggregate()` and
`Scan.aggregate()` could share it.

**Immutable builder.** Each `.where()` / `.filter()` call returns
a fresh `ScanBuilder` sharing the same page provider and page
size. Base scans can be safely reused across multiple parallel
aggregations, though each still pays a full scan — multi-way
single-pass aggregation is out of scope for v0.6.

**Backward compatibility.** The return type of
`Collection.scan()` changed from `AsyncIterableIterator<T>` to
`ScanBuilder<T>`. Every existing `for await (const rec of
collection.scan()) { … }` call continues to work because
`ScanBuilder` implements `[Symbol.asyncIterator]`. Direct
`.next()` calls on the iterator — not idiomatic, not used anywhere
in the codebase — are no longer supported. All 36 existing
`pagination` + `lazy-hydration` tests continue to pass without
modification.

**New public surface:**
- `ScanBuilder<T>` — the chainable builder class
- `ScanPageProvider<T>` — page provider interface (exposed so
  tests and custom sources can build a builder without a full
  Collection)

**Out of scope (tracked separately):**
- `scan().aggregate().live()` — unbounded streaming + change-stream
  reconciliation is a design problem, not a code one. Consumers
  with huge collections and live needs should narrow with
  `.where()` enough to fit in the 50k `query()` limit and use
  `query().aggregate().live()` instead.
- `scan().groupBy().aggregate()` — high-cardinality grouping on
  huge collections re-introduces the O(groups) memory problem
  that streaming aggregate was designed to avoid.
- Parallel scan across pages — race-safe page cursor contracts
  are not in the adapter API yet.
- `scan().join(…)` — tracked under #76 streaming join.

Tests: 16 new cases in `query-scan-aggregate.test.ts` covering
async iteration, `.where()` / `.filter()` clause application,
multi-clause AND, builder immutability, every reducer in
combination, empty-result-set sentinels, the #87 seed seam in the
scan path, backward-compatible `for await` on a real Collection,
`.aggregate()` over a paginated Collection, multi-page iteration
with `pageSize` smaller than the collection, and a 5_000-record
streaming test that validates correctness (and implicitly memory
footprint) on a dataset large enough to cross many page
boundaries.

479/479 core tests passing (463 from #98 + 16 new for #99).
