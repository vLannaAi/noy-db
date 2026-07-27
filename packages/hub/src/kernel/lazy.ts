/**
 * Memoized module loader for the S4 lazy-import seam (#846c).
 *
 * The spine and the services reach optional machinery through a dynamic
 * `import()` — that is what keeps a service out of the floor bundle for
 * consumers who never opt into it, and `check-architecture`'s `port-layering`
 * rule requires it for any spine→service edge. The pattern stays; this only
 * removes the ceremony that grew around it.
 *
 * Call sites had each re-invented the same shape: a `let mod = null` cache
 * declared *inside* the function (so it cached for one invocation and no
 * longer), plus in several places an `as { … }` cast, because destructuring a
 * dynamic import inline gave up the module's type.
 *
 * ```ts
 * const loadExecutor = lazy(() => import('./executor.js'))
 * // …
 * const { DerivationExecutor } = await loadExecutor()
 * ```
 *
 * Note this is about clarity, not speed: the ES module system already caches a
 * resolved module, so the win is one named binding per module instead of a
 * hand-rolled cache and a cast at every call site.
 *
 * Concurrent first calls share a single in-flight promise rather than each
 * starting their own `import()`.
 *
 * @internal
 */
export function lazy<T>(load: () => Promise<T>): () => Promise<T> {
  let cached: T | undefined
  let inflight: Promise<T> | undefined

  return async (): Promise<T> => {
    if (cached !== undefined) return cached
    inflight ??= load().then((mod) => {
      cached = mod
      inflight = undefined
      return mod
    })
    return inflight
  }
}
