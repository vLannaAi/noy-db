# indexing

> **Subpath:** `@noy-db/hub/indexing`
> **Factory:** `withIndexing()`
> **Cluster:** A — Read & Query
> **LOC cost:** ~886 (off-bundle when not opted in)

## What it does

Maintains per-collection indexes for fast equality lookups, `in`-list filters, and `orderBy` dispatch. In eager mode the index is an in-memory mirror; in lazy mode it's persisted as `_idx/<field>/<recordId>` side-cars on the store. Without indexes a query is a linear scan over the cache or the store; with indexes it's an O(1) hash lookup or an O(log n) sorted scan.

## When you need it

- A collection with more than ~5,000 records
- Queries that filter by stable fields (`status`, `region`, `clientId`)
- `orderBy` on a hot field
- Lazy-mode collections (memory-bounded; `query()` won't work without an index)
- Joins (the indexed nested-loop strategy uses the index on the join field)

## Opt-in

```ts
import { createNoydb } from '@noy-db/hub'
import { withIndexing } from '@noy-db/hub/indexing'

const db = await createNoydb({
  store: ...,
  user: ...,
  indexStrategy: withIndexing(),
})
```

Declare per-collection indexes:

```ts
vault.collection<Invoice>('invoices', {
  indexes: ['clientId', 'status', 'date'],
})
```

## API

- `collection.lazyQuery()` — fast-path query on lazy-mode collections
- `collection.rebuildIndexes()` — full rebuild from records (use after bulk import)
- `collection.reconcileIndex(field, { dryRun })` — drift detection for persisted side-cars
- Auto-reconcile via `reconcileOnOpen: 'dry-run' | 'auto' | 'off'`

## Behavior when NOT opted in

- Eager-mode collections: `where('field', '==', value)` falls back to a linear scan; `indexes: [...]` is ignored
- Lazy-mode collections: `lazyQuery()` throws with a pointer to `@noy-db/hub/indexing`
- `rebuildIndexes()` / `reconcileIndex()` throw

## Pairs well with

- **joins** (currently always-core) — the indexed nested-loop strategy uses this
- **aggregate** — `groupBy` dispatches through the index when present
- **lazy mode** (within `routing`) — required for any non-trivial lazy-mode query

## Edge cases & limits

- Side-car drift can occur if the store is modified out-of-band. Use `reconcileOnOpen: 'auto'` for unattended servers, `'dry-run'` for human-operated apps that surface a "rebuild" button
- Index writes are part of the same put transaction; an index write failure throws `IndexWriteFailureError`

## See also

- [SUBSYSTEMS.md](../../SUBSYSTEMS.md)
- `__tests__/query-persisted-indexes.test.ts`
