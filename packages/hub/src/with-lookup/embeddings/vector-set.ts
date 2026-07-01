/** In-memory vector set for L2 semantic retrieval (#308). Loaded once per session from
 *  decrypted _vec sidecars (injected loader), brute-force cosine kNN, model-guarded. */
import { cosine } from './cosine.js'
import { EmbeddingModelMismatchError } from '../../kernel/errors.js'

export interface StoredVector { readonly id: string; readonly vec: Float32Array; readonly model: string }
export interface VectorHit { readonly id: string; readonly score: number }

export class VectorSet {
  private vectors: StoredVector[] | undefined
  get loaded(): boolean { return this.vectors !== undefined }

  async ensureLoaded(load: () => Promise<StoredVector[]>): Promise<void> {
    if (this.vectors === undefined) this.vectors = await load()
  }

  markDirty(): void { this.vectors = undefined }

  cosineTopK(query: Float32Array, k: number, opts: { minScore?: number; expectModel?: string } = {}): VectorHit[] {
    const all = this.vectors ?? []
    const minScore = opts.minScore ?? -Infinity
    const hits: VectorHit[] = []
    for (const v of all) {
      if (opts.expectModel !== undefined && v.model !== opts.expectModel) {
        throw new EmbeddingModelMismatchError(opts.expectModel, v.model)
      }
      const score = cosine(query, v.vec)
      if (score >= minScore) hits.push({ id: v.id, score })
    }
    hits.sort((a, b) => b.score - a.score)
    return hits.slice(0, k)
  }
}
