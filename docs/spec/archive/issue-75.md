# Issue #75 — feat(core): .join() multi-FK chaining

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-07
- **Closed:** 2026-04-09
- **Milestone:** v0.6.0
- **Labels:** type: feature, area: core

---

## Target package

`@noy-db/core`

## Spawned from

Discussion vLannaAi/noy-db#64. Builds on the v1 join planner from vLannaAi/noy-db#73.

## Problem

The v1 join (#73) handles a single FK per query — `invoices.query().join('clientId')`. Real consumers commonly need to follow more than one relationship in the same query: an invoice has both a `clientId` (→ clients) and a `parentId` (→ parent invoice for partial-payment chains), and the dashboard wants both joined in one call.

Today the consumer would have to materialize the invoices, then make a second join pass in userland. That defeats the point of having a join builder.

## Proposed solution

```ts
const rows = invoices.query()
  .where('status', '==', 'open')
  .join('clientId', { as: 'client' })
  .join('parentId', { as: 'parent' })
  .toArray()
// → [{ id, amount, client: { ... }, parent: { ... } | null }, ...]
```

### Scope

- Multiple `.join()` calls in the same builder chain, each resolving an independent FK
- The planner picks the best strategy (indexed nested-loop or hash) **per join**, not per query — a query can mix both
- The combined memory ceiling counts the cartesian product against `maxRows` — if either side of any join exceeds it, throw
- Joins are independent: one ref-mode behavior per join, evaluated independently
- Eager hydration only in this issue (matches v1)

### Out of scope

- **Self-joins** — same source/target collection. Possible but needs its own design (cycle detection, alias collisions). Separate issue if asked.
- **Live mode** for chained joins — depends on the live-mode issue (#74) landing first
- **Streaming chained joins** — separate v2 issue
- **Reordering of join order by the planner** — joins execute in declaration order in v1

## Acceptance

- [ ] `.join(...).join(...)` chain produces a row with both alias keys populated
- [ ] Each join uses its own planner strategy (one indexed, one hash mixed in the same query)
- [ ] `JoinTooLargeError` accounts for the combined row count, not just the first join
- [ ] Independent ref-mode behavior per join — one `strict`, one `warn` in the same query both fire correctly
- [ ] Tests covering 2-join and 3-join chains, mixed planner strategies, and one test per ref-mode combination
- [ ] Changeset (`@noy-db/core: minor`)

## Invariant compliance

- [x] Adapters never see plaintext
- [x] No new runtime crypto dependencies
- [x] 6-method adapter contract unchanged
- [x] KEK never persisted; DEKs never stored unwrapped

v0.6.0 candidate. Blocked by #73.
