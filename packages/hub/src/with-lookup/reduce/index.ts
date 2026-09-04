/**
 * @noy-db/hub/reduce — opt-in reduction + groupBy service.
 *
 * @category capability
 *
 * Groups every file whose reason-for-existing is record reduction:
 *   - `reduction` (`Reduction<R>`, `reduceRecords`, `buildLiveReduction`)
 *   - `groupby` (`GroupedQuery`, `GroupedReduction`, cardinality guards)
 *   - `reducers` (`count`, `countDistinct`, `sum`, `avg`, `min`, `max` factories,
 *     plus the statistical five — `median`, `percentile`, `variance`, `stddev`, `mode`)
 *
 * The root barrel (`@noy-db/hub`) and the `@noy-db/hub/query` subpath
 * continue to re-export the same symbols for backward compatibility
 * with consumers written before the relocation. New code should
 * prefer this subpath.
 */

export { withReduce } from './active.js'
export type { ReduceStrategy, ReduceOptions } from './strategy.js'

export { Reduction, reduceRecords, buildLiveReduction } from './reduction.js'
export type {
  ReduceSpec,
  ReduceResult,
  ReductionUpstream,
  LiveReduction,
} from './reduction.js'

export {
  GroupedQuery,
  GroupedQueryN,
  GroupedReduction,
  groupAndReduce,
  resetGroupByWarnings,
  GROUPBY_WARN_CARDINALITY,
  GROUPBY_MAX_CARDINALITY,
} from './groupby.js'
export type { GroupedRow, GroupedRowN, LiveGroupedReduction } from './groupby.js'

/**
 * #1341 (grouped half) — per-group delta maintenance for
 * `.groupBy().aggregate().live()`. `GroupedMaintainer` is exported so the
 * engine can be driven (and its fallback observed) directly; ordinary
 * consumers reach it through `LiveGroupedReduction.maintenanceStats()`.
 */
export { GroupedMaintainer } from './incremental-group.js'
export type { GroupMaintenanceStats, GroupedMaintainerConfig } from './incremental-group.js'

export { count, countDistinct, sum, avg, min, max, moneySum, moneyMin, moneyMax, reducerBuilder, bindDistinctReducers } from './reducers.js'
export type { Reducer, ReducerOptions, ReducerBuilder, CountDistinctState } from './reducers.js'

/** The statistical reducers (#1353) and the money variants of the two quantile ones. */
export { median, percentile, variance, stddev, mode, moneyMedian, moneyPercentile } from './reducers.js'
/**
 * States and option bags named by the signatures directly above (#843a) — a
 * caller must be able to annotate `variance()`'s state or pass
 * `{ approx: true }` without reaching past the subpath.
 */
export type {
  WelfordState,
  DispersionOptions,
  PercentileOptions,
  QuantileState,
  ExactQuantileState,
  TDigestState,
  Centroid,
  ModeState,
} from './reducers.js'

export {
  withWindow,
  rowNumber,
  rank,
  lag,
  lead,
  runningSum,
  runningMoneySum,
  applyWindow,
  WindowedQuery,
  WindowSelection,
} from './window.js'
export type {
  WindowFactory,
  WindowSpec,
  WindowOrderInput,
  WindowFn,
  WindowSelectSpec,
  WindowRow,
} from './window.js'

/** The un-opted-in stub for this service — exported so callers can compare against it (#844). */
export { NO_REDUCE } from './strategy.js'

/**
 * Types named by this entry's own signatures (#843a). `min`/`max` return a
 * `MinMaxState`, and the money reducers speak `MoneyString`; both must be
 * nameable from the entry that exports the functions, or a caller can invoke
 * them and cannot annotate the result.
 */
export type { MinMaxState } from './reducers.js'
export type { MoneyString } from '../../via/money/branded.js'
export type { MoneyDescriptor } from '../../via/money/descriptor.js'
/** Named by `bindDistinctReducers`'s signature (#1347) — see #843a above. */
export type { BucketKeyCanonicalizer } from '../../kernel/query/distinct-key.js'

