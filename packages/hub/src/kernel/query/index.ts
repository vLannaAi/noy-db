/**
 * `@noy-db/hub/query` — **Find**, the always-on group of the query DSL (#1458).
 *
 * ```ts
 * import { Query } from '@noy-db/hub/query'
 * invoices.query().where('status', '==', 'paid').orderBy('date', 'desc').limit(20).toArray()
 * ```
 *
 * Predicate → sort → slice → hydrate, over one source: `where` (ten
 * operators), `or`, `and`, `filter`, `wherePredicate`, `orderBy`, `limit`,
 * `offset`, `page`, `after`, `first`, `toArray`, `count`, `exists`, `ids`,
 * `toPlan`. Nothing here reaches a second collection, folds a result set, or
 * re-runs on change.
 *
 * ⭐ **The other three groups are subpaths, and each is one import:**
 *
 * | group | import | brings |
 * |---|---|---|
 * | Live | `@noy-db/hub/query/live` | `subscribe`, `live` |
 * | Reduce | `@noy-db/hub/query/reduce` | `aggregate`, `groupBy`, `window`, `distinct`, `dateTrunc` |
 * | Relate | `@noy-db/hub/query/relate` | the joins, `traverse`, `explain` |
 *
 * The import is a SIDE EFFECT — it patches the methods onto `Query.prototype`
 * and merges their types into `Query`, so one line at your app's entry serves
 * the whole program. Calling a method whose group is not imported does not
 * compile; if it reaches runtime through a cast, it throws
 * {@link QueryExtensionMissingError} naming the subpath.
 *
 * ⚠️ **`@noy-db/hub` (the root barrel) imports all three**, so a consumer on
 * the root barrel needs none of this and sees no change. The saving is for
 * consumers who import this subpath directly.
 */

export { Query, executePlan } from './builder.js'
export type { QueryPlan, QuerySource, OrderBy } from './builder.js'
export type { Operator, Clause, FieldClause, FilterClause, GroupClause, CrossJoinClause } from './predicate.js'
export { evaluateClause, evaluateFieldClause, readPath } from './predicate.js'
// Indexing relocated to `../indexing/` as part of the capability-
// subpath refactor. Re-export from the new home for backward compat
// with consumers reaching into `@noy-db/hub/query`; `@noy-db/hub/indexing`
// is now the preferred import path.
export { CollectionIndexes } from '../../with-lookup/indexing/eager-indexes.js'
export type { IndexDef, HashIndex } from '../../with-lookup/indexing/eager-indexes.js'
export { ScanBuilder } from './scan-builder.js'
export type { ScanPageProvider, MultiReduceResult } from './scan-builder.js'

// Re-export note: QueryPlan, Clause, FilterClause, GroupClause are intentionally
// non-parametric — their `T` was removed for variance reasons. The Query<T> type
// at the public API surface still flows the record type through generic methods.

// ─── Find's errors ───────────────────────────────────────────────────────
// Re-exported from the central errors module so subpath consumers can
// `instanceof` them without falling back to the root barrel.
//
// ⚠️ The JOIN errors moved to `@noy-db/hub/query/relate` and the aggregate
// ones to `@noy-db/hub/query/reduce`, with their groups. An `instanceof
// JoinTooLargeError` in a file that never imports `/relate` was checking for
// something that could not happen there.
export {
  IndexRequiredError,
  IndexWriteFailureError,
  FieldNotQueryableError,
  UnsafePatternError,
  QueryExtensionMissingError,
} from '../errors.js'
