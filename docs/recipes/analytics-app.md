# Recipe 4 — Analytics-heavy querying

> **Audience:** apps with thousands to tens of thousands of records that need fast filtering, joining across collections, and pre-aggregated reports — dashboards, BI consoles, search-driven UIs.
> **Bundle:** core + `withIndexing` + `withAggregate` + `withRouting` (n/a yet — see SUBSYSTEMS catalog) — roughly 10,700 LOC. No history, no blobs, no sync, no i18n by default — add them as needed.
> **Verified by:** [showcases/src/recipe-analytics.recipe.test.ts](../../showcases/src/recipe-analytics.recipe.test.ts)

## What this gets you

| Subsystem | What it adds |
|---|---|
| `withIndexing()` | Eager-mode `==` and `in` fast-paths; lazy-mode `.lazyQuery()` for on-demand fetch; `_idx/<field>/<id>` side-cars maintained on every put/delete |
| `withAggregate()` | `sum`, `avg`, `count`, `min`, `max` + `groupBy` |
| Joins (always-core today; planned `withJoins()` extraction) | Multi-FK eager joins with indexed nested-loop / hash strategy |
| `withSession()` | Idle timeout for analyst sessions |

## Setup — lazy mode for large datasets

```ts
import { createNoydb } from '@noy-db/hub'
import { withIndexing } from '@noy-db/hub/indexing'
import { withAggregate } from '@noy-db/hub/aggregate'
import { withSession } from '@noy-db/hub/session'
import { postgres } from '@noy-db/to-postgres'

const db = await createNoydb({
  store: postgres({ url: process.env.DATABASE_URL! }),
  user: 'analyst@firm.example',
  secret: process.env.NOYDB_PASSPHRASE!,

  indexingStrategy: withIndexing(),
  aggregateStrategy: withAggregate(),
  sessionStrategy: withSession(),

  sessionPolicy: { idleTimeoutMs: 30 * 60_000 },
})
```

## Declare indexes up front

```ts
import { ref } from '@noy-db/hub'

interface Invoice {
  id: string
  clientId: string
  amount: number
  status: 'draft' | 'open' | 'paid' | 'overdue'
  date: string
  region: string
}

interface Client {
  id: string
  name: string
  segment: 'enterprise' | 'sme' | 'consumer'
}

const vault = await db.openVault('reporting')

const clients = vault.collection<Client>('clients')

const invoices = vault.collection<Invoice>('invoices', {
  prefetch: false, // lazy — don't load all records at openVault
  cache: { maxRecords: 5_000, maxBytes: '50MB' },
  indexes: [
    { field: 'clientId' },        // for joins
    { field: 'status' },          // for filtering
    { field: 'date' },            // for orderBy
    { field: 'region' },          // for groupBy
  ],
  refs: {
    clientId: ref(clients),       // FK declaration
  },
})
```

## Filter + paginate without loading everything

```ts
// In lazy mode, query() is replaced with lazyQuery() — it streams from
// the store via the index, not from an in-memory cache.
const overdue = await invoices.lazyQuery()
  .where('status', '==', 'overdue')
  .orderBy('date', 'desc')
  .limit(50)
  .toArray()
```

## Join across collections

```ts
const enriched = await invoices.query()
  .where('status', '==', 'paid')
  .join('clientId', { as: 'client' })
  .toArray()
// [{ id: 'inv-001', amount: 15_000, client: { id: 'client-42', name: 'Acme', ... } }, ...]
```

Join strategy is automatic: indexed nested-loop when an index exists on the join field; hash join when not.

## Aggregates per group

```ts
import { sum, avg, count } from '@noy-db/hub'

const byRegion = await invoices.query()
  .where('status', '==', 'paid')
  .groupBy('region')
  .aggregate({
    total: sum('amount'),
    avg: avg('amount'),
    n: count(),
  })
  .run()
// → [{ key: 'EU', total: 1_240_000, avg: 7_300, n: 170 }, ...]
```

## Streaming aggregates over very large sets

When your data exceeds the in-memory ceiling (50k rows for joins, 100k groups for groupBy), stream:

```ts
const total = await invoices.scan()
  .where('status', '==', 'paid')
  .aggregate({ sum: sum('amount') })
// O(reducers) memory, no row ceiling
```

## Multi-store routing — hot vs. cold

For terabyte-scale apps, route hot data to memory-resident stores and cold data to object storage. (TODO once `withRouting()` ships — today this lives in `@noy-db/hub` directly via `routeStore()` from the store middleware.)

## Performance ceilings to know about

- **Eager joins**: `JoinTooLargeError` at 50k rows per side. Override with `{ maxRows }` if you've measured.
- **groupBy**: warns at 10k groups, throws `GroupCardinalityError` at 100k. Sharp ceiling on purpose — beyond this you probably want a streaming aggregate or an external OLAP system.
- **Lazy mode + in-memory cache**: tune `maxRecords` / `maxBytes` to your working set. The LRU evicts least-recently-used entries.

## See also

- [SUBSYSTEMS.md](../../SUBSYSTEMS.md) — full catalog
- [docs/subsystems/indexing.md](../subsystems/indexing.md) (TODO)
- [docs/subsystems/aggregate.md](../subsystems/aggregate.md) (TODO)
- [docs/subsystems/joins.md](../subsystems/joins.md) (TODO)
- [showcases/src/07-query-analytics.showcase.test.ts](../../showcases/src/07-query-analytics.showcase.test.ts)
