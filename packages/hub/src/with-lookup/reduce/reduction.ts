/**
 * Aggregate execution — the runtime behind `Query.aggregate()`.
 *
 * takes an `ReduceSpec` (a record of named reducers
 * built from `reducers.ts`) and runs every reducer over the records
 * produced by the underlying query. Two terminal surfaces:
 *
 *   - `.run(): R` — synchronous one-shot reduction. Matches the
 *     existing `Query.toArray()` / `.first()` / `.count()` style.
 *   - `.live(): LiveReduction<R>` — reactive primitive that
 *     re-runs the reduction whenever the query's source notifies of
 *     a change. Since #1341 the RECORD SET it reduces is maintained
 *     incrementally upstream (see `kernel/query/incremental.ts`), so a
 *     change costs one predicate evaluation instead of a full scan — but
 *     the reducers themselves still run a complete `init → step* →
 *     finalize` fold over that set. Driving `remove()` per delta (the
 *     reducer protocol admits it) would make a change O(1) rather than
 *     O(matches); it is deliberately NOT wired, because folding the same
 *     array a re-run would fold makes the incremental value bit-identical
 *     to the eager one, while inverting a float `sum` does not.
 *
 * `GroupedReduction.live()` goes one step further (#1341, grouped half): its
 * BUCKETS are maintained too, so a change re-folds only the groups it touched.
 * See `incremental-group.ts`. The reasoning above is why neither path inverts
 * a reducer state.
 *
 * The `Reduction<R>` wrapper is deliberately tiny — it exists so
 * `.aggregate(spec)` can be chained with either `.run()` or `.live()`
 * without the builder needing two separate terminal methods. It
 * holds the closure over the query execution (produces the current
 * matching record set) and the spec, and stitches them together in
 * either mode.
 *
 * This file depends ONLY on `reducers.ts` — it has no knowledge of
 * the `Query` class. Tests can therefore exercise the reduction
 * surface with plain record arrays, without spinning up a Collection.
 */

import type { Reducer } from './reducers.js'
import type { SourceChange } from '../../kernel/query/incremental.js'

/**
 * A named set of reducers, keyed by output field name. Each key
 * becomes a field on the aggregated result.
 *
 * ```ts
 * const spec = {
 *   total: sum('amount'),
 *   n:     count(),
 *   avgAmount: avg('amount'),
 * }
 * ```
 */
export type ReduceSpec = Readonly<Record<string, Reducer<unknown, unknown>>>

/**
 * Map an `ReduceSpec` to its reduced result shape — each key
 * carries the finalized result type from its reducer. A spec built
 * from `{ total: sum('amount'), n: count() }` yields a result of
 * `{ total: number, n: number }`.
 *
 * This uses a mapped type with a conditional to extract `R` from
 * each `Reducer<R, _>`. The `infer` captures the user-visible result
 * type, discarding the internal state type `S`.
 */
export type ReduceResult<Spec extends ReduceSpec> = {
  [K in keyof Spec]: Spec[K] extends Reducer<infer R, unknown> ? R : never
}

/**
 * Pure reduction over a record array. Runs every reducer's
 * `init → step* → finalize` pipeline exactly once over the records.
 *
 * Called by `Reduction.run()` and by the live-mode refresh path.
 * Exported for tests and for future `scan().aggregate()` reuse
 * — the streaming path will call the same reducer protocol with a
 * per-page loop instead of a single array.
 */
export function reduceRecords<Spec extends ReduceSpec>(
  records: readonly unknown[],
  spec: Spec,
): ReduceResult<Spec> {
  // Per-slot state, keyed by the spec's output field name.
  const state: Record<string, unknown> = {}
  for (const key of Object.keys(spec)) {
    state[key] = spec[key]!.init()
  }
  for (const record of records) {
    for (const key of Object.keys(spec)) {
      state[key] = spec[key]!.step(state[key], record)
    }
  }
  const result: Record<string, unknown> = {}
  for (const key of Object.keys(spec)) {
    result[key] = spec[key]!.finalize(state[key])
  }
  return result as ReduceResult<Spec>
}

/**
 * A minimal reactive primitive for reduction results.
 *
 * Same spirit as the `LiveQuery` in : frame-agnostic, a plain
 * object with `value` / `error` fields and a `subscribe(cb)`
 * notification channel that Vue / React / Solid adapters wrap in
 * their own primitive. Intentionally NOT a Promise — reductions
 * have a well-defined "current value" at every instant, and the
 * reactive consumer wants to read that value synchronously.
 *
 * Error semantics mirror `LiveQuery`: if a re-run throws, the
 * previous successful `value` is preserved and the error is stored
 * in `error` so consumers can render an error state without losing
 * the last-known-good result. The throw does NOT propagate out of
 * the source's change handler (which would tear down the upstream
 * emitter).
 *
 * `stop()` tears down the upstream subscription. It is idempotent —
 * calling it multiple times is safe — and subscribe calls after
 * stop are no-ops (they immediately return a no-op unsubscribe).
 * Always call `stop()` when done; Vue's `onUnmounted` is the
 * canonical place. Raw consumers must do it themselves.
 */
export interface LiveReduction<R> {
  /** Current reduced value. Undefined only if the first compute threw. */
  readonly value: R | undefined
  /** Last execution error, if any. Cleared on the next successful run. */
  readonly error: unknown
  /** Notify on every recomputation (success or error). Returns unsubscribe. */
  subscribe(cb: () => void): () => void
  /** Tear down the upstream subscription. Idempotent. */
  stop(): void
}

/**
 * Upstream change-notification hook for live reduction.
 *
 * Matches the shape that `QuerySource.subscribe` already uses — a
 * single method that accepts a callback and returns an unsubscribe
 * function. The `Reduction` wrapper collects upstreams from the
 * query's source and wires them into a single re-run trigger.
 */
export interface ReductionUpstream {
  /**
   * `cb` MAY be handed the delta that caused the notification (#1341), which
   * is what lets `GroupedReduction.live()` patch the buckets a change touches
   * instead of re-grouping. Calling it with NO argument is always valid and
   * always correct — it means "something changed, I can't say what", and every
   * consumer answers that with a full re-run.
   */
  subscribe(cb: (change?: SourceChange) => void): () => void
}

/**
 * Internal implementation of `LiveReduction`. Not exported —
 * consumers get the interface only. The class wraps a `recompute`
 * closure (which runs the full reduction and returns the new value)
 * and a list of upstreams (sources whose changes should trigger a
 * re-run).
 *
 * Error isolation: if an individual listener callback throws, the
 * other listeners still fire and the error is logged to the warn
 * channel. This matches `LiveQuery` from  and keeps one misbehaving
 * consumer from tearing down the whole live reduction.
 */
class LiveAggregationImpl<R> implements LiveReduction<R> {
  public value: R | undefined
  public error: unknown
  private readonly listeners = new Set<() => void>()
  private readonly unsubscribes: Array<() => void> = []
  private stopped = false

  constructor(
    private readonly recompute: () => R,
    upstreams: readonly ReductionUpstream[],
  ) {
    // Initial computation — surface any error through the `error`
    // field rather than letting the constructor throw, so consumers
    // can always construct a LiveReduction and check its state
    // afterwards. Throwing from a constructor would force every
    // caller to wrap in try/catch, which is the opposite of the
    // "reactive value with error state" ergonomics we want.
    try {
      this.value = recompute()
      this.error = undefined
    } catch (err) {
      this.value = undefined
      this.error = err
    }

    // Wire up upstream subscriptions. Each one triggers a full
    // recomputation; we don't attempt incremental updates in.
    for (const upstream of upstreams) {
      const unsub = upstream.subscribe(() => this.refresh())
      this.unsubscribes.push(unsub)
    }
  }

  private refresh(): void {
    if (this.stopped) return
    try {
      this.value = this.recompute()
      this.error = undefined
    } catch (err) {
      // Preserve the previous successful value — consumers render an
      // error state using `error` without losing the last-known-good
      // number. This matches LiveQuery's error-preservation contract.
      this.error = err
    }
    for (const listener of this.listeners) {
      try {
        listener()
      } catch (err) {
        // Isolate listener errors so one bad consumer can't tear
        // down every other subscriber on the same reduction.
        console.warn('[noy-db] LiveReduction listener threw:', err)
      }
    }
  }

  subscribe(cb: () => void): () => void {
    if (this.stopped) {
      // No-op after stop. Returning a harmless unsubscribe lets
      // consumers use the same teardown pattern unconditionally.
      return () => {}
    }
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    for (const unsub of this.unsubscribes) {
      try {
        unsub()
      } catch (err) {
        console.warn('[noy-db] LiveReduction upstream unsubscribe threw:', err)
      }
    }
    this.unsubscribes.length = 0
    this.listeners.clear()
  }
}

/**
 * Chainable wrapper returned by `Query.aggregate(spec)`. Holds the
 * execute-records closure and the spec; terminal methods (`run`,
 * `live`) stitch them together in either mode.
 *
 * Why a wrapper instead of two terminal methods on `Query` directly?
 *
 * The `.aggregate(spec)` call is where the spec is bound — both
 * `.run()` and `.live()` need the same spec, and the consumer's
 * fluent style is `query.where(...).aggregate(spec).run()` or
 * `.aggregate(spec).live()`. Wrapping lets the spec be named once
 * and reused for either terminal, and keeps the `Query` class
 * from growing a pair of near-duplicate method overloads
 * (`reduceRun` / `reduceLive`) that would be harder to
 * discover.
 */
export class Reduction<R> {
  constructor(
    private readonly executeRecords: () => readonly unknown[],
    private readonly spec: ReduceSpec,
    private readonly upstreams: readonly ReductionUpstream[],
  ) {}

  /**
   * Execute the query and reduce the results synchronously.
   * Returns the reduced shape matching the spec — e.g. a spec of
   * `{ total: sum('amount'), n: count() }` returns
   * `{ total: number, n: number }`.
   */
  run(): R {
    return reduceRecords(this.executeRecords(), this.spec) as unknown as R
  }

  /**
   * Build a reactive `LiveReduction<R>` that re-runs the reduction
   * whenever any upstream source notifies of a change. The initial
   * value is computed eagerly in the constructor, so consumers can
   * read `live.value` immediately after calling `.live()`.
   *
   * Always call `live.stop()` when finished — it tears down the
   * upstream subscriptions. Vue's `onUnmounted` is the canonical
   * place.
   *
   * **Implementation note:** every upstream change triggers a full
   * re-reduction over the matching records — but since #1341 that record
   * set is itself maintained per delta rather than re-scanned, so the cost
   * is O(matches) rather than O(collection). Reducer-level `remove()`
   * (O(1) per delta for sum/count/avg) remains unwired; see the file
   * docstring for why folding beats inverting here.
   */
  live(): LiveReduction<R> {
    const recompute = (): R =>
      reduceRecords(this.executeRecords(), this.spec) as unknown as R
    return new LiveAggregationImpl<R>(recompute, this.upstreams)
  }
}

/**
 * Build a `LiveReduction<V>` from a recompute closure and a list
 * of upstreams. Exposed so sibling files in the query DSL
 * (currently `groupby.ts`) can reuse the reactive primitive
 * without reaching into `LiveAggregationImpl` directly. This keeps
 * the implementation class private while still allowing planned
 * composition with `.groupBy().aggregate().live()`.
 */
export function buildLiveReduction<V>(
  recompute: () => V,
  upstreams: readonly ReductionUpstream[],
): LiveReduction<V> {
  return new LiveAggregationImpl<V>(recompute, upstreams)
}
