/**
 * Aggregate execution — the runtime behind `Query.aggregate()`.
 *
 * v0.6 #97 — takes an `AggregateSpec` (a record of named reducers
 * built from `reducers.ts`) and runs every reducer over the records
 * produced by the underlying query. Two terminal surfaces:
 *
 *   - `.run(): R` — synchronous one-shot reduction. Matches the
 *     existing `Query.toArray()` / `.first()` / `.count()` style.
 *   - `.live(): LiveAggregation<R>` — reactive primitive that
 *     re-runs the reduction whenever the query's source notifies of
 *     a change. v0.6 uses naive full re-run; incremental delta
 *     maintenance is admitted by the reducer protocol (`remove()`)
 *     but not wired to the executor yet — a follow-up optimization
 *     can switch from full re-run to delta-based without breaking
 *     the public API. Consumers get correct, reactive values today.
 *
 * The `Aggregation<R>` wrapper is deliberately tiny — it exists so
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
export type AggregateSpec = Readonly<Record<string, Reducer<unknown, unknown>>>

/**
 * Map an `AggregateSpec` to its reduced result shape — each key
 * carries the finalized result type from its reducer. A spec built
 * from `{ total: sum('amount'), n: count() }` yields a result of
 * `{ total: number, n: number }`.
 *
 * This uses a mapped type with a conditional to extract `R` from
 * each `Reducer<R, _>`. The `infer` captures the user-visible result
 * type, discarding the internal state type `S`.
 */
export type AggregateResult<Spec extends AggregateSpec> = {
  [K in keyof Spec]: Spec[K] extends Reducer<infer R, unknown> ? R : never
}

/**
 * Pure reduction over a record array. Runs every reducer's
 * `init → step* → finalize` pipeline exactly once over the records.
 *
 * Called by `Aggregation.run()` and by the live-mode refresh path.
 * Exported for tests and for future `scan().aggregate()` (#99) reuse
 * — the streaming path will call the same reducer protocol with a
 * per-page loop instead of a single array.
 */
export function reduceRecords<Spec extends AggregateSpec>(
  records: readonly unknown[],
  spec: Spec,
): AggregateResult<Spec> {
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
  return result as AggregateResult<Spec>
}

/**
 * A minimal reactive primitive for aggregation results.
 *
 * Same spirit as the `LiveQuery` in #74: frame-agnostic, a plain
 * object with `value` / `error` fields and a `subscribe(cb)`
 * notification channel that Vue / React / Solid adapters wrap in
 * their own primitive. Intentionally NOT a Promise — aggregations
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
export interface LiveAggregation<R> {
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
 * Upstream change-notification hook for live aggregation.
 *
 * Matches the shape that `QuerySource.subscribe` already uses — a
 * single method that accepts a callback and returns an unsubscribe
 * function. The `Aggregation` wrapper collects upstreams from the
 * query's source and wires them into a single re-run trigger.
 */
export interface AggregationUpstream {
  subscribe(cb: () => void): () => void
}

/**
 * Internal implementation of `LiveAggregation`. Not exported —
 * consumers get the interface only. The class wraps a `recompute`
 * closure (which runs the full reduction and returns the new value)
 * and a list of upstreams (sources whose changes should trigger a
 * re-run).
 *
 * Error isolation: if an individual listener callback throws, the
 * other listeners still fire and the error is logged to the warn
 * channel. This matches `LiveQuery` from #74 and keeps one misbehaving
 * consumer from tearing down the whole live aggregation.
 */
class LiveAggregationImpl<R> implements LiveAggregation<R> {
  public value: R | undefined
  public error: unknown
  private readonly listeners = new Set<() => void>()
  private readonly unsubscribes: Array<() => void> = []
  private stopped = false

  constructor(
    private readonly recompute: () => R,
    upstreams: readonly AggregationUpstream[],
  ) {
    // Initial computation — surface any error through the `error`
    // field rather than letting the constructor throw, so consumers
    // can always construct a LiveAggregation and check its state
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
    // recomputation; we don't attempt incremental updates in v0.6.
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
        // down every other subscriber on the same aggregation.
        console.warn('[noy-db] LiveAggregation listener threw:', err)
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
        console.warn('[noy-db] LiveAggregation upstream unsubscribe threw:', err)
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
 * (`aggregateRun` / `aggregateLive`) that would be harder to
 * discover.
 */
export class Aggregation<R> {
  constructor(
    private readonly executeRecords: () => readonly unknown[],
    private readonly spec: AggregateSpec,
    private readonly upstreams: readonly AggregationUpstream[],
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
   * Build a reactive `LiveAggregation<R>` that re-runs the reduction
   * whenever any upstream source notifies of a change. The initial
   * value is computed eagerly in the constructor, so consumers can
   * read `live.value` immediately after calling `.live()`.
   *
   * Always call `live.stop()` when finished — it tears down the
   * upstream subscriptions. Vue's `onUnmounted` is the canonical
   * place.
   *
   * **v0.6 implementation note:** every upstream change triggers a
   * full re-reduction. Incremental maintenance (O(1) per delta for
   * sum/count/avg via the reducer protocol's `remove()` method) is a
   * planned follow-up optimization — the protocol already supports
   * it, but the executor doesn't drive it yet. Consumers get
   * correct, reactive values today; future PRs can switch to
   * delta-based maintenance without changing this API.
   */
  live(): LiveAggregation<R> {
    const recompute = (): R =>
      reduceRecords(this.executeRecords(), this.spec) as unknown as R
    return new LiveAggregationImpl<R>(recompute, this.upstreams)
  }
}

/**
 * Build a `LiveAggregation<V>` from a recompute closure and a list
 * of upstreams. Exposed so sibling files in the query DSL
 * (currently `groupby.ts`) can reuse the reactive primitive
 * without reaching into `LiveAggregationImpl` directly. This keeps
 * the implementation class private while still allowing planned
 * composition with `.groupBy().aggregate().live()`.
 */
export function buildLiveAggregation<V>(
  recompute: () => V,
  upstreams: readonly AggregationUpstream[],
): LiveAggregation<V> {
  return new LiveAggregationImpl<V>(recompute, upstreams)
}
