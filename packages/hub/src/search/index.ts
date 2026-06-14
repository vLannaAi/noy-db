/**
 * Search subsystem (#308) — scan-mode full-text search.
 *
 * Tree-shakeable: only reaches the bundle when `collection.search()` is called.
 * The store-usable blind index (SSE) is a separate, gated opt-in specified in
 * the #308 design note and not built here.
 */
export { tokenize, type Tokenizer } from './tokenize.js'
export { searchScan, type SearchOptions, type SearchResult, type SearchEntry } from './scan.js'
