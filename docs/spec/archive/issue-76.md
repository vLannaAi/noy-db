# Issue #76 — feat(core): Streaming join over scan() — bypass row ceiling for huge collections

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

Discussion vLannaAi/noy-db#64. v2 follow-up on the v1 join planner from vLannaAi/noy-db#73.

## Problem

The v1 join (#73) ships with a hard `JoinTooLargeError` ceiling at 50k rows per side (overridable to ~200k). For collections genuinely beyond that — the kind that already use `scan()` for memory-bounded iteration — the eager join planner is the wrong tool. Consumers in this case should be able to express a join over a streaming scan and get a streaming result back.

## Proposed solution

```ts
for await (const row of invoices.scan().join('clientId', { as: 'client' })) {
  // row = { ...invoice, client: { ... } | null }
  await processRow(row)
}
```

### Scope

- `Scan.join(field, options)` returns an async iterator of joined rows
- Right-side resolution strategy:
  - **Indexed right side** — same per-row index lookup as the eager indexed-nested-loop planner; `O(1)` per row, no in-memory join state
  - **Non-indexed right side** — bounded LRU of right-side records (default `maxCacheRows: 5_000`, configurable), falls back to per-row `get()` on cache miss; **NOT** the same as building the full hash table, since the whole point of streaming is to avoid that
- Ref-mode behavior matches the eager v1 contract: `strict` throws on the offending row, `warn` yields with `client: null` + warn, `cascade` skips the row
- Memory ceiling is the LRU bound, not a row count — fundamentally different shape from the v1 ceiling
- Single-FK only in v1 of streaming joins; chained streaming joins are a follow-up

### Why this is its own issue and not part of #73

- **Different planner.** The eager v1 planner builds full materialized state up front. The streaming planner cannot — every assumption about random access to the right side has to be replaced with bounded LRU + per-row fallback.
- **Different memory model.** v1 uses a row count ceiling. Streaming uses a cache budget in records (or bytes — TBD in PR). These are not interchangeable knobs.
- **Different test surface.** Every streaming feature needs ordering tests, backpressure tests, cancellation tests, and memory-bound assertions that the eager path doesn't have. Cleanest as a separate review.
- **Different consumer.** A consumer who hits the v1 row ceiling and needs to switch to the streaming path is making a deliberate choice — they're already using `scan()`. Putting it behind its own builder method makes the choice explicit.

### Out of scope

- Live streaming joins — needs an entirely different change-stream design
- Multi-FK streaming joins — separate follow-up
- Streaming joins where both sides are huge (think tens of millions × tens of millions) — that's a real database, not noy-db
- Cross-compartment streaming joins — explicitly forbidden by the architecture invariant

## Acceptance

- [ ] `Scan.join(field, { as, maxCacheRows? })` returns an async iterator of joined rows
- [ ] Indexed right side resolves per-row in O(1) without growing in-memory state
- [ ] Non-indexed right side uses a bounded LRU with the configured cache budget
- [ ] All three ref modes behave per the eager v1 contract
- [ ] Memory test: streaming a 100k × 100k join completes within a documented memory ceiling (asserts the LRU is actually bounded)
- [ ] Cancellation test: aborting the iterator mid-stream releases the LRU and stops further reads
- [ ] Changeset (`@noy-db/core: minor`)

## Invariant compliance

- [x] Adapters never see plaintext
- [x] No new runtime crypto dependencies
- [x] 6-method adapter contract unchanged
- [x] KEK never persisted; DEKs never stored unwrapped

v0.7.0 candidate (or whenever a real consumer asks). Blocked by #73. Lower priority than #74 / #75 — most consumers will never need streaming joins.
