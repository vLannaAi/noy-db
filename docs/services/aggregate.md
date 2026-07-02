# aggregate

> **Subpath:** `@noy-db/hub/aggregate`
> **Factory:** `withAggregate()`
> **Cluster:** A — Read & Query
> **LOC cost:** ~886 (off-bundle when not opted in)

## What it does

Adds `count`, `sum`, `avg`, `min`, `max` reducers + `groupBy` to query and scan terminals. Computed in-memory after the filter/order/limit pipeline. For workloads beyond the in-memory ceiling, `scan().aggregate()` streams with O(reducers) memory.

## When you need it

- Per-period totals (`sum('amount')` grouped by month)
- Per-segment averages (`avg('order_size')` grouped by `segment`)
- Counts (`count()` per `status`)
- Multi-reducer rollups in one pass

## Opt-in

```ts
import { createNoydb } from '@noy-db/hub'
import { withAggregate } from '@noy-db/hub/aggregate'

const db = await createNoydb({
  store: ...,
  user: ...,
  aggregateStrategy: withAggregate(),
})
```

## API

```ts
import { sum, avg, count, min, max } from '@noy-db/hub'

const totals = invoices.query()
  .where('status', '==', 'paid')
  .groupBy('clientId')
  .aggregate({ total: sum('amount'), n: count() })
  .run()

// Streaming
await invoices.scan()
  .where('status', '==', 'paid')
  .aggregate({ sum: sum('amount') })
```

Reducers exported from `@noy-db/hub`: `count`, `sum`, `avg`, `min`, `max`.

### Multi-key groupBy

`Query<T>.groupBy(...fields)` accepts one or more field names. The
result rows carry every grouped field (in declaration order) plus the
reducer outputs:

```ts
.groupBy('clientId', 'period')
.aggregate({ total: sum('amount') })
// → [ { clientId: 'c1', period: '2026-05', total: 300 }, … ]
```

Cardinality thresholds (10k warn, 100k throw) apply on the count of
distinct tuples, not on the count of fields. The warning message lists
every grouped field name.

Order of fields in `groupBy(...)` does NOT affect the bucket identity —
internally, the canonical key sorts field names before hashing. So
`.groupBy('a', 'b')` and `.groupBy('b', 'a')` produce the same buckets;
the difference is purely the declaration order of fields on the output
rows.

See showcase [`85-with-multikey-groupby`](../../showcases/src/85-with-multikey-groupby.showcase.test.ts).

For usage inside `withMaterializedView` queries, see [`derivations.md` § Multi-key groupBy in MV queries](./derivations.md#multi-key-groupby-in-mv-queries).

## Behavior when NOT opted in

- `query().aggregate(...)` throws with a pointer to `@noy-db/hub/aggregate`
- `query().groupBy(...)` throws on `.run()` / `.aggregate()`
- `scan().aggregate(...)` works *without* the strategy — it uses an inline reducer protocol that doesn't pull the heavy `Aggregation` / `GroupedQuery` classes

## Pairs well with

- **indexing** — `groupBy` dispatches through the index for a hot group field
- **i18n** — `groupBy(dictKeyField)` resolves labels per locale on render

## Edge cases & limits

- **`groupBy` cardinality**: warns at 10,000 groups, throws `GroupCardinalityError` at 100,000. Sharp ceiling on purpose — beyond this you want streaming `scan().aggregate()` or an external OLAP system
- Reducers are pure functions; custom reducers ship via the same `Reducer<In, Out>` shape
- **Exact money `sum`/`min`/`max`**: union-form materialized views opt into exact BigInt money aggregation via the strategy's `moneyFields` map (#350) — see [`derivations.md` § UNION sources](./derivations.md#union-sources--withmaterializedview-reading-from-multiple-collections)

## See also

- [SERVICES.md](../../SERVICES.md)
- `docs/recipes/analytics-app.md`
- `__tests__/query-aggregate.test.ts`, `__tests__/query-groupby.test.ts`
