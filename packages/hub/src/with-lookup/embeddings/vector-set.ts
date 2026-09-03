/** In-memory vector set for L2 semantic retrieval. Loaded once per session from
 *  decrypted _vec sidecars (injected loader), brute-force cosine kNN, model-guarded. */
import { cosine } from './cosine.js'
import type { EmbeddingChunk, StoredChunk } from './chunks.js'
import { EmbeddingModelMismatchError } from '../../kernel/errors.js'

/**
 * One record's vectors. Exactly one of `vec` (whole-record, the pre-#1360
 * shape) and `chunks` (sub-document, #1360) is populated by the loader; a row
 * with neither is inert and scores nothing.
 */
export interface StoredVector {
  readonly id: string
  readonly model: string
  readonly vec?: Float32Array
  /** #1360 — sub-document chunks. When present, the record is scored by its BEST chunk. */
  readonly chunks?: readonly StoredChunk[]
}
export interface VectorHit {
  readonly id: string
  readonly score: number
  /** #1360 — the winning chunk's span, when the record was scored via chunks. */
  readonly chunk?: EmbeddingChunk
}

export class VectorSet {
  private vectors: StoredVector[] | undefined
  get loaded(): boolean { return this.vectors !== undefined }

  async ensureLoaded(load: () => Promise<StoredVector[]>): Promise<void> {
    if (this.vectors === undefined) this.vectors = await load()
  }

  markDirty(): void { this.vectors = undefined }

  /**
   * Brute-force cosine kNN, one hit per RECORD.
   *
   * #1360 best-chunk folding: a chunked record contributes its single BEST
   * chunk score, never one hit per chunk and never a sum. Summing would make a
   * long document outrank a short exact match purely for having more chunks —
   * the folding is what keeps the score comparable across record lengths, and
   * what keeps `k` a count of records rather than of fragments.
   */
  cosineTopK(query: Float32Array, k: number, opts: { minScore?: number; expectModel?: string } = {}): VectorHit[] {
    const all = this.vectors ?? []
    const minScore = opts.minScore ?? -Infinity
    const hits: VectorHit[] = []
    for (const v of all) {
      if (opts.expectModel !== undefined && v.model !== opts.expectModel) {
        throw new EmbeddingModelMismatchError(opts.expectModel, v.model)
      }
      if (v.chunks && v.chunks.length > 0) {
        let best: StoredChunk | undefined
        let bestScore = -Infinity
        for (const c of v.chunks) {
          const s = cosine(query, c.vec)
          if (s > bestScore) { bestScore = s; best = c }
        }
        if (best !== undefined && bestScore >= minScore) {
          hits.push({ id: v.id, score: bestScore, chunk: { id: best.id, start: best.start, end: best.end } })
        }
        continue
      }
      if (!v.vec) continue
      const score = cosine(query, v.vec)
      if (score >= minScore) hits.push({ id: v.id, score })
    }
    hits.sort((a, b) => b.score - a.score)
    return hits.slice(0, k)
  }
}
