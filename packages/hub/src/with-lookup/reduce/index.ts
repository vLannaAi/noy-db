/**
 * @noy-db/hub/reduce — opt-in reduction + groupBy service.
 *
 * @category capability
 *
 * Groups every file whose reason-for-existing is record reduction:
 *   - `reduction` (`Reduction<R>`, `reduceRecords`, `buildLiveReduction`)
 *   - `groupby` (`GroupedQuery`, `GroupedReduction`, cardinality guards)
 *   - `reducers` (`count`, `countDistinct`, `sum`, `avg`, `min`, `max` factories)
 *
 * The root barrel (`@noy-db/hub`) and the `@noy-db/hub/query` subpath
 * continue to re-export the same symbols for backward compatibility
 * with consumers written before the relocation. New code should
 * prefer this subpath.
 */

export { withReduce } from './active.js'
export type { ReduceStrategy } from './strategy.js'

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
export type { GroupedRow, GroupedRowN } from './groupby.js'

export { count, countDistinct, sum, avg, min, max, moneySum, moneyMin, moneyMax, reducerBuilder, bindDistinctReducers } from './reducers.js'
export type { Reducer, ReducerOptions, ReducerBuilder, CountDistinctState } from './reducers.js'

export {
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

