/**
 * Query DSL — barrel export.
 *
 * Public API:
 *   - `Query<T>` — chainable, immutable builder
 *   - `QuerySource<T>` — interface for record sources (Collection implements it)
 *   - `Operator` — comparison operators accepted by `where()`
 *   - `QueryPlan<T>` — serializable plan object
 *
 * Tree-shakeable: importing this barrel without calling `query()` does not
 * pull in the executor's runtime, since `Query` is the only entry point.
 */

export { Query, executePlan } from './builder.js'
export type { QueryPlan, QuerySource, OrderBy } from './builder.js'
export type { Operator, Clause, FieldClause, FilterClause, GroupClause } from './predicate.js'
export { evaluateClause, evaluateFieldClause, readPath } from './predicate.js'
export { CollectionIndexes } from './indexes.js'
export type { IndexDef, HashIndex } from './indexes.js'
export { applyJoins, DEFAULT_JOIN_MAX_ROWS, resetJoinWarnings } from './join.js'
export type { JoinLeg, JoinContext, JoinableSource, JoinStrategy } from './join.js'
export { buildLiveQuery } from './live.js'
export type { LiveQuery, LiveUpstream } from './live.js'
export { count, sum, avg, min, max } from './reducers.js'
export type { Reducer, ReducerOptions } from './reducers.js'
export { Aggregation, reduceRecords } from './aggregate.js'
export type {
  AggregateSpec,
  AggregateResult,
  AggregationUpstream,
  LiveAggregation,
} from './aggregate.js'

// Re-export note: QueryPlan, Clause, FilterClause, GroupClause are intentionally
// non-parametric — their `T` was removed for variance reasons. The Query<T> type
// at the public API surface still flows the record type through generic methods.
