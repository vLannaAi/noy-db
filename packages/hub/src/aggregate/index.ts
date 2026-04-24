/**
 * @noy-db/hub/aggregate — opt-in aggregation + groupBy subsystem.
 *
 * @category capability
 *
 * Groups every file whose reason-for-existing is record reduction:
 *   - `aggregation` (`Aggregation<R>`, `reduceRecords`, `buildLiveAggregation`)
 *   - `groupby` (`GroupedQuery`, `GroupedAggregation`, cardinality guards)
 *   - `reducers` (`count`, `sum`, `avg`, `min`, `max` factories)
 *
 * The root barrel (`@noy-db/hub`) and the `@noy-db/hub/query` subpath
 * continue to re-export the same symbols for backward compatibility
 * with consumers written before the v0.24 relocation. New code should
 * prefer this subpath.
 */

export { withAggregate } from './active.js'
export type { AggregateStrategy } from './strategy.js'

export { Aggregation, reduceRecords, buildLiveAggregation } from './aggregation.js'
export type {
  AggregateSpec,
  AggregateResult,
  AggregationUpstream,
  LiveAggregation,
} from './aggregation.js'

export {
  GroupedQuery,
  GroupedAggregation,
  groupAndReduce,
  resetGroupByWarnings,
  GROUPBY_WARN_CARDINALITY,
  GROUPBY_MAX_CARDINALITY,
} from './groupby.js'
export type { GroupedRow } from './groupby.js'

export { count, sum, avg, min, max } from './reducers.js'
export type { Reducer, ReducerOptions } from './reducers.js'
