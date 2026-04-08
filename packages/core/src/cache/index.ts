/**
 * Cache module — barrel export.
 *
 * Tree-shakeable: importing this barrel without setting `cache:` on a
 * Collection does not pull in the LRU runtime, since `Lru` is the only
 * entry point.
 */

export { Lru } from './lru.js'
export type { LruEntry, LruOptions, LruStats } from './lru.js'
export { parseBytes, estimateRecordBytes } from './policy.js'
