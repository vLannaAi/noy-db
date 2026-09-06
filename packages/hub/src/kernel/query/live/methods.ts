/**
 * #1458 — **Live**: the same plan, re-run on change.
 *
 * `subscribe` · `live`
 *
 * Bodies moved out of `kernel/query/builder.ts` unchanged; see
 * `../relate/methods.ts` for why `this.plan` still resolves.
 */
import type { DeclaredPredicate, InternalSource, QueryPlan } from '../builder.js'
import type { JoinContext } from '../relate/join.js'
import type { ReduceStrategy } from '../../../with-lookup/reduce/strategy.js'
import type { LiveQuery, LiveUpstream } from './live.js'
import { buildLiveQuery } from './live.js'
import type { LiveMaintainer } from './incremental.js'
import type { DateTruncKey } from '../reduce/date-trunc.js'
import type { GroupMaintenanceSource } from './incremental.js'
import { gateTerminal } from '../hydration.js'

/** @internal — the mixin whose prototype `./index.ts` copies onto `Query`. */
  /* eslint-disable @typescript-eslint/no-unused-vars -- #1458: the parameter
     list must match `Query`'s exactly (T, S, Q, M) because `declare module`
     merges this mixin's `Pick` into it, and TypeScript requires every
     declaration of an interface to carry identical type parameters. A group
     whose methods happen to use only `T` still declares all four. */
export class LiveMethods<
  T,
  S extends keyof T = never,
  Q extends keyof T & string = never,
  M extends keyof T & string = never,
  /* eslint-enable @typescript-eslint/no-unused-vars */
> {
  declare protected readonly source: InternalSource
  declare protected readonly plan: QueryPlan
  declare protected readonly joinContext: JoinContext | undefined
  declare protected readonly reduceStrategy: ReduceStrategy
  declare protected readonly predicates: ReadonlyMap<string, DeclaredPredicate> | undefined
  declare protected decodeVia: (records: readonly unknown[], locale?: string) => unknown[]
  declare protected incrementalMaintainer: (mode: 'rows' | 'records') => LiveMaintainer | undefined
  declare protected groupMaintenance: (derived: readonly DateTruncKey[]) => GroupMaintenanceSource | undefined
  declare toArray: (opts?: { locale?: string }) => T[]

  /**
   * Re-run the query whenever the source notifies of changes.
   * Returns an unsubscribe function. The callback receives the latest result.
   * Throws if the source does not support subscriptions.
   *
   * **For joined queries, prefer `.live()`** — `subscribe()`
   * only re-fires on LEFT-side changes, so joined data can be
   * stale if the right side mutates between emissions. `.live()`
   * merges change streams from every join target.
   */
  subscribe(cb: (result: T[]) => void): () => void {
    const _h = this.source.hydration
    if (_h !== undefined && !_h.isHydrated()) return gateTerminal(_h, 'subscribe', () => this.subscribe(cb))
    if (!this.source.subscribe) {
      throw new Error('Query source does not support subscriptions. Pass a source with a subscribe() method.')
    }
    cb(this.toArray())
    return this.source.subscribe(() => cb(this.toArray()))
  }

  /**
   * Reactive terminal — returns a `LiveQuery<T>` that re-runs the
   * query and updates its `value` whenever any source feeding it
   * mutates..
   *
   * For non-joined queries, `.live()` is a convenience over the
   * existing `.subscribe()` callback shape: a hand-rolled reactive
   * primitive with `value` / `error` fields and a `subscribe(cb)`
   * notification channel. Frame-agnostic — Vue / React / Solid
   * adapters wrap it in their own primitive.
   *
   * For joined queries, `.live()` additionally subscribes to every
   * join target's change stream. Mutations on a right-side
   * collection (insert / update / delete of a client referenced by
   * an invoice) re-fire the live query and re-evaluate every
   * dependent left row. Right-side targets are deduped by
   * collection name, so a chain that joins the same target twice
   * (e.g. billing client + shipping client → both 'clients') only
   * subscribes once.
   *
   * **Ref-mode behavior on right-side disappearance** — matches the
   * eager `.toArray()` contract from :
   *   - `strict`  → re-run throws `DanglingReferenceError`. The
   *     LiveQuery catches the throw, stores it in `live.error`, and
   *     notifies listeners (the throw does NOT propagate out of
   *     the source's change handler — that would tear down the
   *     emitter). Consumers check `live.error` after each
   *     notification and render an error state in the UI.
   *   - `warn`    → joined value flips to `null`; the existing
   *     warn-channel deduplication keeps repeated re-runs from
   *     spamming the console.
   *   - `cascade` → no special handling needed; the cascade-
   *     delete mechanism propagates the right-side delete into the
   *     left collection on the next tick, and the live query
   *     naturally re-fires with the orphaned left rows gone.
   *
   * Always call `live.stop()` when finished — it tears down every
   * upstream subscription. The Vue layer's `onUnmounted` hook
   * should call `stop()` automatically; raw consumers must do it
   * themselves.
   *
   * **Incremental maintenance (#1341).** For a plan
   * `incrementalMaintainer()` accepts — no joins, no `.filter(fn)`, no
   * label-sort, and nothing an index would serve in index order (an `==`/`in`
   * probe, #1344's sorted-index range, or #1344's `orderBy(f).limit(n)`
   * index page) — the result set is PATCHED per change
   * event instead of re-run: one predicate evaluation for the changed record,
   * a binary search, a splice. Everything else, and any change event that
   * arrives without a delta, still re-runs the whole plan. Either way the
   * emitted value is identical to `toArray()` — the maintainer reuses this
   * query's own membership test and sort comparator.
   *
   * `options.batch` coalesces a burst of changes into one recompute and one
   * notification on a microtask. It is OFF by default because it makes
   * `live.value` stale until the microtask runs: a consumer that reads
   * synchronously after `await put()` would see the previous value.
   *
   * **Limitations:**
   *   - No re-planning under live mutations — the planner picks
   *     once at subscription time and reuses the same plan.
   *   - Streaming live joins are deferred.
   */
  live(options?: { batch?: boolean }): LiveQuery<T> {
    const _h = this.source.hydration
    if (_h !== undefined && !_h.isHydrated()) return gateTerminal(_h, 'live', () => this.live(options))
    const upstreams: LiveUpstream[] = []

    // Left-side change stream — every live query subscribes to
    // its source if the source supports subscriptions.
    if (this.source.subscribe) {
      const leftSubscribe = this.source.subscribe.bind(this.source)
      upstreams.push({
        subscribe: (cb: () => void) => leftSubscribe(cb),
      })
    }

    // Right-side change streams — only for joined queries. Dedup
    // by target name so a chain joining the same target twice
    // doesn't double-subscribe and double-fire on every right-side
    // mutation.
    if (this.plan.joins.length > 0 && this.joinContext) {
      const subscribed = new Set<string>()
      for (const leg of this.plan.joins) {
        if (subscribed.has(leg.target)) continue
        subscribed.add(leg.target)
        const rightSource = this.joinContext.resolveSource(leg.target)
        if (rightSource?.subscribe) {
          const rightSubscribe = rightSource.subscribe.bind(rightSource)
          upstreams.push({
            subscribe: (cb: () => void) => rightSubscribe(cb),
          })
        }
      }
    }

    // Cross-join right-side change streams — symmetric with FK joins above.
    if (this.joinContext) {
      const subscribedCross = new Set<string>()
      for (const clause of this.plan.clauses) {
        if (clause.type !== 'crossJoin') continue
        if (subscribedCross.has(clause.target)) continue
        subscribedCross.add(clause.target)
        const rightSource = this.joinContext.resolveSource(clause.target)
        if (rightSource?.subscribe) {
          const rightSubscribe = rightSource.subscribe.bind(rightSource)
          upstreams.push({
            subscribe: (cb: () => void) => rightSubscribe(cb),
          })
        }
      }
    }

    // The recompute is just toArray bound to this query — same
    // pipeline as eager execution, including join application. It stays the
    // fallback even when a maintainer is attached.
    const maintainer = this.incrementalMaintainer('rows')
    return buildLiveQuery<T>(() => this.toArray(), upstreams, {
      ...(options?.batch === true ? { batch: true } : {}),
      ...(maintainer ? { maintainer } : {}),
    })
  }
}

/** The public Live surface — merged into `Query` by `./index.ts`. */
export type LiveSurface<
  T,
  S extends keyof T = never,
  Q extends keyof T & string = never,
  M extends keyof T & string = never,
> = Pick<LiveMethods<T, S, Q, M>, 'subscribe' | 'live'>
