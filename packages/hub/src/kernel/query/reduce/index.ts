/**
 * `@noy-db/hub/query/reduce` — **the Reduce group of the query DSL.**
 *
 * ```ts
 * import '@noy-db/hub/query/reduce'   // once, in your app's entry
 *
 * invoices.query()
 *   .where('status', '==', 'paid')
 *   .groupBy(dateTrunc('date', 'month'))
 *   .aggregate({ total: sum('amount') })
 * ```
 *
 * ⭐ **Imported for its side effect** — it patches `aggregate`, `groupBy`,
 * `window` and `distinct` onto `Query.prototype` AND onto
 * `ScanBuilder.prototype`, and merges their types into both. See
 * `../relate/index.ts` for the full note on `package.json`'s `sideEffects`.
 *
 * ⚠️ **The methods, not the ENGINE.** `withReduce()` (`@noy-db/hub/reduce`) is
 * still the strategy that makes them do anything: without it the chain
 * compiles, the method exists, and the call throws the "aggregate is not
 * enabled" error from `NO_REDUCE`. Two different opt-ins, deliberately — one
 * decides whether the code ships, the other whether the service is on.
 */
import type { ReduceSurface } from './methods.js'
import type { ScanReduceSurface } from './scan-methods.js'
import { installReduce } from './install.js'

// ⭐ The statement that makes this file an ENTRY — see `../relate/install.ts`.
installReduce()

declare module '../builder.js' {
  // #1458 — the empty body is the mechanism, not an oversight. Interface
  // merging is what attaches the group's methods to the class declared in
  // `builder.ts` / `scan-builder.ts`; the members come from the `Pick` in the
  // `extends` clause, so writing any here would duplicate signatures that must
  // not be allowed to drift from the implementations.
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface Query<
    T,
    S extends keyof T = never,
    Q extends keyof T & string = never,
    M extends keyof T & string = never,
  > extends ReduceSurface<T, S, Q, M> {}
}

declare module '../scan-builder.js' {
  // #1458 — the empty body is the mechanism, not an oversight. Interface
  // merging is what attaches the group's methods to the class declared in
  // `builder.ts` / `scan-builder.ts`; the members come from the `Pick` in the
  // `extends` clause, so writing any here would duplicate signatures that must
  // not be allowed to drift from the implementations.
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface ScanBuilder<T, S extends keyof T = never, M extends keyof T & string = never>
    extends ScanReduceSurface<T, S, M> {}
}

export { dateTrunc, isDateTruncKey, truncateDate } from './date-trunc.js'
export type { DateTruncKey, DateTruncUnit, DateTruncOptions, WeekStart, GroupKey } from './date-trunc.js'
export { GroupCardinalityError } from '../../errors.js'
