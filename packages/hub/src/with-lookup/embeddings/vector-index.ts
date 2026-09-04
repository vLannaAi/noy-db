/**
 * The approximate-index seam (#1360 part 2).
 *
 * This module holds **types only** — no algorithm. That is load-bearing for
 * tree-shaking: `VectorSet` and the search facade reference an ANN index
 * exclusively through {@link VectorIndex} (erased at build time) and through
 * {@link VectorIndexConfig.create}, which the opt-in factory
 * (`withVectorIndex()`) fills with a `await import('./ivf-flat.js')`. A
 * consumer who never calls `withVectorIndex()` never links `ivf-flat.js` —
 * not statically, not into a chunk it loads. `bundle-check`'s `search`
 * scenario asserts exactly that, across every emitted chunk and not just the
 * entry.
 *
 * ⛔ Do not add a value export here, and do not import `ivf-flat.js` from
 * anywhere on the always-reachable path. Both would silently turn an opt-in
 * into a tax on every consumer of `@noy-db/hub/search`.
 */
import type { StoredVector, VectorHit } from './vector-set.js'

/** Per-query knobs. `nprobe` is the recall dial — see {@link VectorIndexConfig}. */
export interface VectorIndexSearchOptions {
  readonly minScore?: number
  /** Override the configured `nprobe` for this query only. Higher = better recall, slower. */
  readonly nprobe?: number
}

/**
 * An in-hub approximate nearest-neighbour index over a collection's decrypted
 * vectors. Lives entirely above the trust boundary: it is built from plaintext
 * vectors already in memory and is never serialised to the store, so no
 * backend ever holds a vector.
 */
export interface VectorIndex {
  /** (Re)build from scratch over the whole vector set. */
  build(vectors: readonly StoredVector[]): void
  /** Insert or replace one record's vectors (whole-record or chunked). */
  upsert(vector: StoredVector): void
  /** Drop every point belonging to `recordId`. No-op if absent. */
  remove(recordId: string): void
  /** Approximate top-k, one hit per RECORD (best chunk), highest score first. */
  search(query: Float32Array, k: number, opts?: VectorIndexSearchOptions): VectorHit[]
  /** Live point count (vectors, not records — a chunked record contributes one point per chunk). */
  readonly size: number
  /**
   * True when incremental churn has drifted the partitioning far enough from
   * the corpus it was fitted to that a rebuild is cheaper than the recall loss.
   */
  readonly stale: boolean
  /** Introspection for the benchmark and for tests — never a behavioural input. */
  readonly nlist: number
}

/**
 * What `withVectorIndex()` returns and what a collection's
 * `embeddings.index` holds. Everything is a number except `create`, which is
 * the dynamic-import seam.
 */
export interface VectorIndexConfig {
  /**
   * Below this many VECTORS the index is not built and search stays exact.
   * Chunking multiplies vectors per record, so this counts points, not records.
   */
  readonly minVectors: number
  /** Default lists probed per query — the recall dial. */
  readonly nprobe: number
  /** Number of partitions; `undefined` = derive from the corpus size. */
  readonly nlist: number | undefined
  /** Points sampled to fit the centroids (the full corpus is only assigned, never clustered). */
  readonly sampleSize: number
  /** Lloyd iterations over the sample. */
  readonly iterations: number
  /** Seed for the deterministic k-means++ init — same corpus, same index, every run. */
  readonly seed: number
  /** Lazily link and construct the implementation. */
  create(): Promise<VectorIndex>
}
