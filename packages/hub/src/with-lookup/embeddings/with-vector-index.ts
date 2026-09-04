/**
 * `withVectorIndex()` — the opt-in for the approximate vector index (#1360).
 *
 * ```ts
 * import { withVectorIndex } from '@noy-db/hub/search'
 *
 * const col = vault.collection('docs', {
 *   embeddings: { source: 'body', encode, dim: 768, model: 'e5-base',
 *                 index: withVectorIndex({ nprobe: 12 }) },
 * })
 * ```
 *
 * Three properties, each load-bearing:
 *
 * 1. **Opt-in.** No `index` on the descriptor and every search is exact brute
 *    force, byte for byte the pre-#1360 path. Nothing about this file runs.
 * 2. **Tree-shaken.** The algorithm arrives through `await import()` inside
 *    {@link create}, so a consumer of `@noy-db/hub/search` who never calls
 *    this function never links `ivf-flat.js` into any chunk.
 * 3. **Still gated by scale even once opted in.** {@link
 *    VectorIndexConfig.minVectors} defaults to the measured crossover, so a
 *    small corpus pays no build cost and gets exact answers — opting in
 *    declares a willingness to index, not an instruction to index now.
 */
import type { VectorIndex, VectorIndexConfig } from './vector-index.js'

export interface VectorIndexOptions {
  /**
   * Stay exact below this many VECTORS. Default 20,000.
   *
   * Chosen from `vector-brute-force.bench.ts`: below ~20k points the
   * brute-force scan is inside a 100 ms interactive budget at every dimension
   * measured (the tightest row, 1536d, crosses at ~18-48k depending on the
   * machine), and IVF's build — tens of brute-force-query-equivalents — has no
   * query volume to amortise against down there. Counts POINTS, not records — #1360
   * chunking puts one point per chunk, so 2,500 documents at 8 chunks each
   * already crosses this.
   */
  readonly minVectors?: number
  /**
   * Lists probed per query — **the recall dial**. Default 8.
   *
   * Recall rises monotonically with `nprobe`, and `nprobe = nlist` is
   * exhaustive — the same answer as brute force, by construction.
   *
   * MEASURED recall@10 at this default, against exact brute force on a
   * clustered corpus: **0.895** (768d, 100k vectors), **0.942** (384d, 100k),
   * **0.918** (1536d, 50k), **0.928** (64d, 20k — the CI assertion in
   * `__tests__/embeddings-ivf-recall.test.ts`). Raising it to 16 buys ~0.95
   * for roughly double the scan.
   *
   * Raise it when a miss costs more than a millisecond — and prefer
   * `{ exact: true }` on the query over `nprobe: nlist` when the answer must
   * be exact, because that says what you mean and survives an `nlist` change.
   */
  readonly nprobe?: number
  /** Partitions. Default: derived from the corpus size — see `defaultNlist`. */
  readonly nlist?: number
  /** Points sampled to fit the centroids. Default 4096. */
  readonly sampleSize?: number
  /** Lloyd iterations over the sample. Default 6. */
  readonly iterations?: number
  /** k-means++ seed. Default fixed, so the same corpus yields the same index. */
  readonly seed?: number
}

/** Vectors below which an opted-in collection still answers exactly. */
export const DEFAULT_INDEX_MIN_VECTORS = 20_000

export function withVectorIndex(opts: VectorIndexOptions = {}): VectorIndexConfig {
  const minVectors = opts.minVectors ?? DEFAULT_INDEX_MIN_VECTORS
  const nprobe = opts.nprobe ?? 8
  const nlist = opts.nlist
  const sampleSize = opts.sampleSize ?? 4096
  const iterations = opts.iterations ?? 6
  const seed = opts.seed ?? 0x9e3779b9
  return {
    minVectors, nprobe, nlist, sampleSize, iterations, seed,
    async create(): Promise<VectorIndex> {
      const { IvfFlatIndex } = await import('./ivf-flat.js')
      return new IvfFlatIndex({ nlist, nprobe, sampleSize, iterations, seed })
    },
  }
}
