/**
 * Reduction reducers for the query DSL.
 *
 * the reducer protocol plus five built-in factories
 * (`count`, `sum`, `avg`, `min`, `max`) consumed by `Query.aggregate()`
 * and, in the future, `Scan.aggregate()`. Every factory accepts
 * an optional `{ seed }` parameter that is plumbed through the
 * protocol but unused by the executor — that's the load-bearing
 * half of  constraint #2. When partition-aware reduction
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
 * optimization (delta-aware `LiveReduction` applies `step` or
 * `remove` per delta), without blocking the simpler "full re-run on
 * source change" that ships.
 */

import { readPath } from '../../kernel/query/predicate.js'
import { distinctKeyOf, type BucketKeyCanonicalizer } from '../../kernel/query/distinct-key.js'
import type { MoneyString } from '../../via/money/branded.js'
import type { QueryField } from '../../kernel/types.js'

/**
 * A single reducer: factory-produced, ready to plug into an
 * `.aggregate()` spec.
 *
 * Type parameters:
 *   - `R` — user-visible result type (what the reduction returns
 *     for this slot, e.g. `number` for `sum()`)
 *   - `S` — internal state type, defaults to `R` for simple reducers
 *     that don't need compound bookkeeping
 *
 * A reducer is stateless: every method is pure over `S`. `init()` is
 * called once per reduction run to build the initial state; `step()`
 * folds a record into the state; `remove()` (optional) un-folds a
 * record, enabling incremental live maintenance; `finalize()` reads
 * the final answer out of the state at the end of the run.
 */
export interface Reducer<R, S = R> {
  /** Build the initial state for a fresh reduction run. */
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
   * hierarchical reduction (e.g. cross-shard or advisor→firm rollup).
   */
  merge?(a: S, b: S): S
  /**
   * Identifying operation tag stamped by each built-in factory.
   * Used by `summariseAggregateOp` in the introspection walker to
   * render human-readable aggregate descriptors in `dumpSchema()`.
   * Optional so third-party custom reducers are unaffected.
   */
  readonly op?:
    | 'count'
    | 'countDistinct'
    | 'sum'
    | 'avg'
    | 'min'
    | 'max'
    | 'median'
    | 'percentile'
    | 'variance'
    | 'stddev'
    | 'mode'
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
  /**
   * Quantile reducers only (#1353): the probability in `[0, 1]`. Carried as
   * metadata so `wrapMoneyReducers` can rebuild the reducer on the exact
   * BigInt path — a rewrite that must reproduce the SAME p, not guess one.
   * `median` stamps `0.5`.
   */
  readonly p?: number
  /**
   * `percentile` only (#1353): `true` when the reducer is the bounded-memory
   * t-digest rather than the exact O(n) one. Read by `wrapMoneyReducers`,
   * which refuses it over a money field — a t-digest is a float structure.
   */
  readonly approx?: boolean
}

/**
 * Common options accepted by every reducer factory.
 *
 * `seed` — optional initial value for the internal state. **Unused by
 * the executor**, plumbed through the protocol for  constraint
 * #2 (partition-aware reduction seam). In, partitioned
 * reductions will pass the previous partition's carry as `seed` so
 * a long time series can be rolled forward one partition at a time
 * without re-reducing closed partitions.
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
 * Multiset state behind {@link countDistinct}: canonical distinct key →
 * how many records currently contribute it. The COUNT, not a bare Set, is
 * what makes `remove()` correct — dropping one of three records holding
 * `'c1'` must not drop `'c1'` from the distinct set.
 */
export interface CountDistinctState {
  readonly counts: ReadonlyMap<string, number>
}

/**
 * Number of DISTINCT non-nullish values of `field` across matching records
 * (#1347) — `COUNT(DISTINCT field)`.
 *
 * Distinctness is decided on the canonical index key, not on the stored
 * string and not on any formatted rendering, so a money field's `'0100'` and
 * `'100'` count once; see `kernel/query/distinct-key.ts` for why, and for why
 * nullish values are excluded rather than counted as a value of their own.
 *
 * The canonicalizer is bound LATE, by {@link bindDistinctReducers}, at the
 * same two points `wrapReducers` runs — a bare `countDistinct('amount')` in a
 * spec has no way to know which collection it will be reduced against, so a
 * constructor argument would be a footgun. Unbound, it falls back to the raw
 * stringified key, which is exactly what a non-Via field wants.
 *
 * Incremental complexity: O(1) `step` and `remove`, O(1) `finalize`.
 */
export function countDistinct(
  field: string,
  opts?: ReducerOptions<number> & { readonly canonicalize?: BucketKeyCanonicalizer },
): Reducer<number, CountDistinctState> {
  const _seed = opts?.seed
  void _seed
  const via = opts?.canonicalize
  const keyOf = (record: unknown): string | undefined =>
    distinctKeyOf(field, readPath(record, field), via)
  return {
    op: 'countDistinct',
    field,
    init: () => ({ counts: new Map() }),
    step: (state, record) => {
      const key = keyOf(record)
      if (key === undefined) return state
      const counts = new Map(state.counts)
      counts.set(key, (counts.get(key) ?? 0) + 1)
      return { counts }
    },
    remove: (state, record) => {
      const key = keyOf(record)
      if (key === undefined) return state
      const current = state.counts.get(key)
      if (current === undefined) return state
      const counts = new Map(state.counts)
      if (current <= 1) counts.delete(key)
      else counts.set(key, current - 1)
      return { counts }
    },
    finalize: (state) => state.counts.size,
    merge: (a, b) => {
      const counts = new Map(a.counts)
      for (const [k, n] of b.counts) counts.set(k, (counts.get(k) ?? 0) + n)
      return { counts }
    },
  }
}

/**
 * Rebind every `countDistinct` reducer in a spec to a Via canonicalizer.
 *
 * Called wherever `ViaPipeline.wrapReducers` is called — the two are the same
 * seam, kept separate only because `wrapReducers` folds over BINDINGS (money
 * rewriting its own `sum`) while this one is brand-agnostic: any binding that
 * canonicalizes an index key canonicalizes a distinct key, by definition.
 *
 * Returns the spec unchanged when there is nothing to bind, so the common
 * path allocates nothing.
 */
export function bindDistinctReducers<Spec>(spec: Spec, via: BucketKeyCanonicalizer | undefined): Spec {
  if (!via) return spec
  const entries = Object.entries(spec as Record<string, Reducer<unknown, unknown>>)
  let changed = false
  const out: Record<string, unknown> = {}
  for (const [key, reducer] of entries) {
    if (reducer?.op === 'countDistinct' && typeof reducer.field === 'string') {
      out[key] = countDistinct(reducer.field, { canonicalize: via })
      changed = true
    } else {
      out[key] = reducer
    }
  }
  return changed ? (out as Spec) : spec
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

export interface MinMaxState {
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
// Statistical reducers (#1353)
// ---------------------------------------------------------------------------

/**
 * ⚠️ MEMORY, stated once for the whole section.
 *
 * `variance` / `stddev` are **streaming** — three numbers of state regardless
 * of how many records pass through, so they are free in a `.groupBy()` and
 * free as a running window aggregate (#1349).
 *
 * `median`, `percentile` (exact) and `mode` are **O(n) per group**: the first
 * two keep every contributing value, `mode` keeps one entry per distinct value.
 * Multiplied by the `GROUPBY_MAX_CARDINALITY` ceiling (100,000 groups) that is
 * the one place in the reduce vocabulary where a legal query can exhaust
 * memory, so it is not "free like `sum`". Two ways out, in order of preference:
 * narrow with `.where()` before grouping, or pass
 * `percentile(field, p, { approx: true })` for the bounded-memory t-digest —
 * O(compression) state per group instead of O(n), at a small, measured error.
 *
 * Unlike `count` / `sum` / `min` / `max`, whose states are copied on every
 * `step`, the reducers in this section MUTATE their state in place and return
 * it (the shape `via/money/money-reducer.ts` already uses). Copy-on-write here
 * would make a median over a group quadratic in the group size, which is a
 * worse bug than the inconsistency. States are built fresh by `init()` on every
 * reduction run and never shared, so the mutation is not observable — except
 * through `merge`, which therefore always returns a NEW state.
 */

/**
 * Welford state behind {@link variance} and {@link stddev}.
 *
 * `m2` is the running sum of squared deviations **from the running mean**, not
 * a sum of squares — that is the entire point. The textbook one-pass identity
 * `(Σx² − (Σx)²/n)` subtracts two enormous nearly-equal numbers, and on an
 * accounting column (invoice totals clustered around a large figure) the
 * cancellation eats every significant digit: four totals just over 1e9 with a
 * true sample variance of 30 come back as **−170.67**, so `stddev` is `NaN`.
 * Welford never forms the large intermediate.
 */
export interface WelfordState {
  /** Number of contributing records. */
  readonly n: number
  /** Running arithmetic mean. */
  readonly mean: number
  /** Running sum of squared deviations from `mean`. */
  readonly m2: number
}

/** Options for {@link variance} / {@link stddev}. */
export interface DispersionOptions extends ReducerOptions<WelfordState> {
  /**
   * `true` → **population** dispersion (÷ n). Default `false` → **sample**
   * dispersion (÷ n−1), which is Postgres's `var_samp` / `stddev_samp`, the
   * unqualified spelling in every SQL dialect this library is measured
   * against.
   *
   * The divisor is not cosmetic and the wrong one is a silently wrong answer,
   * so the two disagree loudly at n = 1: sample is `null` (n−1 = 0 is not a
   * denominator), population is `0`.
   */
  readonly population?: boolean
}

function welfordReducer(
  op: 'variance' | 'stddev',
  field: string,
  population: boolean,
): Reducer<number | null, WelfordState> {
  return {
    op,
    field,
    init: () => ({ n: 0, mean: 0, m2: 0 }),
    step: (state, record) => {
      const x = readNumber(record, field)
      const n = state.n + 1
      const delta = x - state.mean
      const mean = state.mean + delta / n
      // (x - mean) uses the UPDATED mean; delta the previous one. Using the
      // same mean twice is the naive formula wearing a Welford costume.
      return { n, mean, m2: state.m2 + delta * (x - mean) }
    },
    remove: (state, record) => {
      const x = readNumber(record, field)
      const n = state.n - 1
      if (n <= 0) return { n: 0, mean: 0, m2: 0 }
      const mean = (state.mean * state.n - x) / n
      return { n, mean, m2: state.m2 - (x - state.mean) * (x - mean) }
    },
    // Chan et al.'s parallel combination — the reason a reduction can be
    // sharded and rolled up without re-reading the leaves.
    merge: (a, b) => {
      if (a.n === 0) return b
      if (b.n === 0) return a
      const n = a.n + b.n
      const delta = b.mean - a.mean
      return {
        n,
        mean: a.mean + (delta * b.n) / n,
        m2: a.m2 + b.m2 + (delta * delta * a.n * b.n) / n,
      }
    },
    finalize: (state) => {
      const divisor = population ? state.n : state.n - 1
      if (divisor <= 0) return null
      const v = state.m2 / divisor
      return op === 'stddev' ? Math.sqrt(v) : v
    },
  }
}

/**
 * Variance of a numeric field — **sample (n−1) by default**, `{ population:
 * true }` for the n divisor. See {@link DispersionOptions}.
 *
 * Streaming (Welford): O(1) state, O(1) `step`, O(1) `remove`, associative
 * `merge`. Safe as a running window aggregate.
 *
 * `null` for an empty result set, and `null` for a single record in sample
 * mode (population mode returns `0`) — see `avg()` for why null rather than
 * `NaN` or a throw.
 *
 * ⛔ Not available over a declared money field: dispersion is inherently a
 * float computation, so `wrapMoneyReducers` refuses rather than let
 * `readNumber` read a scaled-integer string as `0`.
 */
export function variance(field: string, opts?: DispersionOptions): Reducer<number | null, WelfordState> {
  const _seed = opts?.seed
  void _seed
  return welfordReducer('variance', field, opts?.population === true)
}

/**
 * Standard deviation of a numeric field — the square root of {@link variance},
 * with the same divisor rule, the same empty/single-element answers, the same
 * streaming Welford state, and the same money refusal.
 */
export function stddev(field: string, opts?: DispersionOptions): Reducer<number | null, WelfordState> {
  const _seed = opts?.seed
  void _seed
  return welfordReducer('stddev', field, opts?.population === true)
}

/**
 * Exact quantile state: every contributing value, unsorted (sorting happens
 * once, in `finalize`, on a copy — so a running window aggregate does not
 * disturb the multiset it is still being appended to).
 */
export interface ExactQuantileState {
  readonly kind: 'exact'
  readonly values: number[]
}

/** One t-digest centroid: a weighted summary of `count` nearby values. */
export interface Centroid {
  readonly mean: number
  readonly count: number
}

/**
 * t-digest state: compressed centroids plus a small unmerged buffer.
 *
 * Implemented here rather than taken from npm — `hub/src/**` adds no
 * dependency, and this one is ~60 lines.
 */
export interface TDigestState {
  readonly kind: 'tdigest'
  centroids: Centroid[]
  buffer: number[]
  n: number
}

/** State of {@link median} / {@link percentile}; the arm depends on `approx`. */
export type QuantileState = ExactQuantileState | TDigestState

/** Options for {@link percentile}. */
export interface PercentileOptions extends ReducerOptions<number> {
  /**
   * `true` → bounded-memory t-digest instead of keeping every value. O(1)-ish
   * state per group, at a small error (under 1% of the value range at every
   * quantile on a 10k uniform scan, exact at p = 0 and p = 1).
   *
   * The trade is real: an approximate reducer cannot `remove()`, so it does
   * not participate in incremental live maintenance, and it is refused over a
   * money field.
   */
  readonly approx?: boolean
}

function assertProbability(op: string, p: number): void {
  if (!Number.isFinite(p) || p < 0 || p > 1) {
    throw new Error(`${op}(): p must be a number between 0 and 1, got ${p}.`)
  }
}

function asExact(state: QuantileState): ExactQuantileState {
  if (state.kind !== 'exact') throw new Error('percentile: expected the exact quantile state')
  return state
}

function asDigest(state: QuantileState): TDigestState {
  if (state.kind !== 'tdigest') throw new Error('percentile: expected the t-digest state')
  return state
}

/**
 * `percentile_cont` over an in-memory multiset — the INTERPOLATING definition.
 *
 * `x = p * (n − 1)`; when `x` lands between two ranks the answer is the linear
 * blend of the two neighbours. So the median of `[1,2,3,4]` is `2.5`, a value
 * that is not in the input. `percentile_disc` would answer `2`. Postgres names
 * both; this library ships only `_cont`, because it is the one `median` has to
 * agree with — a `median` that returned `2` while `percentile(f, 0.5)`
 * returned `2.5` would be the worse surprise.
 */
function quantileOf(values: readonly number[], p: number): number | null {
  const n = values.length
  if (n === 0) return null
  if (n === 1) return values[0]!
  const sorted = [...values].sort((a, b) => a - b)
  const x = p * (n - 1)
  const lo = Math.floor(x)
  const frac = x - lo
  if (frac === 0) return sorted[lo]!
  return sorted[lo]! + (sorted[lo + 1]! - sorted[lo]!) * frac
}

/** Centroid budget. Larger ⇒ more accurate and more memory; 100 is the usual default. */
const TDIGEST_COMPRESSION = 100
/** Unmerged values tolerated before a compression pass. */
const TDIGEST_BUFFER = 256

/**
 * Fold the buffer into the centroid list and compress.
 *
 * The size rule is the standard one: a centroid sitting at estimated quantile
 * `q` may hold at most `4·n·q·(1−q)/compression` values, which is ~0 at the
 * tails and widest in the middle. That is what keeps p = 0 and p = 1 EXACT
 * (the extreme centroids stay singletons) while the middle compresses hard.
 */
function tdigestFlush(state: TDigestState, force = false): void {
  if (state.buffer.length === 0 && !force) return
  const all: Centroid[] = state.centroids.concat(state.buffer.map((mean) => ({ mean, count: 1 })))
  state.buffer = []
  if (all.length === 0) return
  all.sort((a, b) => a.mean - b.mean)
  const total = state.n
  const out: Centroid[] = []
  let curMean = all[0]!.mean
  let curCount = all[0]!.count
  let before = 0
  for (let i = 1; i < all.length; i++) {
    const c = all[i]!
    const q = (before + curCount + c.count / 2) / total
    const limit = (4 * total * q * (1 - q)) / TDIGEST_COMPRESSION
    if (curCount + c.count <= Math.max(limit, 1)) {
      const count = curCount + c.count
      curMean = curMean + ((c.mean - curMean) * c.count) / count
      curCount = count
    } else {
      out.push({ mean: curMean, count: curCount })
      before += curCount
      curMean = c.mean
      curCount = c.count
    }
  }
  out.push({ mean: curMean, count: curCount })
  state.centroids = out
}

/**
 * Estimate the `p` quantile off the centroids, interpolating between centroid
 * CENTRES so the answer degrades to `quantileOf` exactly when no compression
 * has happened (every centroid a singleton ⇒ its centre is its rank).
 */
function tdigestQuantile(state: TDigestState, p: number): number | null {
  tdigestFlush(state)
  const cs = state.centroids
  if (cs.length === 0) return null
  if (cs.length === 1) return cs[0]!.mean
  const centres: number[] = []
  let acc = 0
  for (const c of cs) {
    centres.push(acc + (c.count - 1) / 2)
    acc += c.count
  }
  const target = p * (state.n - 1)
  const last = cs.length - 1
  if (target <= centres[0]!) return cs[0]!.mean
  if (target >= centres[last]!) return cs[last]!.mean
  for (let i = 0; i < last; i++) {
    const a = centres[i]!
    const b = centres[i + 1]!
    if (target <= b) {
      const t = b === a ? 0 : (target - a) / (b - a)
      return cs[i]!.mean + (cs[i + 1]!.mean - cs[i]!.mean) * t
    }
  }
  return cs[last]!.mean
}

function exactQuantileReducer(
  op: 'median' | 'percentile',
  field: string,
  p: number,
): Reducer<number | null, QuantileState> {
  return {
    op,
    field,
    p,
    init: (): QuantileState => ({ kind: 'exact', values: [] }),
    step: (state, record) => {
      asExact(state).values.push(readNumber(record, field))
      return state
    },
    remove: (state, record) => {
      const values = asExact(state).values
      const idx = values.indexOf(readNumber(record, field))
      if (idx >= 0) values.splice(idx, 1)
      return state
    },
    merge: (a, b) => ({ kind: 'exact', values: [...asExact(a).values, ...asExact(b).values] }),
    finalize: (state) => quantileOf(asExact(state).values, p),
  }
}

function approxQuantileReducer(field: string, p: number): Reducer<number | null, QuantileState> {
  return {
    op: 'percentile',
    field,
    p,
    approx: true,
    init: (): QuantileState => ({ kind: 'tdigest', centroids: [], buffer: [], n: 0 }),
    step: (state, record) => {
      const d = asDigest(state)
      d.buffer.push(readNumber(record, field))
      d.n += 1
      if (d.buffer.length >= TDIGEST_BUFFER) tdigestFlush(d)
      return state
    },
    // No `remove`: a centroid has forgotten which values it absorbed, so an
    // un-fold is not expressible. Deliberate, and asserted by a test.
    merge: (a, b) => {
      const A = asDigest(a)
      const B = asDigest(b)
      const s: TDigestState = {
        kind: 'tdigest',
        centroids: [...A.centroids, ...B.centroids],
        buffer: [...A.buffer, ...B.buffer],
        n: A.n + B.n,
      }
      tdigestFlush(s, true)
      return s
    },
    finalize: (state) => tdigestQuantile(asDigest(state), p),
  }
}

/**
 * Median of a numeric field — exactly `percentile(field, 0.5)`, and therefore
 * **`percentile_cont`**: an even-sized input INTERPOLATES (`[1,2,3,4]` → `2.5`)
 * rather than picking a member. See {@link quantileOf} for why only the
 * interpolating definition ships.
 *
 * `null` on an empty result set. O(n) memory per group — read the memory note
 * at the top of this section before using it under `.groupBy()`.
 *
 * Over a declared money field the reducer is rewritten onto the exact BigInt
 * path; {@link moneyMedian} is the same call with the honest return type.
 */
export function median(field: string, opts?: ReducerOptions<number>): Reducer<number | null, QuantileState> {
  const _seed = opts?.seed
  void _seed
  return exactQuantileReducer('median', field, 0.5)
}

/**
 * The `p` quantile of a numeric field, `p ∈ [0, 1]`, by the **`percentile_cont`
 * (interpolating)** definition — `percentile(f, 0.9)` over `1..10` is `9.1`,
 * not `9`. `p = 0` is the minimum and `p = 1` the maximum, exactly.
 *
 * Throws for a `p` outside `[0, 1]` or a non-finite one, at construction time.
 *
 * Exact by default and O(n) per group; pass `{ approx: true }` for the
 * bounded-memory t-digest (see {@link PercentileOptions}).
 */
export function percentile(
  field: string,
  p: number,
  opts?: PercentileOptions,
): Reducer<number | null, QuantileState> {
  assertProbability('percentile', p)
  const _seed = opts?.seed
  void _seed
  return opts?.approx === true ? approxQuantileReducer(field, p) : exactQuantileReducer('percentile', field, p)
}

/** Frequency table behind {@link mode}: value → how many records hold it. */
export interface ModeState {
  readonly counts: Map<number, number>
}

/**
 * Most frequent value of a numeric field.
 *
 * **Tie rule: the LOWEST value wins.** Two values with equal frequency is the
 * common case on real data, not an edge case, and the alternatives are worse:
 * "first seen" makes the answer depend on store iteration order (so the same
 * query answers differently after a compaction, and `merge` stops being
 * commutative), and "all of them" changes the result TYPE based on the data.
 * Lowest-wins is total, order-independent, and mergeable.
 *
 * `null` on an empty result set. O(distinct values) memory per group.
 *
 * ⛔ Numeric only, and not available over a declared money field.
 */
export function mode(field: string, opts?: ReducerOptions<number>): Reducer<number | null, ModeState> {
  const _seed = opts?.seed
  void _seed
  return {
    op: 'mode',
    field,
    init: () => ({ counts: new Map<number, number>() }),
    step: (state, record) => {
      const v = readNumber(record, field)
      state.counts.set(v, (state.counts.get(v) ?? 0) + 1)
      return state
    },
    remove: (state, record) => {
      const v = readNumber(record, field)
      const current = state.counts.get(v)
      if (current === undefined) return state
      if (current <= 1) state.counts.delete(v)
      else state.counts.set(v, current - 1)
      return state
    },
    merge: (a, b) => {
      const counts = new Map(a.counts)
      for (const [v, c] of b.counts) counts.set(v, (counts.get(v) ?? 0) + c)
      return { counts }
    },
    finalize: (state) => {
      let best: number | null = null
      let bestCount = 0
      for (const [v, c] of state.counts) {
        if (c > bestCount || (c === bestCount && best !== null && v < best)) {
          best = v
          bestCount = c
        }
      }
      return best
    },
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

/**
 * `median()` for a **declared money field**, typed `Reducer<MoneyString | null>`.
 *
 * Same late-binding rewrite as {@link moneySum}: `wrapMoneyReducers` swaps in a
 * reducer that keeps the stored scaled integers as `bigint`s and interpolates
 * the two middle values IN SCALED SPACE with half-even rounding — the money
 * module's rounding everywhere else. Nothing round-trips through a float, so
 * the answer is exact past `Number.MAX_SAFE_INTEGER`, where two distinct cent
 * amounts stop being distinct numbers at all.
 *
 * An even-sized input can therefore land on a half unit (`0.10` and `0.15` →
 * `12.5` cents): that is the one place money median rounds, and it rounds
 * half-to-even (`0.12`), never away from zero.
 *
 * In multi-currency mode the runtime returns a per-currency map, as `moneyMin`
 * does; an empty result is `null` in fixed mode and `{}` in multi.
 */
export function moneyMedian(field: string, opts?: ReducerOptions<number>): Reducer<MoneyString | null> {
  return median(field, opts) as unknown as Reducer<MoneyString | null>
}

/**
 * `percentile()` for a declared money field — see {@link moneyMedian} for the
 * exactness and rounding contract, which is the same code path (`median` is
 * `p = 0.5`). The interpolation weight is taken from `p`'s DECIMAL spelling as
 * an exact rational, so `p = 0.9` is `9/10`, not the float nearest to it.
 *
 * There is deliberately no `approx` here: the t-digest is a float structure and
 * `wrapMoneyReducers` refuses it over a money field.
 */
export function moneyPercentile(
  field: string,
  p: number,
  opts?: ReducerOptions<number>,
): Reducer<MoneyString | null> {
  return percentile(field, p, opts) as unknown as Reducer<MoneyString | null>
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
  countDistinct(field: QueryField<T, S>, opts?: ReducerOptions<number>): Reducer<number, CountDistinctState>
  sum<F extends QueryField<T, S>>(field: F, opts?: ReducerOptions<number>): [F] extends [M] ? Reducer<MoneyString> : Reducer<number>
  avg(field: QueryField<T, S>, opts?: ReducerOptions<{ sum: number; count: number }>): ReturnType<typeof avg>
  min<F extends QueryField<T, S>>(field: F, opts?: ReducerOptions<number>): [F] extends [M] ? Reducer<MoneyString | null> : ReturnType<typeof min>
  max<F extends QueryField<T, S>>(field: F, opts?: ReducerOptions<number>): [F] extends [M] ? Reducer<MoneyString | null> : ReturnType<typeof max>
  median<F extends QueryField<T, S>>(field: F, opts?: ReducerOptions<number>): [F] extends [M] ? Reducer<MoneyString | null> : ReturnType<typeof median>
  percentile<F extends QueryField<T, S>>(field: F, p: number, opts?: PercentileOptions): [F] extends [M] ? Reducer<MoneyString | null> : ReturnType<typeof percentile>
  variance(field: QueryField<T, S>, opts?: DispersionOptions): ReturnType<typeof variance>
  stddev(field: QueryField<T, S>, opts?: DispersionOptions): ReturnType<typeof stddev>
  mode(field: QueryField<T, S>, opts?: ReducerOptions<number>): ReturnType<typeof mode>
  moneySum(field: QueryField<T, S>, opts?: ReducerOptions<number>): Reducer<MoneyString>
  moneyMin(field: QueryField<T, S>, opts?: ReducerOptions<number>): Reducer<MoneyString | null>
  moneyMax(field: QueryField<T, S>, opts?: ReducerOptions<number>): Reducer<MoneyString | null>
  moneyMedian(field: QueryField<T, S>, opts?: ReducerOptions<number>): Reducer<MoneyString | null>
  moneyPercentile(field: QueryField<T, S>, p: number, opts?: ReducerOptions<number>): Reducer<MoneyString | null>
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
  countDistinct,
  // The generic F parameter on sum/min/max in the interface is type-only; the
  // standalone factories are plain `(field: string)` functions. With M=never the
  // conditional return collapses to the numeric branch, matching the factories'
  // return type, but TypeScript cannot verify that collapse for a generic method
  // signature — so each factory is cast directly to the method's type.
  sum: sum as ReducerBuilder<Record<string, unknown>>['sum'],
  avg,
  min: min as ReducerBuilder<Record<string, unknown>>['min'],
  max: max as ReducerBuilder<Record<string, unknown>>['max'],
  median: median as ReducerBuilder<Record<string, unknown>>['median'],
  percentile: percentile as ReducerBuilder<Record<string, unknown>>['percentile'],
  variance,
  stddev,
  mode,
  moneySum, moneyMin, moneyMax, moneyMedian, moneyPercentile,
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
