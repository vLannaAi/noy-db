/**
 * Aggregation reducers for the query DSL.
 *
 * the reducer protocol plus five built-in factories
 * (`count`, `sum`, `avg`, `min`, `max`) consumed by `Query.aggregate()`
 * and, in the future, `Scan.aggregate()`. Every factory accepts
 * an optional `{ seed }` parameter that is plumbed through the
 * protocol but unused by the executor — that's the load-bearing
 * half of  constraint #2. When partition-aware aggregation
 * lands, the seed carries the previous partition's running total into
 * the next partition without requiring a protocol change.
 *
 * Reducers are intentionally generic over their internal state type
 * `S` so compound reducers (avg keeps `{sum, count}`, min/max keep a
 * value bag) can model internal bookkeeping without leaking the
 * implementation through the accumulator's public shape. `finalize`
 * collapses `S` back into the user-visible `R`.
 *
 * Reducers are pure data — `init` / `step` / `finalize` / optional
 * `remove` are stateless functions that receive and return `S`. This
 * is the shape that admits O(1) incremental maintenance in a future
 * optimization (delta-aware `LiveAggregation` applies `step` or
 * `remove` per delta), without blocking the simpler "full re-run on
 * source change" that ships.
 */

import { readPath } from '../../kernel/query/predicate.js'
import type { MoneyString } from '../../with-shape/money/branded.js'
import type { QueryField } from '../../kernel/types.js'

/**
 * A single reducer: factory-produced, ready to plug into an
 * `.aggregate()` spec.
 *
 * Type parameters:
 *   - `R` — user-visible result type (what the aggregation returns
 *     for this slot, e.g. `number` for `sum()`)
 *   - `S` — internal state type, defaults to `R` for simple reducers
 *     that don't need compound bookkeeping
 *
 * A reducer is stateless: every method is pure over `S`. `init()` is
 * called once per aggregation run to build the initial state; `step()`
 * folds a record into the state; `remove()` (optional) un-folds a
 * record, enabling incremental live maintenance; `finalize()` reads
 * the final answer out of the state at the end of the run.
 */
export interface Reducer<R, S = R> {
  /** Build the initial state for a fresh aggregation run. */
  init(): S
  /** Fold a record into the state. Returns the new state. */
  step(state: S, record: unknown): S
  /**
   * Un-fold a record from the state. Returns the new state.
   *
   * Optional — reducers without `remove` cannot be maintained
   * incrementally and must be re-run from scratch when the underlying
   * record set changes. `sum`, `count`, `avg` implement `remove` in
   * O(1); `min` and `max` implement it in O(N) worst case (when the
   * extremum itself is removed and the next extremum must be
   * recomputed from the remaining contributing values).
   */
  remove?(state: S, record: unknown): S
  /** Collapse the internal state into the user-visible result. */
  finalize(state: S): R
  /**
   * Combine two independent partial states into one (then `finalize` once).
   * Optional. MUST be associative + commutative with `init()` as identity.
   * Never merge finalized results — only states. Enables parallel /
   * hierarchical aggregation (e.g. cross-shard or advisor→firm rollup).
   */
  merge?(a: S, b: S): S
  /**
   * Identifying operation tag stamped by each built-in factory.
   * Used by `summariseAggregateOp` in the introspection walker to
   * render human-readable aggregate descriptors in `dumpSchema()`.
   * Optional so third-party custom reducers are unaffected.
   */
  readonly op?: 'count' | 'sum' | 'avg' | 'min' | 'max'
  /**
   * Field name for field-based reducers (`sum`, `avg`, `min`, `max`).
   * Absent on `count` which aggregates over record count, not a field.
   */
  readonly field?: string
  /**
   * Money-only: target currency for `sum` over a multi-currency money
   * field. Consumed by `wrapMoneyReducers` to convert per-currency
   * subtotals to one figure. Ignored for non-money fields.
   */
  readonly convertTo?: string
  /**
   * Money-only: FX rate map (`'USD->EUR' → rate`) used with `convertTo`.
   */
  readonly fx?: Record<string, number | string>
}

/**
 * Common options accepted by every reducer factory.
 *
 * `seed` — optional initial value for the internal state. **Unused by
 * the executor**, plumbed through the protocol for  constraint
 * #2 (partition-aware aggregation seam). In, partitioned
 * aggregations will pass the previous partition's carry as `seed` so
 * a long time series can be rolled forward one partition at a time
 * without re-aggregating closed partitions.
 *
 * always uses `init()` with the factory's zero value, regardless
 * of whether `seed` was passed. Do not remove the parameter — that's
 * the whole point of having it exist now.
 */
export interface ReducerOptions<TSeed = unknown> {
  /**  constraint #2 — seed is plumbed through but unused in. */
  readonly seed?: TSeed
  /**
   * Money-only (honored by `sum` over a multi-currency money field):
   * convert per-currency subtotals to this currency for a single figure.
   */
  readonly convertTo?: string
  /** Money-only: FX rate map (`'USD->EUR' → rate`) used with `convertTo`. */
  readonly fx?: Record<string, number | string>
}

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

/**
 * Count the number of records that match the query. Ignores field
 * values entirely — the count is over the number of records, not over
 * the number of non-null field values in any column.
 */
export function count(opts?: ReducerOptions<number>): Reducer<number> {
  // Seed captured on the closure but unused at execution time in
  //. The reference in _seed keeps lint happy.
  const _seed = opts?.seed
  void _seed
  return {
    op: 'count',
    init: () => 0,
    step: (state) => state + 1,
    remove: (state) => state - 1,
    finalize: (state) => state,
    merge: (a, b) => a + b,
  }
}

/**
 * Sum a numeric field across all matching records. Non-number values
 * at the field path are coerced to 0 — consumers who want a different
 * behavior (throw, skip, treat as NaN) should filter upstream via
 * `.where()` or write a custom reducer.
 *
 * KNOWN LIMITATION (type imprecision): the declared result type is `number`,
 * but when `field` is a **money** field the runtime returns a decimal *string*
 * (e.g. `'0.30'`, or `{ EUR: '0.30' }` in multi-currency mode) — money sums are
 * BigInt-exact in scaled space and never collapse to a float. The `number` type
 * is therefore a lie for money fields; narrow the result yourself at the call
 * site. A precise fix requires threading money-field declarations into the type
 * system (tracked separately).
 */
export function sum(
  field: string,
  opts?: ReducerOptions<number>,
): Reducer<number> {
  const _seed = opts?.seed
  void _seed
  return {
    op: 'sum',
    field,
    // Money-only metadata, read by `wrapMoneyReducers`. No effect on a
    // generic numeric sum.
    ...(opts?.convertTo !== undefined ? { convertTo: opts.convertTo } : {}),
    ...(opts?.fx !== undefined ? { fx: opts.fx } : {}),
    init: () => 0,
    step: (state, record) => state + readNumber(record, field),
    remove: (state, record) => state - readNumber(record, field),
    finalize: (state) => state,
    merge: (a, b) => a + b,
  }
}

/**
 * Arithmetic mean of a numeric field across all matching records.
 *
 * Returns `null` for an empty result set (zero records is not a
 * well-defined denominator — returning NaN would poison downstream
 * arithmetic, and throwing would force every consumer to wrap in
 * try/catch just to handle "no matches"). Consumers who want an
 * explicit zero should coalesce with `?? 0`.
 *
 * Internal state is `{sum, count}` so the running average can be
 * maintained incrementally — on each delta, both fields update in
 * O(1) and `finalize` divides. Directly storing `avg` as state would
 * not admit incremental removal without also tracking count.
 */
export function avg(
  field: string,
  opts?: ReducerOptions<{ sum: number; count: number }>,
): Reducer<number | null, { sum: number; count: number }> {
  const _seed = opts?.seed
  void _seed
  return {
    op: 'avg',
    field,
    init: () => ({ sum: 0, count: 0 }),
    step: (state, record) => ({
      sum: state.sum + readNumber(record, field),
      count: state.count + 1,
    }),
    remove: (state, record) => ({
      sum: state.sum - readNumber(record, field),
      count: state.count - 1,
    }),
    finalize: (state) => (state.count === 0 ? null : state.sum / state.count),
    merge: (a, b) => ({ sum: a.sum + b.sum, count: a.count + b.count }),
  }
}

interface MinMaxState {
  /**
   * Multiset of contributing field values. Stored as a plain array
   * because we need to support `remove` and a plain array gives us
   * O(1) push + O(N) worst-case removal — which matches the
   * documented min/max removal complexity. A sorted structure would
   * let us drop the O(N) rescan but adds complexity that doesn't
   * need; consumers hitting the O(N) ceiling should file an issue.
   */
  readonly values: number[]
}

function pushValue(state: MinMaxState, value: number): MinMaxState {
  return { values: [...state.values, value] }
}

function removeValue(state: MinMaxState, value: number): MinMaxState {
  // Remove the first matching value — duplicates are fine, we only
  // need to drop one instance per `remove()` call so the multiset
  // count stays consistent with the record count.
  const idx = state.values.indexOf(value)
  if (idx < 0) return state
  const next = state.values.slice()
  next.splice(idx, 1)
  return { values: next }
}

/**
 * Smallest numeric value of a field across all matching records.
 * Returns `null` for an empty result set. See `avg()` for the
 * reasoning on `null` vs NaN vs throwing.
 *
 * Incremental complexity: O(1) for `step`, O(N) worst case for
 * `remove` when the current minimum is removed (the state holds the
 * full multiset of contributing values and `finalize` scans for the
 * new minimum). Consumers with very large result sets and frequent
 * removals of the current extremum should either accept the cost or
 * wait for a future optimization.
 */
export function min(
  field: string,
  opts?: ReducerOptions<number>,
): Reducer<number | null, MinMaxState> {
  const _seed = opts?.seed
  void _seed
  return {
    op: 'min',
    field,
    init: () => ({ values: [] }),
    step: (state, record) => pushValue(state, readNumber(record, field)),
    remove: (state, record) => removeValue(state, readNumber(record, field)),
    finalize: (state) => {
      if (state.values.length === 0) return null
      let out = state.values[0]!
      for (let i = 1; i < state.values.length; i++) {
        const v = state.values[i]!
        if (v < out) out = v
      }
      return out
    },
    merge: (a, b) => ({ values: [...a.values, ...b.values] }),
  }
}

/**
 * Largest numeric value of a field across all matching records.
 * Mirror of `min()` — see that doc for semantics, null-on-empty
 * behavior, and the O(N) removal caveat.
 */
export function max(
  field: string,
  opts?: ReducerOptions<number>,
): Reducer<number | null, MinMaxState> {
  const _seed = opts?.seed
  void _seed
  return {
    op: 'max',
    field,
    init: () => ({ values: [] }),
    step: (state, record) => pushValue(state, readNumber(record, field)),
    remove: (state, record) => removeValue(state, readNumber(record, field)),
    finalize: (state) => {
      if (state.values.length === 0) return null
      let out = state.values[0]!
      for (let i = 1; i < state.values.length; i++) {
        const v = state.values[i]!
        if (v > out) out = v
      }
      return out
    },
    merge: (a, b) => ({ values: [...a.values, ...b.values] }),
  }
}

// ---------------------------------------------------------------------------
// Money-typed reducer constructors
// ---------------------------------------------------------------------------

/**
 * `sum()` for a **declared money field**, typed to match the runtime.
 *
 * `sum()` returns `Reducer<number>`, but `wrapMoneyReducers` (applied at
 * `query.aggregate()` time, once `moneyFields` is known) rewrites any
 * `sum`/`min`/`max` over a money field to a money reducer that finalizes to a
 * `MoneyString` decimal — so the `number` type is a lie for money fields and
 * consumers need a cast at every read site. `moneySum` is the same reducer with
 * the correct `Reducer<MoneyString>` return type, so no read-site cast is
 * needed. It is the caller's assertion that `field` is a money field; use plain
 * `sum()` for non-money fields. (For a multi-currency money field WITHOUT
 * `convertTo`, the runtime returns a per-currency `Record<string, MoneyString>`
 * rather than a single `MoneyString` — pass `convertTo` to collapse to one
 * currency, or read the map at the boundary.)
 */
export function moneySum(field: string, opts?: ReducerOptions<number>): Reducer<MoneyString> {
  // The constructed reducer is the plain numeric `sum`; `wrapMoneyReducers`
  // swaps in the MoneyString-producing money reducer at aggregate() time.
  return sum(field, opts) as unknown as Reducer<MoneyString>
}

/**
 * `min()` for a declared money field, typed `Reducer<MoneyString | null>`
 * (null on an empty result set in fixed-currency mode, mirroring `min()`). See
 * {@link moneySum} for the late-binding rewrite. Note: `convertTo`/`fx` on
 * `opts` have no effect on min/max (cross-currency min/max is unsupported — use
 * {@link moneySum} for currency conversion). In multi-currency mode the runtime
 * returns a per-currency map and an empty result is `{}` rather than `null`.
 */
export function moneyMin(field: string, opts?: ReducerOptions<number>): Reducer<MoneyString | null> {
  return min(field, opts) as unknown as Reducer<MoneyString | null>
}

/**
 * `max()` for a declared money field, typed `Reducer<MoneyString | null>`
 * (null on an empty result set in fixed-currency mode, mirroring `max()`). See
 * {@link moneyMin} for the `convertTo`/`fx` and multi-currency caveats.
 */
export function moneyMax(field: string, opts?: ReducerOptions<number>): Reducer<MoneyString | null> {
  return max(field, opts) as unknown as Reducer<MoneyString | null>
}

// ---------------------------------------------------------------------------
// Builder (typed spec-builder for aggregate())
// ---------------------------------------------------------------------------

/**
 * Typed builder passed to the `aggregate(b => spec)` overload.
 *
 * Each field-taking method narrows `field` to `QueryField<T, S>`, which
 * excludes any field listed in the collection's `sensitive` option at
 * compile time. `count()` carries no field argument and is always allowed.
 *
 * The type parameters match the `Query<T, S>` they come from:
 *   - `T` — the record type of the collection
 *   - `S` — the union of sensitive field keys (defaults to `never`)
 *
 * ONE shared runtime instance (`reducerBuilder`) serves all `T`/`S`
 * combinations — the field narrowing is type-only; the methods delegate
 * directly to the standalone factories.
 */
export interface ReducerBuilder<T, S extends keyof T = never, M extends keyof T & string = never> {
  count(opts?: ReducerOptions<number>): Reducer<number>
  sum<F extends QueryField<T, S>>(field: F, opts?: ReducerOptions<number>): [F] extends [M] ? Reducer<MoneyString> : Reducer<number>
  avg(field: QueryField<T, S>, opts?: ReducerOptions<{ sum: number; count: number }>): ReturnType<typeof avg>
  min<F extends QueryField<T, S>>(field: F, opts?: ReducerOptions<number>): [F] extends [M] ? Reducer<MoneyString | null> : ReturnType<typeof min>
  max<F extends QueryField<T, S>>(field: F, opts?: ReducerOptions<number>): [F] extends [M] ? Reducer<MoneyString | null> : ReturnType<typeof max>
  moneySum(field: QueryField<T, S>, opts?: ReducerOptions<number>): Reducer<MoneyString>
  moneyMin(field: QueryField<T, S>, opts?: ReducerOptions<number>): Reducer<MoneyString | null>
  moneyMax(field: QueryField<T, S>, opts?: ReducerOptions<number>): Reducer<MoneyString | null>
}

/**
 * Shared runtime instance for the `aggregate(b => spec)` builder form.
 *
 * The field-narrowing to `QueryField<T, S>` is type-only — each method
 * delegates directly to its standalone factory. A `(field: string) => R`
 * factory is assignable to a `(field: QueryField<T,S>) => R` method by
 * parameter-contravariance, so this single instance works for all `T`/`S`.
 */
export const reducerBuilder: ReducerBuilder<Record<string, unknown>> = {
  count,
  // The generic F parameter on sum/min/max in the interface is type-only; the
  // standalone factories are plain `(field: string)` functions. With M=never the
  // conditional return collapses to the numeric branch, matching the factories'
  // return type, but TypeScript cannot verify that collapse for a generic method
  // signature — so each factory is cast directly to the method's type.
  sum: sum as ReducerBuilder<Record<string, unknown>>['sum'],
  avg,
  min: min as ReducerBuilder<Record<string, unknown>>['min'],
  max: max as ReducerBuilder<Record<string, unknown>>['max'],
  moneySum, moneyMin, moneyMax,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read a numeric field from a record. Non-number values (null,
 * undefined, strings, objects) coerce to 0 so sum/avg/min/max don't
 * produce NaN on one bad row. Consumers who want strict typing should
 * validate upstream with Standard Schema, which NOYDB already runs on
 * every `put()`.
 */
function readNumber(record: unknown, field: string): number {
  const value = readPath(record, field)
  // Defensive: a `{ amount, currency }` value means a multi-currency
  // money field reached a generic numeric reducer instead of being
  // rewritten by `wrapMoneyReducers` — that would silently produce a
  // wrong total. Surface it loudly rather than coercing to 0.
  if (
    typeof value === 'object' &&
    value !== null &&
    'amount' in value &&
    'currency' in value
  ) {
    throw new Error(
      `aggregate: field "${field}" holds a money value but was not money-aware — ` +
        `declare it in the collection's moneyFields so sum/min/max stay exact`,
    )
  }
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}
