# Issue #98 — feat(core): .groupBy(field) for query DSL aggregations

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

Discussion #65 — Query DSL: aggregations. Companion to #97 (reducers + `.aggregate()`).

## Problem

Without `groupBy`, consumers who want per-bucket aggregates (per-client invoice totals, per-status counts, per-category sums) have to fold in userland after `.toArray()`. This loses reactivity under `.live()` and — for dictionary-backed keys landing in v0.8 — silently produces wrong results if callers group by the localized label instead of the stable key (#85 will enforce this at type level).

## Scope (v1)

- **`.groupBy(field)` operator** on `QueryBuilder`, chains before `.aggregate({...})`:
  ```ts
  const byClient = await invoices.query()
    .groupBy('clientId')
    .aggregate({ total: sum('amount'), n: count() })
  // → Array<{ clientId: string, total: number, n: number }>
  ```
- **Single-level groupBy only.** Multi-level (`.groupBy('a').groupBy('b')`) is out of scope for v1 — wait for consumer ask.
- **Group key is a plaintext field after decryption.** Grouping happens in memory post-decrypt. No new crypto.
- **`.groupBy(...).aggregate(...).live()`** — reactive with incremental per-group maintenance. Add/remove/update deltas route to the correct bucket.
- **Cardinality warn at 10k groups** — one-shot warning on the existing warn channel. Hard error at 100k groups (`GroupCardinalityError`) to prevent accidental O(records) memory blowup from grouping by a high-cardinality field.
- **Type enforcement for `dictKey` keys (v0.8 prep)** — `.groupBy()` must accept a `dictKey` field and group by the stable key, never the resolved label. v0.6 plumbs the type narrowing; v0.8 fills in the dictionary resolution. See #85.

## Out of scope (deferred)

- Multi-level groupBy — v2
- `having(...)` filtering on aggregate results — v2
- Index-backed groupBy planner — optional optimization
- GroupBy across joins — v2

## Acceptance

- [ ] `QueryBuilder.groupBy(field)` chain method returning a grouped query builder
- [ ] `.groupBy().aggregate()` returns an array of `{ [field]: value, ...reducers }` rows
- [ ] `.groupBy().aggregate().live()` incrementally maintains per-group state
- [ ] 10k-group cardinality warning (one-shot) and 100k `GroupCardinalityError`
- [ ] Type signature accepts `dictKey` fields and narrows group key to the stable key type (no label resolution in v0.6 — prep for #85)
- [ ] Tests: happy path, live updates across groups (add/remove/move-between-groups), cardinality thresholds
- [ ] Changeset (`@noy-db/core: minor`)
- [ ] Full turbo pipeline green

## Invariant compliance

- [x] No new runtime crypto dependencies
- [x] Adapters never see plaintext
- [x] Reads do not touch the ledger

## Related

- #97 — aggregation reducers + `.aggregate()` terminal (blocks this)
- #85 — dictKey integration in query DSL (consumes this)
- #87 — design-forward partition seams (constraints apply)

v0.6.0.
