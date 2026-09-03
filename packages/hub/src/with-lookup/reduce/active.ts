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
import type { ReduceOptions, ReduceStrategy } from './strategy.js'

/**
 * Build the default aggregate strategy. Pass into
 * `createNoydb({ reduceStrategy: withReduce() })` to light up
 * `.aggregate()` and `.groupBy()` on `Query` and `ScanBuilder`.
 * Pass `{ window: withWindow() }` to additionally light up `.window()` —
 * a second opt-in, because the window engine is ~900 gzipped bytes that a
 * pure-aggregation consumer should not carry (see `window.ts` § "Opting in").
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
/**
 * ⚠️ Kept DELIBERATELY terse. This string lands in the `analytics` bundle
 * scenario — every consumer who opts into aggregation carries it whether or
 * not they ever window — and the measurement is not academic: the first draft
 * of this message alone was ~200 of the ~208 gzipped bytes this stub costs.
 * Say the fix and where the symbol lives; the reasoning is in `window.ts`.
 */
const WINDOW_NOT_ENABLED = new Error(
  'Query.window() needs withReduce({ window: withWindow() }) from @noy-db/hub/reduce.',
)

export function withReduce(opts?: ReduceOptions): ReduceStrategy {
  const windowFactory = opts?.window
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
      // ⛔ Deliberately NOT `new WindowedQuery(...)`. Naming the class here
      // makes the whole window engine reachable from `withReduce`, which the
      // bundler cannot drop — measured at +92% on the `analytics` scenario.
      // The factory arrives from the caller's `withWindow()`, so the engine
      // links only for a consumer that asked for it.
      if (!windowFactory) throw WINDOW_NOT_ENABLED
      return windowFactory(executeRecords, spec, upstreams, via)
    },
    async scanAggregate(iter, spec) {
      const collected: unknown[] = []
      for await (const record of iter) collected.push(record)
      return reduceRecords(collected, spec as unknown as ReduceSpec) as unknown as ReduceResult<typeof spec>
    },
  }
}
