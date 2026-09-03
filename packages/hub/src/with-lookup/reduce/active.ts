/**
 * Active aggregate strategy factory. Calling `withReduce()` returns
 * an `ReduceStrategy` whose methods construct real `Reduction` /
 * `GroupedQuery` instances and run the streaming reducer protocol.
 *
 * This module is only reachable through the `@noy-db/hub/reduce`
 * subpath — a consumer that never imports the subpath ships none of
 * this (ESM tree-shaking + hub's `"sideEffects": false`).
 */

import { Reduction, reduceRecords } from './reduction.js'
import type { ReduceSpec, ReduceResult } from './reduction.js'
import { GroupedQuery, GroupedQueryN } from './groupby.js'
import { WindowedQuery } from './window.js'
import type { ReduceStrategy } from './strategy.js'

/**
 * Build the default aggregate strategy. Pass into
 * `createNoydb({ reduceStrategy: withReduce() })` to light up
 * `.aggregate()`, `.groupBy()` and `.window()` on `Query` and `ScanBuilder`.
 *
 * @example
 * ```ts
 * import { createNoydb } from '@noy-db/hub'
 * import { withReduce, sum, count } from '@noy-db/hub/reduce'
 *
 * const db = await createNoydb({
 *   store, user, secret,
 *   reduceStrategy: withReduce(),
 * })
 *
 * const totals = invoices.query()
 *   .where('status', '==', 'paid')
 *   .groupBy('clientId')
 *   .aggregate({ amount: sum('amount'), n: count() })
 *   .run()
 * ```
 */
export function withReduce(): ReduceStrategy {
  return {
    aggregate(executeRecords, spec, upstreams) {
      return new Reduction(executeRecords, spec as unknown as ReduceSpec, upstreams) as unknown as Reduction<ReduceResult<typeof spec>>
    },
    groupBy(executeRecords, field, upstreams, dictLabelResolver, via) {
      return new GroupedQuery(executeRecords, field, upstreams, dictLabelResolver, via)
    },
    groupByN(executeRecords, fields, upstreams, via) {
      return new GroupedQueryN(executeRecords, fields, upstreams, undefined, via)
    },
    window(executeRecords, spec, upstreams, via) {
      return new WindowedQuery(executeRecords, spec, upstreams, via)
    },
    async scanAggregate(iter, spec) {
      const collected: unknown[] = []
      for await (const record of iter) collected.push(record)
      return reduceRecords(collected, spec as unknown as ReduceSpec) as unknown as ReduceResult<typeof spec>
    },
  }
}
