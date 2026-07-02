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
export { InvertedIndex, type IndexDoc, type IndexHit, type QueryOptions } from './inverted-index.js'
export { extractSnippet } from './snippet.js'
export { MemoryIndexStore, type IndexStore } from './index-store.js'
export { buildStringFieldEntries } from './build-docs.js'
export type { RetrieveOptions, RetrieveHit } from './retrieve-types.js'
export { fuseRetrieval, type FuseOptions } from './fuse.js'

// Capability opt-in seam (S4): a collection's search / retrieve / similarTo /
// warmIndex / flushIndex methods (and the embedding write-hook) route through
// the searchStrategy, so they throw SearchNotEnabledError unless opted in.
export { withSearch } from './active.js'
export { NO_SEARCH, type SearchStrategy } from './strategy.js'
export { SearchNotEnabledError } from '../../kernel/errors.js'
