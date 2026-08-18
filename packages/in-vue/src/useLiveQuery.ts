import {
  shallowRef,
  ref,
  getCurrentScope,
  onScopeDispose,
  type ShallowRef,
  type Ref,
} from 'vue'
import type { LiveQuery } from '@noy-db/hub'

/**
 * Reactive handle over a hub `LiveQuery` (#1131).
 *
 * `items` updates whenever the left collection OR any joined right-side
 * collection mutates; `error` carries re-run errors as state; `stop()` tears
 * down the upstream subscriptions.
 */
export interface UseLiveQueryReturn<R> {
  /** Current rows. Replaced (not mutated) on every notification. */
  items: ShallowRef<readonly R[]>
  /**
   * Most recent re-run error, or `null`.
   *
   * `.live()` deliberately does NOT propagate a re-run throw — doing so would
   * tear down whatever upstream emitter is dispatching — so a
   * `DanglingReferenceError` from a strict-mode join arrives HERE rather than
   * as an exception. Render it; do not assume `items` is trustworthy while it
   * is set.
   */
  error: Ref<Error | null>
  /** Tear down upstream subscriptions. Idempotent; automatic on scope dispose. */
  stop: () => void
}

/**
 * Mirror a hub `LiveQuery` into Vue refs.
 *
 * This is the wrapper `kernel/query/live.ts` describes, and the ONE
 * implementation of it: `@noy-db/in-pinia`'s `store.liveQuery()` delegates
 * here rather than keeping a second copy, because two copies of subscription
 * glue drift and only one of them gets the error semantics fixed.
 *
 * ```ts
 * const { items, error } = useLiveQuery(
 *   vault.collection('bills').query().join('entityId', { as: 'entity' }).live(),
 * )
 * ```
 *
 * Three properties are easy to get wrong by hand, which is the reason this
 * exists rather than a snippet in the docs:
 *
 * 1. **`error` is re-read on EVERY notification**, not just at construction.
 *    A wrapper that reads it once reports the first failure and then renders
 *    stale rows silently forever.
 * 2. **`items` is assigned from `live.value`, which is a fresh array each
 *    re-run.** That is what makes a `shallowRef` sufficient; it is also why
 *    the array must be re-read rather than cached.
 * 3. **Teardown is registered only inside an active effect scope.** Outside
 *    one — a bare test harness, an SSR top-level — `onScopeDispose` would
 *    warn and never fire, so registration is skipped and `stop()` becomes the
 *    caller's job.
 */
export function useLiveQuery<R>(live: LiveQuery<R>): UseLiveQueryReturn<R> {
  const items = shallowRef<readonly R[]>(live.value)
  const error = ref<Error | null>(live.error)

  const unsubscribe = live.subscribe(() => {
    items.value = live.value
    error.value = live.error
  })

  let stopped = false
  const stop = (): void => {
    if (stopped) return
    stopped = true
    unsubscribe()
    live.stop()
  }

  // Auto-teardown when the calling scope (a component's setup, a store body,
  // or any user-created effectScope) disposes. Outside an active scope, skip
  // registration silently — the caller owns stop().
  if (getCurrentScope()) onScopeDispose(stop)

  return { items, error, stop }
}
