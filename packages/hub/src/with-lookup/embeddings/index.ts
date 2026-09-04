export { cosine } from './cosine.js'
export { embeddingSourceText, type EmbeddingDescriptor } from './descriptor.js'
export { VectorSet, type StoredVector, type VectorHit } from './vector-set.js'
export { withVectorIndex, DEFAULT_INDEX_MIN_VECTORS, type VectorIndexOptions } from './with-vector-index.js'
export type { VectorIndex, VectorIndexConfig, VectorIndexSearchOptions } from './vector-index.js'
export { encodeVecId } from './vec-id.js'
export {
  deriveChunkVectors,
  normalizeChunkSpans,
  type EmbeddingChunk,
  type EmbeddingChunkSpan,
  type StoredChunk,
} from './chunks.js'
