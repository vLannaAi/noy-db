# Core 06 — Query basics

> **Always-on. Filter, order, paginate, stream.**
> Source of truth: `packages/hub/src/query/{builder,scan-builder,predicate}.ts`

## What it is

The chainable query builder for `where` / `orderBy` / `limit` / `offset` and the streaming `scan()` builder. Joins, aggregates, live subscriptions, and indexed dispatch are gated by their respective subsystems; what's here is the always-on read path.

## Eager queries

```ts
const recentPaid = await invoices.query()
  .where('status', '==', 'paid')
  .where('amount', '>', 1000)
  .or(q => q.where('priority', '==', 'high'))
  .orderBy('date', 'desc')
  .limit(50)
  .toArray()

const first = await invoices.query().where(...).first()
const n     = await invoices.query().where(...).count()
```

Operators on `.where(field, op, value)`:

| Op | Meaning |
|---|---|
| `'=='` | strict equal |
| `'!='` | strict not-equal |
| `'<'` `'<='` `'>'` `'>='` | numeric / lexical compare |
| `'in'` | value is in the supplied array |
| `'not-in'` | value is not in the supplied array |
| `'contains'` | array field contains the value |
| `'starts-with'` | string field starts with the value |
| `'array-contains-any'` | array field overlaps the supplied set |

`.filter(predicate)` accepts a free-form callback for cases the operator set doesn't cover (slower — bypasses index dispatch when present).

## Streaming

`scan()` returns an async iterable that streams from the store / cache without loading everything into memory:

```ts
for await (const inv of invoices.scan()) {
  process(inv)
}

// scan() also chains:
const total = await invoices.scan()
  .where('status', '==', 'paid')
  .aggregate({ sum: sum('amount') })  // requires withAggregate, but streaming aggregate is reducer-only
```

`scan()` works in both eager and lazy mode. Lazy mode requires [withIndexing](../subsystems/indexing.md) for non-trivial filters.

## Subscriptions (live updates)

Reactive queries are documented under [docs/subsystems/live.md](../subsystems/live.md). The base subscribe-on-collection surface (`collection.subscribe(cb)`) is currently always-on but slated to move into the `live` subsystem.

## Limits

- **Memory ceiling**: eager queries materialise into an array. For working sets > ~50K records, prefer `scan()`.
- **No SQL**: the store never sees plaintext, so the store can't run your query. Filtering happens in core after decryption.
- **Cross-collection**: use `query().join(...)` (see [joins](../subsystems/joins.md)) or `db.queryAcross()` for federated cases.

## See also

- [docs/subsystems/indexing.md](../subsystems/indexing.md) — fast-path equality / orderBy
- [docs/subsystems/joins.md](../subsystems/joins.md) — multi-FK joins
- [docs/subsystems/aggregate.md](../subsystems/aggregate.md) — sum / groupBy / etc.
- [docs/subsystems/live.md](../subsystems/live.md) — reactive subscriptions
