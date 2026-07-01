/**
 * Enable the search / retrieval capability (#308).
 * Pass to `createNoydb({ searchStrategy: withSearch() })` to make a collection's
 * `search` / `retrieve` / `similarTo` / `warmIndex` / `flushIndex` methods live,
 * and to enable the put()-time embedding-vector compute for collections that
 * declare an `embeddings` config. The search/retrieval engine is dynamically
 * imported here, so it stays out of the floor bundle until opted in.
 */
import type { SearchStrategy } from './strategy.js'

export function withSearch(): SearchStrategy {
  return {
    async search(ctx, field, query, opts) {
      const { search } = await import('./collection-facade.js')
      return search(ctx, field, query, opts)
    },
    async retrieve(ctx, query, opts) {
      const { retrieve } = await import('./collection-facade.js')
      return retrieve(ctx, query, opts)
    },
    async similarTo(ctx, vector, opts) {
      const { similarTo } = await import('./collection-facade.js')
      return similarTo(ctx, vector, opts)
    },
    async warmIndex(ctx) {
      const { warmIndex } = await import('./collection-facade.js')
      return warmIndex(ctx)
    },
    async flushIndex(ctx) {
      const { flushIndex } = await import('./collection-facade.js')
      return flushIndex(ctx)
    },
    async embedOnWrite(ctx, id, record, version) {
      const { embedOnWrite } = await import('./collection-facade.js')
      return embedOnWrite(ctx, id, record, version)
    },
  }
}
