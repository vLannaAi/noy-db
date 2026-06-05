# cross-join

> **Subpath:** *(currently always-core)*
> **Cluster:** A — Read & Query
> **Spec:** `docs/superpowers/specs/2026-05-20-dim11-cross-join-v1-design.md`

## What it does

Cartesian-product cross-join between any two collections in the same vault via `.crossJoin(target, { as })`. Each result row carries the original left fields plus `row[as]` populated from the right side.

The optional `on:` parameter enables a **lateral form** — the right-side rows are filtered per left row:
- **Subset:** `on: (left) => TTarget[]` — return only the right rows that pair with `left`
- **Predicate:** `on: (left) => (right) => boolean` — executor materializes then filters
- **MV-safe:** `on: { predicate: 'name' }` — resolves a named predicate from the MV's `predicates` map; queryHash-tracked for drift detection

Composes in declared order with `.where()`, `.groupBy()`, and `.aggregate()`. Cross-join clauses are interleaved with filter clauses: a `.where()` BEFORE `.crossJoin()` filters the left side first (cheaper); a `.where()` AFTER can reference aliased right-side fields.

## When you need it

- Period × entity analytics (DERIV-SSO-001 pattern): active workers per pay period, coverage per billing cycle
- Multi-dimension reporting: every product × every region → aggregate
- Derived collections whose shape is inherently "every A paired with every B"

## API

```ts
query.crossJoin<TTarget, As extends string>(
  target: string,
  opts: {
    as: As
    on?: ((left: T) => TTarget[] | ((right: TTarget) => boolean)) | { predicate: string }
    maxRows?: number   // default: DEFAULT_CROSS_JOIN_MAX_ROWS (50_000)
  }
): Query<T & { [K in As]: TTarget }>
```

## Cost ceiling

`CrossJoinTooLargeError` fires **before** allocation when the product (or cumulative lateral count) exceeds the ceiling. Default: 50,000 rows (matches `JoinTooLargeError`). Override per-clause with `{ maxRows: N }`.

## Example — DERIV-SSO-001

```ts
const result = periods.query()
  .crossJoin<Worker, 'worker'>('workers', {
    as: 'worker',
    on: (period) => (worker) =>
      worker.since <= period.start &&
      (worker.until === null || worker.until >= period.end),
  })
  .groupBy('id')
  .aggregate({ workerCount: count() })
  .run()
// → [{ id: 'q1', workerCount: 2 }, { id: 'q2', workerCount: 2 }, ...]
```

## Behavior in live queries

`.live()` subscribes to BOTH the left source and all cross-join right-side sources. A mutation on either side re-fires the live query.

## Edge cases & limits

- **Row ceiling:** `CrossJoinTooLargeError` at 50,000 rows. Raise with `{ maxRows: N }`.
- **Lateral ceiling:** charged cumulatively — the ceiling applies to the total post-filter count across ALL left rows, not per-left-row.
- **MV inline `on:` callback:** drift detection disabled; warning emitted at build time. Use `on: { predicate: 'name' }` for MV use.
- **`executePlan()` (pure):** throws if called with a plan containing crossJoin clauses — use `Query.toArray()` instead.
- **Same-vault only:** both collections must be in the same vault. Cross-vault correlation goes through `Noydb.queryAcross`.

## Deferred (out of scope for v3)

`.leftJoin` / outer joins, anti-join, cross-join over MV virtual collections, cost-based query planner, index-aware hash-join downgrade, streaming MV cross-join.

## See also

- [SUBSYSTEMS.md](../../SUBSYSTEMS.md)
- [joins.md](./joins.md) — FK joins (intra-vault, declared `ref()`)
- Showcase 92 — DERIV-SSO-001 end-to-end
