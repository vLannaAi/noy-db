/**
 * Enable the lazy service (#267 Track A tail — lazy-mode promoted out of
 * `routing` into its own opt-in service).
 *
 * Pass to `createNoydb({ lazyStrategy: withLazy() })` to explicitly opt
 * into lazy mode's bounded-LRU working set for collections declared with
 * `prefetch: false` + a `cache` budget. Behavior is identical to the
 * deprecated implicit path (which warns once and will be removed at 1.0) —
 * opting in is the forward-stable spelling and the catalog's contract.
 */
import type { LazyStrategy } from './strategy.js'
import { buildLazyCache } from './strategy.js'

export function withLazy(): LazyStrategy {
  return {
    createCache(collection, cache) {
      return buildLazyCache(collection, cache)
    },
  }
}
