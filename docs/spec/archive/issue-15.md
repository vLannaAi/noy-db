# Issue #15 — Lazy collection hydration + LRU eviction

- **State:** closed
- **Author:** @vLannaAi
- **Created:** 2026-04-06
- **Closed:** 2026-04-06
- **Milestone:** v0.3.0
- **Labels:** type: feature, release: v0.3, area: core

---

# Lazy collection hydration + LRU eviction

Part of #6 (v0.3 release).

## Scope

Add per-collection lazy hydration with an LRU cache to `@noy-db/core`. Configured per collection: `{ cache: { maxRecords: 5000, maxBytes: '50MB' }, prefetch: false }`. Default `prefetch: true` preserves the v0.2 eager-load behavior so nothing breaks. When `prefetch: false`, records load on demand via `listPage` (#8) and the LRU evicts cold records to stay within bounds. Eviction never drops dirty records.

## Why

The current memory-first model caps NOYDB at 1K–50K records per compartment. v0.3's adoption goal includes consumers with hundreds of thousands of records (the accounting demo's invoices over multiple years). Lazy hydration is the toggle that lets the same API scale.

## Technical design

- New module `packages/core/src/cache/`:
  - `lru.ts` — generic LRU keyed by record id, byte-aware.
  - `hydration.ts` — manages "loaded" vs "evicted" record state inside a `Collection`.
  - `policy.ts` — parses `maxBytes: '50MB' | '1GB' | number`.
- `Collection` constructor accepts `{ cache?, prefetch? }`. When `prefetch: false`, `loadAll` is replaced by an empty initial state and `get(id)` falls through to `listPage` (#8) targeted at that id, or to `adapter.get` directly.
- LRU tracks both record count and approximate decrypted byte size; eviction picks the LRU entry until both budgets are satisfied.
- Dirty records (pending sync, version mismatch in flight) are pinned and never evicted. Pinned set is exposed for devtools.
- Cache stats (`hits`, `misses`, `evictions`, `bytes`) exposed via `collection.cacheStats()` for the devtools tab in #2.
- Query DSL (#6) interacts cleanly: when an indexed query points at evicted records, they are re-hydrated transparently before being returned.
- Tree-shakeable: passing no `cache` option pulls in nothing.

## Acceptance criteria

- [ ] **Implementation:** `packages/core/src/cache/` with the three files above; `Collection` honors `{ cache, prefetch }`.
- [ ] **Unit tests:** at least 16 `it()` blocks across `lru.test.ts`, `hydration.test.ts`, `policy.test.ts`. Cover: byte-budget eviction, record-count eviction, dirty record pinned across eviction, `prefetch: true` matches v0.2 behavior, `prefetch: false` empty initial state, on-demand `get(id)` populates the cache, cache stats accuracy, `'50MB'` and `'1GB'` parsing, invalid byte string rejected, query result re-hydrates evicted records, default options preserve v0.2 semantics, eviction never drops a record currently held by an active `live()` subscription from #6.
- [ ] **Integration tests:** open a collection of 50K records with `{ cache: { maxRecords: 1000 } }` and `prefetch: false`; iterate them randomly; assert peak loaded records stays at 1000.
- [ ] **Type tests:** `expect-type` for the cache options shape.
- [ ] **Docs:** new "Caching and lazy hydration" section in `docs/end-user-features.md`; update `docs/architecture.md` to note that the memory-first invariant is now opt-in via `prefetch: true`.
- [ ] **Changeset:** included in core `0.3.0`.
- [ ] **CI:** existing core test job.
- [ ] **Bundle:** cache module <3 KB gzipped; core stays under 30 KB.

## Dependencies

- Blocked by: #8 (uses `listPage` internally)
- Blocks: nothing

## Estimate

M

## Labels

`release: v0.3`, `area: core`, `type: feature`
