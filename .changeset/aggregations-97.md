---
'@noy-db/core': minor
---

feat(core): aggregation reducers + `.aggregate()` terminal + `.live()` reactive (#97)

New reducer primitives on the query DSL — `count`, `sum`, `avg`,
`min`, `max` — plus a `.aggregate()` near-terminal that reduces
matching records through a named spec and returns a wrapper with
two terminals of its own:

```ts
// Static one-shot reduction
const { total, n, meanAmount } = invoices.query()
  .where('status', '==', 'open')
  .aggregate({
    total:      sum('amount'),
    n:          count(),
    meanAmount: avg('amount'),
  })
  .run()

// Reactive primitive — re-runs on source mutations
const live = invoices.query()
  .where('status', '==', 'open')
  .aggregate({ total: sum('amount'), n: count() })
  .live()

live.subscribe(() => renderDashboard(live.value))
// ... later
live.stop()
```

**Return type inference:** the spec's shape flows through — a spec
of `{ total: sum('amount'), n: count() }` produces a result of
`{ total: number, n: number }`. `avg` / `min` / `max` return
`number | null` to mark the empty-result case without poisoning
downstream arithmetic with NaN.

**Reducer protocol:** each factory produces a
`{ init, step, remove?, finalize }` object with separate internal
state (`S`) and user-visible result (`R`) type parameters. This
is the shape that admits O(1) incremental maintenance for
sum/count/avg in a future optimization without breaking the
public API. v0.6 ships naive full re-run on source change;
incremental delta maintenance is a planned follow-up.

**`.live()` reactive primitive** — `LiveAggregation<R>`: plain
object with `value` / `error` fields and a `subscribe(cb)`
notification channel, frame-agnostic. If a re-run throws, the
previous successful value is preserved and the error is stored in
`live.error` so consumers can render an error state without losing
the last-known-good result. Same error-isolation contract as
`LiveQuery` (#74). `stop()` is idempotent; subscribe after stop is
a no-op.

**#87 constraint #2 (load-bearing seam):** every reducer factory
accepts an optional `{ seed }` parameter that is plumbed through
the protocol but unused by the v0.6 executor. When v0.10
partition-aware aggregation lands, the seed will carry running
state across partition boundaries without requiring an API break.
Do not remove — that's the whole point of having it now.

**Out of scope (separate issues):**
- `.groupBy(field)` — #98
- `scan().aggregate()` — #99
- Incremental delta maintenance for live mode (v2 optimization)
- Aggregations across joins
- Per-row callback reducers (`.reduce(fn, init)`)
- Index-backed aggregation planner
- Multi-level groupBy

Tests: 27 new cases covering every reducer factory, combined
specs, empty-result-set null-on-empty semantics, the #87 seed seam,
`reduceRecords` pure helper, live-mode initial value, insert /
update / delete re-fires, min/max O(N) extremum-removal edge case,
multi-subscriber notifications, individual unsubscribe, idempotent
`stop()`, subscribe-after-stop no-op, and `.live()` over a
subscribe-less static source.

443/443 core tests passing.
