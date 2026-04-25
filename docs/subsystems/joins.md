# joins

> **Subpath:** *(currently always-core; will become `@noy-db/hub/joins` before v0.26)*
> **Factory:** `withJoins()` *(planned)*
> **Cluster:** A — Read & Query
> **LOC cost:** ~470 (planned — off-bundle when not opted in)

## What it does

Eager joins between collections via foreign-key references declared with `ref()`. Multi-FK chaining (`.join(...).join(...)`). Indexed nested-loop or hash strategy depending on whether an index exists on the join field. Reactive joins via `.live()` work end-to-end; live updates merge change-streams from every join target.

## When you need it

- Reports that include parent-record fields (invoice + client name + segment)
- Multi-step navigation (invoice → client → region)
- Reactive UI panes that should update when any joined collection changes

## Opt-in (current — always-on)

```ts
import { createNoydb, ref } from '@noy-db/hub'

const clients = vault.collection<Client>('clients')
const invoices = vault.collection<Invoice>('invoices', {
  refs: { clientId: ref('clients') },
})

const enriched = await invoices.query()
  .where('status', '==', 'paid')
  .join<'client', Client>('clientId', { as: 'client' })
  .toArray()
```

## API

- `query.join<As, Right>(field, { as, leftJoin? })` — single FK join
- `.join(...).join(...)` — multi-FK chain
- `.live()` — reactive merge of every join target's change-stream
- `query.join(field, { as }).filter(...)` — post-join filter

## Behavior when NOT opted in (post-extraction)

- `query.join(...)` will throw with a pointer to `@noy-db/hub/joins`
- The basic `query()` API (where / orderBy / limit / scan) stays in core

## Pairs well with

- **indexing** — the indexed nested-loop strategy uses the index on the join field
- **aggregate** — joined rows can be grouped and aggregated
- **live** (planned) — reactive joins surface as a reactive query

## Edge cases & limits

- **Row ceiling**: `JoinTooLargeError` at 50,000 rows per side. Override with `{ maxRows }` if you've measured
- **Ref-mode dispatch** on dangling refs: `strict` throws, `warn` attaches `null` + one-shot warn, `cascade` attaches `null` silently. Ref mode declared via `ref('clients', 'cascade')`
- Partition-aware execution (v0.11+) is plumbed but dormant — every `JoinLeg` carries `partitionScope: 'all'` today

## See also

- [SUBSYSTEMS.md](../../SUBSYSTEMS.md)
- `docs/recipes/analytics-app.md`
- `__tests__/query-join.test.ts`
