/**
 * Aggregation reducers for the query DSL.
 *
 * v0.6 #97 — the reducer protocol plus five built-in factories
 * (`count`, `sum`, `avg`, `min`, `max`) consumed by `Query.aggregate()`
 * and, in the future, `Scan.aggregate()` (#99). Every factory accepts
 * an optional `{ seed }` parameter that is plumbed through the
 * protocol but unused by the v0.6 executor — that's the load-bearing
 * half of #87 constraint #2. When v0.10 partition-aware aggregation
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
 * source change" that v0.6 ships.
 */

import { readPath } from './predicate.js'

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
}

/**
 * Common options accepted by every reducer factory.
 *
 * `seed` — optional initial value for the internal state. **Unused by
 * the v0.6 executor**, plumbed through the protocol for #87 constraint
 * #2 (partition-aware aggregation seam). In v0.10, partitioned
 * aggregations will pass the previous partition's carry as `seed` so
 * a long time series can be rolled forward one partition at a time
 * without re-aggregating closed partitions.
 *
 * v0.6 always uses `init()` with the factory's zero value, regardless
 * of whether `seed` was passed. Do not remove the parameter — that's
 * the whole point of having it exist now.
 */
export interface ReducerOptions<TSeed = unknown> {
  /** #87 constraint #2 — seed is plumbed through but unused in v0.6. */
  readonly seed?: TSeed
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
  // Seed captured on the closure but unused at execution time in v0.6
  // (#87 constraint #2). The reference in _seed keeps lint happy.
  const _seed = opts?.seed
  void _seed
  return {
    init: () => 0,
    step: (state) => state + 1,
    remove: (state) => state - 1,
    finalize: (state) => state,
  }
}

/**
 * Sum a numeric field across all matching records. Non-number values
 * at the field path are coerced to 0 — consumers who want a different
 * behavior (throw, skip, treat as NaN) should filter upstream via
 * `.where()` or write a custom reducer.
 */
export function sum(
  field: string,
  opts?: ReducerOptions<number>,
): Reducer<number> {
  const _seed = opts?.seed
  void _seed
  return {
    init: () => 0,
    step: (state, record) => state + readNumber(record, field),
    remove: (state, record) => state - readNumber(record, field),
    finalize: (state) => state,
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
  }
}

interface MinMaxState {
  /**
   * Multiset of contributing field values. Stored as a plain array
   * because we need to support `remove` and a plain array gives us
   * O(1) push + O(N) worst-case removal — which matches the
   * documented min/max removal complexity. A sorted structure would
   * let us drop the O(N) rescan but adds complexity that v0.6 doesn't
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
  }
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
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}
