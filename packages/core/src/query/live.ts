/**
 * Reactive query primitive — `query.live()`.
 *
 * v0.6 #74 — produces a `LiveQuery<T>` that re-runs the query and
 * updates its `value` whenever any source feeding it (the left
 * collection AND every right-side collection a join leg points at)
 * mutates.
 *
 * Framework-agnostic by design. The Vue layer wraps a `LiveQuery`
 * in a Vue `Ref<T[]>` by subscribing once and copying `value` into
 * the ref on every notification. React/Solid/Svelte adapters do the
 * same with their own primitives. Core never depends on a UI
 * framework.
 *
 * **Error semantics.** A `.live()` query may throw at re-run time —
 * a strict-mode `DanglingReferenceError` is the most common case
 * (a right-side record was deleted out-of-band, leaving a left
 * row's FK pointing at nothing). When the re-run throws, the
 * `LiveQuery` catches the error and stores it in the `error`
 * field; it does NOT propagate the throw out of the source's
 * change handler, because doing so would tear down whatever
 * upstream emitter is dispatching. Listeners check `error` after
 * each notification and render an error state in the UI.
 *
 * **Dedup of right-side subscriptions.** A multi-FK chain that
 * joins the same target twice (e.g.
 * `.join('billingClientId').join('shippingClientId')`, both
 * pointing at `clients`) only subscribes to that target once. We
 * dedup by target collection name, on the assumption that
 * `resolveSource(name)` returns a single subscribable source per
 * compartment + name. Compartment's `resolveSource` reads from
 * `collectionCache` so this assumption holds.
 *
 * **What .live() does NOT do in v1:**
 *   - No granular delta updates — the whole query re-runs on every
 *     change. Granular delta tracking is a v2 optimization once
 *     the API is stable.
 *   - No batching of bursty changes — one event in, one re-run
 *     out. Batching with microtask coalescing is a v2 enhancement.
 *   - No async notifications — every notification is synchronous
 *     within the source's change handler.
 *   - No re-planning under live mutations — the planner picks once
 *     at subscription time and reuses the same plan for every
 *     re-run.
 */

/**
 * The reactive primitive returned by `Query.live()`.
 *
 * Listeners can read the current `value` snapshot at any time and
 * subscribe to changes via `.subscribe(cb)`. The `error` field
 * carries the most recent re-run error, if any — read it after
 * each notification to render error state.
 *
 * Always call `stop()` when the live query is no longer needed.
 * Without it, the upstream change-stream subscriptions stay live
 * forever and the query keeps re-running on every mutation.
 */
export interface LiveQuery<T> {
  /**
   * Current snapshot of the query result. Updated in place on
   * every upstream change. The reference returned is the same
   * `readonly T[]` array — consumers that want change detection by
   * reference should copy: `const arr = [...live.value]`.
   */
  readonly value: readonly T[]
  /**
   * Most recent re-run error, or `null` on success. Set when the
   * executor throws (e.g. `DanglingReferenceError` in strict mode
   * after a right-side delete). Cleared on the next successful
   * re-run.
   */
  readonly error: Error | null
  /**
   * Register a notification callback. Fires AFTER `value` and
   * `error` have been updated for a given upstream change.
   * Returns an unsubscribe function.
   *
   * The first call to `subscribe` does NOT fire the callback
   * immediately — call sites that want the initial value should
   * read `live.value` directly before subscribing.
   */
  subscribe(cb: () => void): () => void
  /**
   * Tear down every upstream subscription and clear the listener
   * set. Idempotent — calling twice is safe. After `stop()`, the
   * query no longer re-runs and `subscribe()` becomes a no-op
   * (the returned unsubscribe is still callable and is also a
   * no-op).
   */
  stop(): void
}

/**
 * Internal subscription handle for an upstream source — left or
 * right side. The contract is just `subscribe(cb): unsubscribe`,
 * matching the existing `QuerySource.subscribe` and the new
 * `JoinableSource.subscribe` (added in #74).
 */
export interface LiveUpstream {
  subscribe(cb: () => void): () => void
}

/**
 * Build a LiveQuery from a `recompute` callback (typically the
 * Query's bound `toArray`) and a list of upstream sources to
 * subscribe to.
 *
 * The recompute fires once synchronously to populate the initial
 * value, then re-fires every time any upstream notifies. Errors
 * thrown by recompute are caught and stored in `error` instead of
 * propagating — see the file docstring for the rationale.
 */
export function buildLiveQuery<T>(
  recompute: () => T[],
  upstreams: readonly LiveUpstream[],
): LiveQuery<T> {
  return new LiveQueryImpl<T>(recompute, upstreams)
}

class LiveQueryImpl<T> implements LiveQuery<T> {
  private _value: readonly T[] = []
  private _error: Error | null = null
  private readonly listeners = new Set<() => void>()
  private readonly unsubs: Array<() => void> = []
  private stopped = false

  constructor(
    private readonly recompute: () => T[],
    upstreams: readonly LiveUpstream[],
  ) {
    // Initial compute. If this throws, the constructor still
    // succeeds — we want consumers to be able to render an error
    // state from `live.error` rather than wrapping every
    // `query.live()` call in a try/catch.
    this.refresh()
    for (const upstream of upstreams) {
      try {
        this.unsubs.push(upstream.subscribe(this.onUpstreamChange))
      } catch (err) {
        // Upstream subscription failed — record it as the live
        // error and continue with the upstreams that did work.
        // The LiveQuery is now degraded (won't re-fire on this
        // upstream's changes) but isn't broken; consumers can
        // detect this via `live.error`.
        this._error = err instanceof Error ? err : new Error(String(err))
      }
    }
  }

  get value(): readonly T[] {
    return this._value
  }

  get error(): Error | null {
    return this._error
  }

  /**
   * Bound change handler — used as the callback passed to every
   * upstream's subscribe. Bound via class field so the `this`
   * context survives the indirect call from arbitrary upstreams.
   */
  private readonly onUpstreamChange = (): void => {
    this.refresh()
    for (const cb of this.listeners) {
      try {
        cb()
      } catch {
        // Listener errors are isolated — one buggy consumer
        // doesn't break the others or tear down the live query.
      }
    }
  }

  private refresh(): void {
    if (this.stopped) return
    try {
      this._value = this.recompute()
      this._error = null
    } catch (err) {
      this._error = err instanceof Error ? err : new Error(String(err))
      // Don't clobber the previous value on error — consumers
      // typically want to keep showing the last known good state
      // alongside the error message rather than flashing to an
      // empty list.
    }
  }

  subscribe(cb: () => void): () => void {
    if (this.stopped) return () => {}
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    for (const unsub of this.unsubs) {
      try {
        unsub()
      } catch {
        // Unsub errors are swallowed — at this point we're tearing
        // down anyway and the failure is noise.
      }
    }
    this.unsubs.length = 0
    this.listeners.clear()
  }
}
