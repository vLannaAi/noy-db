/**
 * Reactive query primitive — `query.live()`.
 *
 * produces a `LiveQuery<T>` that re-runs the query and
 * updates its `value` whenever any source feeding it (the left
 * collection AND every right-side collection a join leg points at)
 * mutates.
 *
 * Framework-agnostic by design — core never depends on a UI
 * framework. The binding that wraps a `LiveQuery` is
 * `@noy-db/in-vue`'s `useLiveQuery(live)`: it subscribes once,
 * mirrors `value` into a `ShallowRef`, re-reads `error` on every
 * notification, and disposes via `onScopeDispose`.
 * `@noy-db/in-pinia`'s `store.liveQuery(build)` delegates to it, so
 * there is one implementation rather than two that drift (#1131).
 *
 * There is NO wrapper for `in-react`, `in-solid` or `in-svelte` — a
 * consumer on those subscribes directly (see **Error semantics**
 * below, which is the part a hand-rolled wrapper usually gets
 * wrong). Do not describe those adapters as existing until one does.
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
 * vault + name. Vault's `resolveSource` reads from
 * `collectionCache` so this assumption holds.
 *
 * **Delta maintenance (#1341).** A live query over a plan
 * `canMaintainIncrementally()` admits no longer re-runs: the change event
 * carries which record moved, and `LiveMaintainer` patches the result set —
 * one predicate evaluation, a binary search, a splice. The emitted value is
 * identical to a re-run's, because the maintainer is handed the query's OWN
 * membership test and sort comparator. Every other plan, and every
 * notification that arrives without a delta, re-runs exactly as before.
 *
 * **What .live() still does NOT do:**
 *   - No batching unless asked — `live({ batch: true })` coalesces a burst
 *     into one recompute + one notification on a microtask; the default stays
 *     one event in, one notification out, because batching makes `value`
 *     stale until the microtask runs.
 *   - No async notifications — every unbatched notification is synchronous
 *     within the source's change handler.
 *   - No re-planning under live mutations — the planner picks once
 *     at subscription time and reuses the same plan for every
 *     re-run.
 */

import type { LiveMaintainer, SourceChange } from './incremental.js'

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
   * Current snapshot of the query result.
   *
   * **A FRESH ARRAY on every successful re-run** — `refresh()` assigns
   * `this._value = this.recompute()`, and `recompute` is the query's own
   * `toArray()`. So the reference CHANGES on each change, and reference
   * identity is a valid change signal: a Vue `shallowRef`, a React
   * `useState`, or any `Object.is` comparison detects an update without
   * copying.
   *
   * The corollary is the part that bites: a consumer who reads `value`
   * ONCE and holds the array gets a snapshot that never updates. Read it
   * again after each notification — do not cache it.
   *
   * (An earlier version of this comment said the opposite — "updated in
   * place… the reference returned is the same array" — and told callers to
   * copy for change detection. Both halves were wrong, and the advice was
   * backwards. Verified against `buildLiveQuery`: two reads across a
   * notification are not `===`, and the first array still holds the old
   * contents.)
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
 * `JoinableSource.subscribe` (added in ).
 */
export interface LiveUpstream {
  /**
   * `cb` may be handed the delta that caused the notification (#1341) so the
   * live query can patch its result set instead of re-running. Calling it with
   * NO argument is always valid and always correct — it means "something
   * changed, I can't say what", and the live query answers with a full re-run.
   */
  subscribe(cb: (change?: SourceChange) => void): () => void
}

/** Options for {@link buildLiveQuery}. */
export interface LiveBuildOptions {
  /**
   * Coalesce a burst of upstream changes into ONE recompute and ONE
   * notification, flushed on a microtask (#1341). Off by default: with it on,
   * `live.value` is stale until the microtask runs, so a consumer that reads
   * synchronously after an `await put()` would see the old value.
   */
  readonly batch?: boolean
  /**
   * Incremental maintainer for this query's result set. When present it
   * REPLACES `recompute` as the value source — it patches per delta and
   * rebuilds itself whenever a delta is not provably patchable.
   */
  readonly maintainer?: LiveMaintainer
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
  options?: LiveBuildOptions,
): LiveQuery<T> {
  return new LiveQueryImpl<T>(recompute, upstreams, options)
}

class LiveQueryImpl<T> implements LiveQuery<T> {
  private _value: readonly T[] = []
  private _error: Error | null = null
  private readonly listeners = new Set<() => void>()
  private readonly unsubs: Array<() => void> = []
  private stopped = false

  private readonly maintainer: LiveMaintainer | undefined
  private readonly batch: boolean
  private queued: Array<SourceChange | undefined> = []
  private flushScheduled = false

  constructor(
    private readonly recompute: () => T[],
    upstreams: readonly LiveUpstream[],
    options?: LiveBuildOptions,
  ) {
    this.maintainer = options?.maintainer
    this.batch = options?.batch === true
    // From here on the maintainer is delta-driven: it patches on every event
    // and only rebuilds when it has to.
    this.maintainer?.attach()
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
  private readonly onUpstreamChange = (change?: SourceChange): void => {
    if (this.batch) {
      this.queued.push(change)
      if (!this.flushScheduled) {
        this.flushScheduled = true
        queueMicrotask(this.flush)
      }
      return
    }
    this.absorb([change])
    this.notify()
  }

  /**
   * Drain a coalesced burst: every queued delta is folded in, then the value
   * is read ONCE and listeners are notified ONCE.
   */
  private readonly flush = (): void => {
    this.flushScheduled = false
    const batch = this.queued
    this.queued = []
    if (this.stopped) return
    this.absorb(batch)
    this.notify()
  }

  private absorb(changes: ReadonlyArray<SourceChange | undefined>): void {
    if (this.stopped) return
    if (this.maintainer) {
      try {
        for (const change of changes) this.maintainer.apply(change)
      } catch {
        // A predicate threw mid-patch. Drop the maintained state and let the
        // read below rebuild: it runs the same predicate, so the consumer sees
        // exactly the error (and the preserved last-good value) a full re-run
        // would have produced.
        this.maintainer.invalidate()
      }
    }
    this.refresh()
  }

  private notify(): void {
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
      this._value = (this.maintainer ? this.maintainer.rows() : this.recompute()) as T[]
      this._error = null
    } catch (err) {
      this._error = err instanceof Error ? err : new Error(String(err))
      // Whatever the maintainer holds is no longer trustworthy — the next
      // read pays for a rebuild rather than serving a half-patched set.
      this.maintainer?.invalidate()
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
