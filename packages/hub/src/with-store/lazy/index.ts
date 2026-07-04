/**
 * `@noy-db/hub/lazy` — subpath export for the lazy service (#267).
 *
 * Lazy mode skips bulk hydration: a collection declared with
 * `prefetch: false` + a `cache` budget reads per-id from the store into a
 * bounded LRU working set (`list()`/`query()` throw — use `scan()` or
 * per-id `get()`). Opt in with `lazyStrategy: withLazy()` in createNoydb.
 *
 * Named re-exports (not `export *`) so tsup keeps the barrel populated
 * even with `sideEffects: false`.
 */
export { withLazy } from './active.js'
export { IMPLICIT_LAZY, type LazyStrategy } from './strategy.js'
export type { CacheOptions, CacheStats } from '../../kernel/collection.js'
