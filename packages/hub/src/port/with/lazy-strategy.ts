/**
 * Lazy-mode capability contract (#267 Track A tail — lazy-mode promoted out
 * of `routing` into its own `lazy` service). Lives on the `/with` port (the
 * one seam the kernel spine may import statically) so `Collection` can hold
 * the back-compat default without a spine→service static import.
 *
 * Lazy mode (`prefetch: false`) skips bulk hydration: reads go per-id
 * against the store and land in a bounded LRU working set. The strategy owns
 * constructing that LRU:
 *
 *  - `withLazy()` (`with-store/lazy/active.ts`, subpath `@noy-db/hub/lazy`)
 *    is the explicit catalog opt-in — silent, forward-stable.
 *  - {@link IMPLICIT_LAZY} is the floor default reached when a collection
 *    declares `prefetch: false` WITHOUT `lazyStrategy: withLazy()`. It keeps
 *    the pre-#267 behavior byte-for-byte (back-compat delegation, pre-1.0)
 *    but emits a one-time deprecation warn outside test env. It will become
 *    a throwing stub at 1.0, letting the LRU leave the floor bundle
 *    entirely once the per-record-CEK cache stops pinning `Lru` there.
 *
 * The on-demand read/write branches themselves stay kernel-resident (they
 * are `if (this.lazy)` forks on the hot get/put/scan paths); the service
 * seam owns cache construction + budget validation, which is where the
 * opt-in and the future tree-shake win live.
 * @internal
 */
import { Lru, parseBytes } from '../../kernel/cache/index.js'
import type { CacheOptions } from '../../kernel/collection.js'

export interface LazyStrategy {
  /**
   * Build the bounded LRU working-set cache for a lazy collection.
   * MUST throw when `cache` declares neither `maxRecords` nor `maxBytes` —
   * an unbounded lazy cache defeats the purpose.
   */
  createCache<V>(collection: string, cache: CacheOptions | undefined): Lru<string, V>
}

/**
 * Shared budget validation + LRU construction — the one implementation both
 * {@link IMPLICIT_LAZY} and `withLazy()` run, so the two paths cannot drift.
 * @internal
 */
export function buildLazyCache<V>(collection: string, cache: CacheOptions | undefined): Lru<string, V> {
  if (!cache || (cache.maxRecords === undefined && cache.maxBytes === undefined)) {
    throw new Error(
      `Collection "${collection}": lazy mode (prefetch: false) requires a cache option ` +
      `with maxRecords and/or maxBytes. An unbounded lazy cache defeats the purpose.`,
    )
  }
  const lruOptions: { maxRecords?: number; maxBytes?: number } = {}
  if (cache.maxRecords !== undefined) lruOptions.maxRecords = cache.maxRecords
  if (cache.maxBytes !== undefined) lruOptions.maxBytes = parseBytes(cache.maxBytes)
  return new Lru<string, V>(lruOptions)
}

let implicitLazyWarned = false

/**
 * Back-compat default (deprecated): `prefetch: false` without
 * `lazyStrategy: withLazy()`. Identical behavior to the explicit opt-in,
 * plus a one-time deprecation warn (suppressed under NODE_ENV=test,
 * mirroring the listPage fallback warn). @internal
 */
export const IMPLICIT_LAZY: LazyStrategy = {
  createCache<V>(collection: string, cache: CacheOptions | undefined): Lru<string, V> {
    if (!implicitLazyWarned) {
      implicitLazyWarned = true
      if (!(typeof process !== 'undefined' && process.env['NODE_ENV'] === 'test')) {
        console.warn(
          `[noy-db] Collection "${collection}": lazy mode (prefetch: false) without the lazy ` +
          `service is deprecated — pass \`lazyStrategy: withLazy()\` (from "@noy-db/hub/lazy") ` +
          `to createNoydb(). The implicit path will be removed at 1.0.`,
        )
      }
    }
    return buildLazyCache<V>(collection, cache)
  },
}
