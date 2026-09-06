/**
 * Query DSL `.window()` — SQL window functions over the query's result rows
 * (#1349).
 *
 * ```ts
 * invoices.query()
 *   .where('status', '==', 'open')
 *   .window({ partitionBy: 'clientId', orderBy: 'date' })
 *   .select({ balance: runningSum('amount'), prev: lag('amount', 1), n: rowNumber() })
 *   .run()
 * ```
 *
 * Pure in-hub post-processing: the store holds ciphertext, so this runs after
 * decryption like every other query stage. No index is consulted — see
 * "Complexity" below for why the sorted-index fast path is deliberately not
 * taken in v1.
 *
 * ## What it is, precisely
 *
 * A window function adds COLUMNS to a row; it never adds, removes or reorders
 * rows. `.select()` therefore returns the query's own rows, in the query's own
 * order, each widened with the window outputs. `orderBy` inside `.window()`
 * decides how a PARTITION is walked; `Query.orderBy()` decides how the RESULT
 * is presented. That is SQL's split and both are honoured independently.
 *
 * ⭐ Distinguished from `.groupBy()` by ARITY: `.groupBy().aggregate()` emits
 * one row per bucket and drops the source rows; `.window().select()` keeps
 * every source row and attaches per-row values computed over its partition.
 *
 * ## The frame — `rows unbounded preceding → current row`, and only that
 *
 * A running aggregate at position `i` of its partition sees exactly rows
 * `0..i`. There is no `RANGE`, no `n preceding`, no `following`, and no
 * `frame` option to pass — explicit frames are a separate feature, and a
 * half-built frame surface is worse than none. `lag`/`lead` are navigation,
 * not aggregation, so they are unaffected by the frame.
 *
 * ## Ordering inside a partition is TOTAL
 *
 * Rows are sorted by the `orderBy` keys and, where those compare equal, by
 * their UPSTREAM POSITION — the sort is a stable sort over an ascending index
 * array, so equal keys keep the order the query produced them in. Without that
 * final key, `lag`/`lead` over equal keys would be a coin flip between runs.
 *
 * The value comparator is {@link compareReduced}, shared with the post-group
 * ordering of #1336 rather than reinvented, and for the same reason: a money
 * value reaches this stage DECODED, as an exact decimal string, and lexical
 * order gets `'9882.00'` vs `'10004.00'` backwards. (The pre-group row
 * pipeline asks `ViaPipeline.compareForOrder` instead — that reads the STORED
 * scaled-integer form, which is not what a decoded row holds, so it cannot
 * serve here.)
 *
 * PEER-ship for `rank` is decided by the `orderBy` keys ALONE, never by the
 * upstream tie-break — otherwise no two rows would ever be peers and `rank`
 * would collapse into `rowNumber`.
 *
 * ## Complexity, and the index question
 *
 * O(n log n): one partition pass, then a sort per partition. #1344's sorted
 * indexes could in principle make the sort a merge, but the input here is the
 * query's already-materialised, already-DECODED result rows — the index is
 * over stored (encoded) values on the collection, and it has no way to express
 * "sorted within each partition of `clientId`". Taking a fast path would mean
 * proving identical output including the upstream tie-break, which the index
 * cannot witness. So v1 sorts. This is the correct path, not a placeholder.
 *
 * ## Opting in — and why there is a second opt-in at all
 *
 * `withReduce()` alone does NOT light this up: `.window()` throws until the
 * strategy is built as `withReduce({ window: withWindow() })`. That is not
 * ceremony for its own sake — it is the SAME no-op-stub-until-opted-in rule
 * that keeps `Reduction`/`GroupedQuery` out of the floor bundle, applied one
 * level down. `withReduce()`'s returned object is a live value the bundler
 * cannot prove unused, so a `window()` method that named {@link WindowedQuery}
 * directly made this whole engine reachable from `withReduce` and charged it
 * to every consumer who opted into ordinary aggregation and will never call
 * `.window()`. Measured: the `analytics` bundle scenario went 960 → 1,845
 * gzipped bytes, +92%. Passing the factory in means the engine is reachable
 * only from a consumer that names `withWindow`.
 * ⛔ Do not "simplify" this back into `withReduce()` — `check-bundle.mjs`'s
 * `analytics` scenario carries a `WindowedQuery` eager-import canary that will
 * fail if you do.
 *
 * ## Not in `explain()`
 *
 * Same shape as #1336's post-group ops: `explain()` is a terminal on `Query`,
 * and `.window()` leaves `Query` for `WindowedQuery`, so there is no
 * `explain()` in the chain past this point to add a node to. The window stage
 * also has nothing to choose — one dispatch, over rows already in memory.
 */

import { readPath } from '../../kernel/query/predicate.js'
import { canonicalGroupKey } from './canonical-key.js'
import { compareReduced } from './groupby.js'
import type { Reducer } from './reducers.js'
import { bindDistinctReducers, sum, moneySum } from './reducers.js'
import type { ReductionUpstream, LiveReduction } from './reduction.js'
import { buildLiveReduction } from './reduction.js'
import type { DateTruncKey } from '../../kernel/query/reduce/date-trunc.js'
import { isDateTruncKey, projectDateTruncKeys } from '../../kernel/query/reduce/date-trunc.js'
import type { MoneyString } from '../../via/money/branded.js'
import type { ViaPipeline } from '../../kernel/via/pipeline.js'

// ---------------------------------------------------------------------------
// Spec surface
// ---------------------------------------------------------------------------

/** One ordering key inside a window: a field name, a `dateTrunc()` key, or either with a direction. */
export type WindowOrderInput<F extends string = string> =
  | F
  | DateTruncKey
  | { readonly field: F | DateTruncKey; readonly direction?: 'asc' | 'desc' }

/**
 * The window definition passed to `.window()`.
 *
 * Both members are optional and mean what SQL's omissions mean: no
 * `partitionBy` is one partition holding the whole relation; no `orderBy`
 * makes every row in a partition a peer (so `rank()` is 1 throughout and a
 * running aggregate sees the rows in upstream order).
 */
export interface WindowSpec<F extends string = string> {
  /** Field name(s) and/or `dateTrunc()` key(s) to partition on. */
  readonly partitionBy?: F | DateTruncKey | readonly (F | DateTruncKey)[]
  /** How each partition is walked. Successive keys are tie-breakers. */
  readonly orderBy?: WindowOrderInput<F> | readonly WindowOrderInput<F>[]
}

/**
 * A non-aggregating window function (ranking or navigation). Built by the
 * factories below — the shape is opaque to consumers.
 */
export interface WindowFn<R = unknown> {
  readonly __window: true
  readonly op: 'rowNumber' | 'rank' | 'lag' | 'lead'
  /**
   * Compute one value per row of an ORDERED partition.
   * `peerStart[i]` is the index of the first row that compares equal to row
   * `i` under the window's `orderBy` keys.
   */
  evaluate(rows: readonly unknown[], peerStart: readonly number[]): R[]
}

/**
 * A `.select()` slot: either a window function or an ordinary {@link Reducer},
 * which runs as a RUNNING aggregate under the v1 frame. Any reducer works —
 * `count()`, `sum()`, `countDistinct()`, a custom one — so `runningSum` and
 * `runningMoneySum` below are named conveniences, not a separate mechanism.
 */
export type WindowSelectSpec = Readonly<Record<string, WindowFn<unknown> | Reducer<unknown, unknown>>>

/** Result type of one `.select()` slot. */
type WindowSlotResult<V> =
  V extends WindowFn<infer R> ? R : V extends Reducer<infer R, unknown> ? R : unknown

/** A window result row: the source record widened with the selected outputs. */
export type WindowRow<T, Spec extends WindowSelectSpec> = T & {
  [K in keyof Spec]: WindowSlotResult<Spec[K]>
}

function isWindowFn(v: unknown): v is WindowFn<unknown> {
  return typeof v === 'object' && v !== null && (v as { __window?: unknown }).__window === true
}

// ---------------------------------------------------------------------------
// Window function factories
// ---------------------------------------------------------------------------

/**
 * Sequential position of the row within its partition, starting at 1. NEVER
 * repeats — two rows that tie under `orderBy` still get distinct numbers,
 * resolved by the upstream tie-break. Use {@link rank} when ties should share
 * a number.
 */
export function rowNumber(): WindowFn<number> {
  return {
    __window: true,
    op: 'rowNumber',
    evaluate: (rows) => rows.map((_, i) => i + 1),
  }
}

/**
 * Competition rank within the partition, starting at 1. Rows that compare
 * EQUAL under the window's `orderBy` keys share a rank, and the next distinct
 * value SKIPS the ranks they consumed — `1, 2, 2, 4`. This is the only place
 * `rank` and {@link rowNumber} differ, so a fixture without ties cannot tell
 * them apart.
 *
 * With no `orderBy` every row is a peer and every rank is 1.
 */
export function rank(): WindowFn<number> {
  return {
    __window: true,
    op: 'rank',
    evaluate: (_rows, peerStart) => peerStart.map((start) => start + 1),
  }
}

function assertOffset(op: 'lag' | 'lead', offset: number): void {
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error(`${op}(): offset must be a non-negative integer, got ${offset}.`)
  }
}

/**
 * Value of `field` from the row `offset` positions EARLIER in the partition.
 * Returns `defaultValue` (default `undefined`) for the first `offset` rows.
 */
export function lag<R = unknown>(field: string, offset = 1, defaultValue?: R): WindowFn<R | undefined> {
  assertOffset('lag', offset)
  return {
    __window: true,
    op: 'lag',
    evaluate: (rows) =>
      rows.map((_, i) => (i - offset >= 0 ? (readPath(rows[i - offset], field) as R) : defaultValue)),
  }
}

/**
 * Value of `field` from the row `offset` positions LATER in the partition.
 * Returns `defaultValue` (default `undefined`) for the last `offset` rows.
 */
export function lead<R = unknown>(field: string, offset = 1, defaultValue?: R): WindowFn<R | undefined> {
  assertOffset('lead', offset)
  return {
    __window: true,
    op: 'lead',
    evaluate: (rows) =>
      rows.map((_, i) => (i + offset < rows.length ? (readPath(rows[i + offset], field) as R) : defaultValue)),
  }
}

/**
 * Running total of a numeric `field` over `rows unbounded preceding → current
 * row`. Identical to passing `sum(field)` — named for the reading.
 *
 * ⚠️ For a declared money field use {@link runningMoneySum}: it is the same
 * reducer, but typed `MoneyString` to match what the exact BigInt rewrite
 * actually returns.
 */
export function runningSum(field: string): Reducer<number> {
  return sum(field)
}

/**
 * Running total of a **declared money field**, exact at any magnitude.
 *
 * The reducer is the ordinary money `sum`, and it is rewritten by
 * `ViaPipeline.wrapReducers` into `via/money/money-reducer.ts`'s BigInt
 * accumulator at `.select()` time — the SAME rewrite `.aggregate()` and
 * `.groupBy()` get, so a running balance and a grand total cannot disagree.
 * Nothing here touches a float: values accumulate as scaled `bigint`s and each
 * row's value is `formatScaledInt`'d out of the state at that point.
 */
export function runningMoneySum(field: string): Reducer<MoneyString> {
  return moneySum(field)
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

interface NormalizedOrder {
  /** Output key to read (a derived key's `as`, or the plain field name). */
  readonly key: string
  readonly direction: 'asc' | 'desc'
}

interface NormalizedWindow {
  readonly partitionKeys: readonly string[]
  readonly orderBy: readonly NormalizedOrder[]
  readonly derived: readonly DateTruncKey[]
}

function asArray<V>(v: V | readonly V[] | undefined): readonly V[] {
  if (v === undefined) return []
  return Array.isArray(v) ? (v as readonly V[]) : [v as V]
}

/**
 * Resolve the spec into flat key lists plus the derived calendar keys that
 * must be projected before any of them can be read.
 *
 * NOT exported: `NormalizedWindow` is an implementation shape, and exporting
 * the function without it trips `check:types` (a subpath must be able to name
 * every type its own signatures mention).
 */
function normalizeWindow(spec: WindowSpec): NormalizedWindow {
  const derived: DateTruncKey[] = []
  const keyOf = (k: string | DateTruncKey): string => {
    if (!isDateTruncKey(k)) return k
    derived.push(k)
    return k.as
  }
  const partitionKeys = asArray<string | DateTruncKey>(spec.partitionBy).map(keyOf)
  const orderBy = asArray<WindowOrderInput>(spec.orderBy).map((entry): NormalizedOrder => {
    if (typeof entry === 'string' || isDateTruncKey(entry)) {
      return { key: keyOf(entry), direction: 'asc' }
    }
    return { key: keyOf(entry.field), direction: entry.direction ?? 'asc' }
  })
  return { partitionKeys, orderBy, derived }
}

/**
 * Execute the window stage. Pure function over a row array — exported for
 * tests and for any future `scan().window()` reuse.
 *
 * Rows are returned in INPUT order, each a shallow copy widened with the
 * selected outputs. A `dateTrunc()` partition key is read off an internal
 * projection and is deliberately NOT stamped on the output row — unlike
 * `.groupBy()`, where the derived key IS the result key.
 */
export function applyWindow<R>(
  records: readonly unknown[],
  spec: WindowSpec,
  select: WindowSelectSpec,
): R[] {
  const { partitionKeys, orderBy, derived } = normalizeWindow(spec)
  const n = records.length
  if (n === 0) return []

  // Keys are read off a projected copy so a derived calendar bucket looks like
  // an ordinary field; the OUTPUT is built from the untouched original.
  const keyRows: readonly unknown[] =
    derived.length === 0 ? records : projectDateTruncKeys(records, derived)

  // Partition. Indices, not rows, so the upstream position survives as the
  // final ordering key. Map preserves insertion order (irrelevant to output
  // ordering here, but it keeps the walk deterministic).
  const partitions = new Map<string, number[]>()
  for (let i = 0; i < n; i++) {
    let dedupKey = ''
    if (partitionKeys.length > 0) {
      const keyValues: Record<string, unknown> = {}
      for (const f of partitionKeys) keyValues[f] = readPath(keyRows[i], f)
      dedupKey = canonicalGroupKey(partitionKeys, keyValues)
    }
    const bucket = partitions.get(dedupKey)
    if (bucket) bucket.push(i)
    else partitions.set(dedupKey, [i])
  }

  // Compare two rows by the orderBy keys ONLY — peer-ship for `rank` is
  // decided here, so the upstream tie-break must not participate.
  const compareByKeys = (a: number, b: number): number => {
    for (const { key, direction } of orderBy) {
      const cmp = compareReduced(readPath(keyRows[a], key), readPath(keyRows[b], key))
      if (cmp !== 0) return direction === 'asc' ? cmp : -cmp
    }
    return 0
  }

  const slots = Object.entries(select)
  const out: Record<string, unknown>[] = records.map((r) => ({ ...(r as Record<string, unknown>) }))

  for (const indices of partitions.values()) {
    // Stable sort over an ascending index array ⇒ equal keys keep upstream
    // order, which is what makes the ordering total.
    indices.sort(compareByKeys)
    const ordered = indices.map((i) => records[i])

    // peerStart[k] = index of the first row of k's tie-group under `orderBy`.
    const peerStart: number[] = new Array<number>(indices.length)
    for (let k = 0; k < indices.length; k++) {
      peerStart[k] = k === 0 || compareByKeys(indices[k - 1]!, indices[k]!) !== 0 ? k : peerStart[k - 1]!
    }

    for (const [name, slot] of slots) {
      if (isWindowFn(slot)) {
        const values = slot.evaluate(ordered, peerStart)
        for (let k = 0; k < indices.length; k++) out[indices[k]!]![name] = values[k]
        continue
      }
      // Running aggregate under the v1 frame: step, then finalize, per row.
      let state = slot.init()
      for (let k = 0; k < indices.length; k++) {
        state = slot.step(state, ordered[k])
        out[indices[k]!]![name] = slot.finalize(state)
      }
    }
  }

  return out as R[]
}

// ---------------------------------------------------------------------------
// Chainable wrappers
// ---------------------------------------------------------------------------

/**
 * What `withWindow()` hands to `withReduce()`. Named as a type so
 * `strategy.ts` / `active.ts` can speak it in a TYPE-ONLY import and never
 * pull this module into their runtime graph.
 */
export type WindowFactory = <T>(
  executeRecords: () => readonly unknown[],
  spec: WindowSpec,
  upstreams: readonly ReductionUpstream[],
  via?: ViaPipeline,
) => WindowedQuery<T>

/**
 * Light up `.window()` on `Query`.
 *
 * ```ts
 * import { withReduce, withWindow } from '@noy-db/hub/reduce'
 * createNoydb({ store, user, secret, reduceStrategy: withReduce({ window: withWindow() }) })
 * ```
 *
 * The only reference to {@link WindowedQuery} outside this module's own
 * consumers — see "Opting in" in the module docs for why that matters.
 */
export function withWindow(): WindowFactory {
  return <T>(
    executeRecords: () => readonly unknown[],
    spec: WindowSpec,
    upstreams: readonly ReductionUpstream[],
    via?: ViaPipeline,
  ): WindowedQuery<T> => new WindowedQuery<T>(executeRecords, spec, upstreams, via)
}

/**
 * Chainable wrapper returned by `Query.window(spec)`. Terminates with
 * `.select(spec)`, which is the only operation on it — a window with nothing
 * selected computes nothing.
 */
export class WindowedQuery<T> {
  constructor(
    private readonly executeRecords: () => readonly unknown[],
    private readonly spec: WindowSpec,
    private readonly upstreams: readonly ReductionUpstream[],
    private readonly via?: ViaPipeline,
  ) {
    // T is phantom on the wrapper so a consumer still sees the row type on
    // hover. Reference it to keep lint quiet.
    void undefined as T | undefined
  }

  /**
   * Attach window outputs to every row. Each slot is either a
   * {@link WindowFn} (`rowNumber`, `rank`, `lag`, `lead`) or a `Reducer`,
   * which runs as a running aggregate over `rows unbounded preceding →
   * current row`.
   *
   * Reducers are rewritten through the collection's Via pipeline exactly as
   * `.aggregate()` rewrites them, so a `sum` over a declared money field
   * becomes the exact BigInt accumulator and a `countDistinct` dedups on the
   * canonical index key.
   */
  select<Spec extends WindowSelectSpec>(spec: Spec): WindowSelection<WindowRow<T, Spec>> {
    const reducersOnly: Record<string, Reducer<unknown, unknown>> = {}
    for (const [k, v] of Object.entries(spec)) {
      if (!isWindowFn(v)) reducersOnly[k] = v
    }
    const wrapped = bindDistinctReducers(
      this.via ? this.via.wrapReducers(reducersOnly) : reducersOnly,
      this.via,
    )
    const effective: Record<string, WindowFn<unknown> | Reducer<unknown, unknown>> = { ...spec }
    for (const [k, v] of Object.entries(wrapped)) effective[k] = v
    return new WindowSelection<WindowRow<T, Spec>>(
      this.executeRecords,
      this.spec,
      effective,
      this.upstreams,
    )
  }
}

/**
 * The `.window(...).select(...)` terminal. Mirrors `GroupedReduction`'s shape
 * — `.run()` and `.live()` — minus the post-group stage: ordering and limiting
 * of window OUTPUT rows belong on the underlying `Query`, before `.window()`,
 * because a window never changes the row set.
 */
export class WindowSelection<R> {
  constructor(
    private readonly executeRecords: () => readonly unknown[],
    private readonly spec: WindowSpec,
    private readonly select: WindowSelectSpec,
    private readonly upstreams: readonly ReductionUpstream[],
  ) {}

  /** Execute the query and return every row, widened with the window outputs. */
  run(): R[] {
    return applyWindow<R>(this.executeRecords(), this.spec, this.select)
  }

  /**
   * Reactive terminal — re-runs the whole window pipeline on every upstream
   * change, the same naive-recompute contract `GroupedReduction.live()` has.
   * Always call `live.stop()` when finished.
   */
  live(): LiveReduction<R[]> {
    return buildLiveReduction<R[]>(() => this.run(), this.upstreams)
  }
}
