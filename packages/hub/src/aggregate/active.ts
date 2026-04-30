/**
 * Active aggregate strategy factory. Calling `withAggregate()` returns
 * an `AggregateStrategy` whose methods construct real `Aggregation` /
 * `GroupedQuery` instances and run the streaming reducer protocol.
 *
 * This module is only reachable through the `@noy-db/hub/aggregate`
 * subpath — a consumer that never imports the subpath ships none of
 * this (ESM tree-shaking + hub's `"sideEffects": false`).
 */

import { Aggregation, reduceRecords } from './aggregation.js'
import type { AggregateSpec, AggregateResult } from './aggregation.js'
import { GroupedQuery } from './groupby.js'
import type { AggregateStrategy } from './strategy.js'

/**
 * Build the default aggregate strategy. Pass into
 * `createNoydb({ aggregateStrategy: withAggregate() })` to light up
 * `.aggregate()` and `.groupBy()` on `Query` and `ScanBuilder`.
 *
 * @example
 * ```ts
 * import { createNoydb } from '@noy-db/hub'
 * import { withAggregate, sum, count } from '@noy-db/hub/aggregate'
 *
 * const db = await createNoydb({
 *   store, user, secret,
 *   aggregateStrategy: withAggregate(),
 * })
 *
 * const totals = invoices.query()
 *   .where('status', '==', 'paid')
 *   .groupBy('clientId')
 *   .aggregate({ amount: sum('amount'), n: count() })
 *   .run()
 * ```
 */
export function withAggregate(): AggregateStrategy {
  return {
    aggregate(executeRecords, spec, upstreams) {
      return new Aggregation(executeRecords, spec as unknown as AggregateSpec, upstreams) as unknown as Aggregation<AggregateResult<typeof spec>>
    },
    groupBy(executeRecords, field, upstreams, dictLabelResolver) {
      return new GroupedQuery(executeRecords, field, upstreams, dictLabelResolver)
    },
    async scanAggregate(iter, spec) {
      const collected: unknown[] = []
      for await (const record of iter) collected.push(record)
      return reduceRecords(collected, spec as unknown as AggregateSpec) as unknown as AggregateResult<typeof spec>
    },
  }
}
