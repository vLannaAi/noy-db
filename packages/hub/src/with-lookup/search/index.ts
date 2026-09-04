/**
 * Search service — scan-mode full-text search.
 *
 * Tree-shakeable: only reaches the bundle when `collection.search()` is called.
 * The store-usable blind index (SSE) is a separate, gated opt-in and not
 * built here.
 */
export { tokenize, type Tokenizer } from './tokenize.js'
export { searchScan, type SearchOptions, type SearchResult, type SearchEntry } from './scan.js'
export { segmentTokens, segmentTokenizer, type Token } from './segment.js'
export { InvertedIndex, type IndexDoc, type IndexHit, type QueryOptions, type IndexBuildOptions, type IndexSnapshot } from './inverted-index.js'
export { extractSnippet } from './snippet.js'
export { MemoryIndexStore, type IndexStore } from './index-store.js'
export { buildStringFieldEntries, type FieldEntry } from './build-docs.js'
export type { RetrieveOptions, RetrieveHit, SimilarToOptions } from './retrieve-types.js'
export { fuseRetrieval, type FuseOptions } from './fuse.js'

// #1360 part 2 — the approximate vector index opt-in. `withVectorIndex` is the
// ONLY door to `ivf-flat.js`, and it opens it with a dynamic import, so a
// consumer of this barrel who never calls it ships none of the algorithm.
export { withVectorIndex, DEFAULT_INDEX_MIN_VECTORS, type VectorIndexOptions } from '../embeddings/with-vector-index.js'
export type { VectorIndex, VectorIndexConfig, VectorIndexSearchOptions } from '../embeddings/vector-index.js'

// Capability opt-in seam (S4): a collection's search / retrieve / similarTo /
// warmIndex / flushIndex methods (and the embedding write-hook) route through
// the searchStrategy, so they throw SearchNotEnabledError unless opted in.
export { withSearch } from './active.js'
export { NO_SEARCH, type SearchStrategy } from './strategy.js'
export { SearchNotEnabledError } from '../../kernel/errors.js'
