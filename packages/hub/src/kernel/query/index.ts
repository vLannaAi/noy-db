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

export { Query, executePlan, DEFAULT_CROSS_JOIN_MAX_ROWS } from './builder.js'
export type { QueryPlan, QuerySource, OrderBy } from './builder.js'
export type { Operator, Clause, FieldClause, FilterClause, GroupClause, CrossJoinClause } from './predicate.js'
export { evaluateClause, evaluateFieldClause, readPath } from './predicate.js'
// Indexing relocated to `../indexing/` as part of the capability-
// subpath refactor. Re-export from the new home for backward compat
// with consumers reaching into `@noy-db/hub/query`; `@noy-db/hub/indexing`
// is now the preferred import path.
export { CollectionIndexes } from '../../with-lookup/indexing/eager-indexes.js'
export type { IndexDef, HashIndex } from '../../with-lookup/indexing/eager-indexes.js'
export { applyJoins, DEFAULT_JOIN_MAX_ROWS, resetJoinWarnings } from './join.js'
export type { JoinLeg, JoinContext, JoinableSource, JoinStrategy } from './join.js'
export { buildLiveQuery } from './live.js'
export type { LiveQuery, LiveUpstream } from './live.js'
export { ScanBuilder } from './scan-builder.js'
// Calendar group keys (#1350) — `.groupBy(dateTrunc('date', 'month', { timeZone }))`.
export { dateTrunc, isDateTruncKey, truncateDate } from './date-trunc.js'
export type { DateTruncKey, DateTruncUnit, DateTruncOptions, WeekStart, GroupKey } from './date-trunc.js'
export type { ScanPageProvider } from './scan-builder.js'

// Re-export note: QueryPlan, Clause, FilterClause, GroupClause are intentionally
// non-parametric — their `T` was removed for variance reasons. The Query<T> type
// at the public API surface still flows the record type through generic methods.

// ─── Query / aggregate errors ────────────────────────
// Re-exported from the central errors module so subpath consumers can
// `instanceof JoinTooLargeError` without falling back to the root barrel.
export {
  GroupCardinalityError,
  IndexRequiredError,
  IndexWriteFailureError,
  JoinTooLargeError,
  DanglingReferenceError,
  CrossJoinTooLargeError,
  CrossJoinSourceUnknownError,
  FieldNotQueryableError,
} from '../errors.js'
