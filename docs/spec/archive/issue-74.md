# Issue #74 — feat(core): .join() live mode — merged change-stream subscription

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

Discussion vLannaAi/noy-db#64. Depends on the v1 join planner from vLannaAi/noy-db#73.

## Problem

Once `.join()` ships eagerly via `.toArray()` (#73), consumers who want a reactive joined view still have to wrap the call in a Vue `computed` and re-run it manually. The whole point of the v0.3 reactive query DSL was to remove that pattern — `.live()` should work over joins the same way it works over single-collection queries.

## Proposed solution

```ts
const liveOpenInvoices = invoices.query()
  .where('status', '==', 'open')
  .join('clientId', { as: 'client' })
  .live()
// → reactive primitive that re-fires when EITHER side mutates
```

### Scope

- `.live()` over a `.join()` query produces a merged subscription over **both** collections' change streams
- A mutation on the left side (insert/update/delete of an invoice) re-evaluates the affected row(s) only
- A mutation on the right side (insert/update/delete of a client) re-evaluates every left-row that joined against it
- **Ref-mode behavior on right-side disappearance** must match the eager v1 contract from #73:
  - `strict` — the live ref surfaces an error and the reactive primitive enters an error state for the affected row
  - `warn` — the joined value flips to `null` with a one-shot warn
  - `cascade` — the affected left-rows disappear from the live result on the next tick
- The v0.3 `@noy-db/vue` ref wrapping continues to work — `.live()` returns the same reactive primitive shape, the Vue layer adapts it identically

### Out of scope

- Index-backed re-planning under live mutations — first version re-runs the same planner the eager path picks at subscription time
- Streaming live joins — depends on the streaming join issue
- Multi-FK chained joins under live — tracked in the multi-FK chaining issue

## Acceptance

- [ ] `.join().live()` returns the existing v0.3 reactive primitive
- [ ] Insert/update/delete on the left collection re-fires the subscription with correct rows
- [ ] Insert/update/delete on the right collection re-fires for every dependent left-row
- [ ] `strict`/`warn`/`cascade` ref-mode behavior matches the eager v1 contract from #73
- [ ] Tests covering all six left/right × insert/update/delete transitions, plus one test per ref mode for the right-side-disappearance case
- [ ] `@noy-db/vue` integration test confirms the existing `ref<>` wrapping still works without modification
- [ ] Changeset (`@noy-db/core: minor`)

## Invariant compliance

- [x] Adapters never see plaintext
- [x] No new runtime crypto dependencies
- [x] 6-method adapter contract unchanged
- [x] KEK never persisted; DEKs never stored unwrapped

v0.6.0 candidate. Blocked by #73.
