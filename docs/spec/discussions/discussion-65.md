# Discussion #65 — Query DSL: aggregations (count, sum, avg, min, max, groupBy)

- **Category:** Ideas
- **Author:** @vLannaAi
- **Created:** 2026-04-07
- **State:** closed
- **Comments:** 4
- **URL:** https://github.com/vLannaAi/noy-db/discussions/65

---

Orthogonal to joins: the query DSL has no reducer primitives. Consumers who want `count`, `sum`, `avg`, `min`, `max`, or `groupBy` have to call `.toArray()` and fold in JS, which has two costs:

1. **Every field of every matching record gets decrypted**, even if the aggregation only touches one numeric column. For large collections this is wasted work.
2. **Not reactive.** A fold-in-userland has to be wrapped in a Vue/Pinia `computed` and re-run on every change. A DSL-level `.aggregate(...)` could plug directly into `.live()` and recompute incrementally when changes land.

Rough shape:

```ts
const totals = invoices.query()
  .where('status', '==', 'open')
  .aggregate({
    total: sum('amount'),
    count: count(),
    avg: avg('amount'),
  })
  .live()
// → ref<{ total: number, count: number, avg: number }>

const byClient = invoices.query()
  .groupBy('clientId')
  .aggregate({ total: sum('amount') })
  .toArray()
// → [{ clientId, total }, ...]
```

Open questions for the discussion:

1. **Field-level projection is not actually possible today.** Records are encrypted as a single envelope — you cannot "decrypt only the `amount` field". So the cost saving in point (1) above is **iteration shape only**, not bytes decrypted. Still worth it for the reactivity / incrementality, but it's important to be honest that this is *not* a crypto optimization.
2. **Incremental aggregation under `.live()`.** When a single record mutates, can the aggregator update in O(1) rather than recomputing over the full matching set? For `sum`/`count`/`avg` yes (maintain running totals + handle add/remove/update deltas from the change stream). For `min`/`max` the update case is O(N) in the worst case (the current min just got deleted) — acceptable to document this as a caveat.
3. **GroupBy determinism with encrypted keys.** Same answer as above: the group key is a plaintext field after decryption, so grouping happens in memory post-decrypt. No new crypto.
4. **Index-backed aggregation.** If a secondary index covers the `where` + `groupBy` fields, the planner could short-circuit the scan. Optional optimization, not blocking.
5. **Streaming over `scan()`.** For collections too large to materialize, `.aggregate()` over a streaming scan would produce the result without ever holding the full set in memory. Worth scoping in or out of v1 of this feature?
6. **Return shape for `.live()`.** A Vue `ref` (matching v0.3 reactive query conventions) or a generic observable that `@noy-db/vue` wraps? Consistency with the existing `.live()` contract suggests the former.

Looking for direction before filing as a feature issue. My expectation is that `count` / `sum` / `avg` with simple `.live()` reactivity covers ~90% of real-world use, and that `groupBy` + index-backed optimization can be a second-pass enhancement.


> _Comments are not archived here — see the URL for the full thread._
