/**
 * Search subsystem (#308) — scan-mode full-text search.
 *
 * Tree-shakeable: only reaches the bundle when `collection.search()` is called.
 * The store-usable blind index (SSE) is a separate, gated opt-in specified in
 * the #308 design note and not built here.
 */
export { tokenize, type Tokenizer } from './tokenize.js'
export { searchScan, type SearchOptions, type SearchResult, type SearchEntry } from './scan.js'
export { segmentTokens, segmentTokenizer, type Token } from './segment.js'
export { InvertedIndex, type IndexDoc, type IndexHit, type QueryOptions } from './inverted-index.js'
export { extractSnippet } from './snippet.js'
export { MemoryIndexStore, type IndexStore } from './index-store.js'
export { buildStringFieldEntries } from './build-docs.js'
export type { RetrieveOptions, RetrieveHit } from './retrieve-types.js'
