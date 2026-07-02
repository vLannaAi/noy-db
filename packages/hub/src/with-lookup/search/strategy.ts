/**
 * Search capability strategy — the on-demand collection-level retrieval
 * operations the `Collection` routes through: scan-mode full-text `search`,
 * unified `retrieve` (lexical | semantic | hybrid), raw-vector `similarTo`, and
 * the lexical-index lifecycle (`warmIndex` / `flushIndex`). The active engine
 * ({@link withSearch}) dynamically imports the search/retrieval facade (keeping
 * it out of the floor bundle); {@link NO_SEARCH} throws.
 *
 * The embedding write-hook (`embedOnWrite`) is paired here too: opting into
 * `withSearch()` enables both the query surface AND the put()-time vector
 * compute — a vector that no gated `similarTo` / semantic `retrieve` could read
 * is dead weight, so embedding compute is not separately gatable. `Collection`
 * always assembles the per-call {@link SearchContext} and delegates here, so an
 * un-opted-in caller hits `NO_SEARCH`'s throw.
 * @internal
 */
import type { SearchContext } from './collection-facade.js'
import type { SearchOptions, SearchResult } from './index.js'
import type { RetrieveOptions, RetrieveHit } from './retrieve-types.js'
import { SearchNotEnabledError } from '../../kernel/errors.js'

export interface SearchStrategy {
  search<T>(ctx: SearchContext<T>, field: string, query: string, opts?: SearchOptions): Promise<SearchResult<T>[]>
  retrieve<T>(ctx: SearchContext<T>, query: string, opts?: RetrieveOptions<T>): Promise<RetrieveHit<T>[]>
  similarTo<T>(ctx: SearchContext<T>, vector: Float32Array, opts?: { k?: number; minScore?: number; includeRecord?: boolean }): Promise<RetrieveHit<T>[]>
  warmIndex<T>(ctx: SearchContext<T>): Promise<void>
  flushIndex<T>(ctx: SearchContext<T>): Promise<void>
  embedOnWrite<T>(ctx: SearchContext<T>, id: string, record: T, version: number): Promise<void>
}

/**
 * No-op stub — the floor default. Every capability method (and the embedding
 * write-hook) throws {@link SearchNotEnabledError}; opt in with
 * `searchStrategy: withSearch()` in createNoydb. @internal
 */
export const NO_SEARCH: SearchStrategy = {
  async search() { throw new SearchNotEnabledError() },
  async retrieve() { throw new SearchNotEnabledError() },
  async similarTo() { throw new SearchNotEnabledError() },
  async warmIndex() { throw new SearchNotEnabledError() },
  async flushIndex() { throw new SearchNotEnabledError() },
  async embedOnWrite() { throw new SearchNotEnabledError() },
}
