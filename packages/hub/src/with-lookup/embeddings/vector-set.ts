/** In-memory vector set for L2 semantic retrieval. Loaded once per session from
 *  decrypted _vec sidecars (injected loader), brute-force cosine kNN, model-guarded.
 *  #1360 part 2 adds an OPT-IN approximate index in front of the brute force. */
import { cosine } from './cosine.js'
import type { EmbeddingChunk, StoredChunk } from './chunks.js'
import type { VectorIndex, VectorIndexConfig } from './vector-index.js'
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

/** Options accepted by {@link VectorSet.topK}. */
export interface VectorTopKOptions {
  readonly minScore?: number
  readonly expectModel?: string
  /**
   * Force the exact brute-force scan for this query, whatever the corpus size
   * and whatever `index` the descriptor declares. Exactness stays REACHABLE:
   * an approximate default that cannot be turned off is a correctness change
   * dressed as a performance one.
   */
  readonly exact?: boolean
  /** Per-query recall dial; overrides the configured `nprobe`. Ignored on the exact path. */
  readonly nprobe?: number
}

/** Points contributed by one stored record — chunked records contribute one per chunk. */
function pointsIn(v: StoredVector): number {
  if (v.chunks && v.chunks.length > 0) return v.chunks.length
  return v.vec ? 1 : 0
}

export class VectorSet {
  private vectors: StoredVector[] | undefined
  /** id → position in `vectors`, so an incremental write is O(1), not O(n). */
  private posById = new Map<string, number>()
  /** model → live record count, so the model guard is O(1) per query on the indexed path. */
  private modelCounts = new Map<string, number>()
  private points = 0
  private index: VectorIndex | undefined
  private indexing: Promise<void> | undefined
  /**
   * Set when a build produced NO partitions — a corpus of nothing but
   * zero-norm or mismatched-dimension vectors. An empty index answers every
   * query with `[]`, which is a WRONG answer rather than a slow one (the exact
   * path scores those vectors 0 and returns them), so the set falls back to
   * brute force and does not retry the build on every query.
   */
  private indexUnusable = false

  /**
   * `indexConfig` is `withVectorIndex()`'s return value, taken from the
   * collection's `embeddings.index`. Absent — the overwhelmingly common case —
   * and this class behaves exactly as it did before #1360 part 2.
   */
  constructor(private readonly indexConfig?: VectorIndexConfig) {}

  get loaded(): boolean { return this.vectors !== undefined }
  /** Live VECTOR count (chunks included) — what `minVectors` is compared against. */
  get pointCount(): number { return this.points }
  /** Test/benchmark introspection: whether an approximate index is currently serving queries. */
  get indexed(): boolean { return this.index !== undefined }

  async ensureLoaded(load: () => Promise<StoredVector[]>): Promise<void> {
    if (this.vectors !== undefined) return
    const loaded = await load()
    this.vectors = loaded
    this.posById = new Map()
    this.modelCounts = new Map()
    this.points = 0
    for (let i = 0; i < loaded.length; i++) {
      const v = loaded[i]!
      this.posById.set(v.id, i)
      this.points += pointsIn(v)
      this.modelCounts.set(v.model, (this.modelCounts.get(v.model) ?? 0) + 1)
    }
    this.index = undefined
    this.indexUnusable = false
  }

  markDirty(): void {
    this.vectors = undefined
    this.posById = new Map()
    this.modelCounts = new Map()
    this.points = 0
    this.index = undefined
    this.indexing = undefined
    this.indexUnusable = false
  }

  /**
   * Incrementally insert or replace one record's vectors.
   *
   * This is what makes an approximate index viable at all here. `markDirty()`
   * drops the whole set, so before #1360 part 2 every `put()` cost a full
   * re-load on the next query — survivable for a brute-force scan that has no
   * build step, fatal for an index whose build is tens of query-equivalents.
   * `embedOnWrite` already holds the vectors it just encoded, so it can hand
   * them over instead of throwing the set away.
   *
   * No-op when the set is not loaded: an unloaded set is already "dirty", and
   * the next query loads everything from the sidecars anyway.
   */
  upsert(vector: StoredVector): void {
    const all = this.vectors
    if (all === undefined) return
    const at = this.posById.get(vector.id)
    if (at !== undefined) {
      const prev = all[at]!
      this.points -= pointsIn(prev)
      this.decModel(prev.model)
      all[at] = vector
    } else {
      this.posById.set(vector.id, all.length)
      all.push(vector)
    }
    this.points += pointsIn(vector)
    this.modelCounts.set(vector.model, (this.modelCounts.get(vector.model) ?? 0) + 1)
    this.index?.upsert(vector)
  }

  /**
   * Incrementally drop one record's vectors. Removal is a SWAP with the last
   * element, not a splice: `vectors` order is whatever `adapter.list()`
   * returned and has never been part of any contract, so preserving it would
   * buy nothing and cost an O(n) index rebuild on every `forget()`.
   */
  removeRecord(id: string): void {
    const all = this.vectors
    if (all === undefined) return
    const at = this.posById.get(id)
    if (at === undefined) return
    const removed = all[at]!
    this.points -= pointsIn(removed)
    this.decModel(removed.model)
    const last = all.pop()!
    if (at < all.length) { all[at] = last; this.posById.set(last.id, at) }
    this.posById.delete(id)
    this.index?.remove(id)
  }

  private decModel(model: string): void {
    const n = (this.modelCounts.get(model) ?? 0) - 1
    if (n <= 0) this.modelCounts.delete(model)
    else this.modelCounts.set(model, n)
  }

  /**
   * Brute-force cosine kNN, one hit per RECORD. **Always exact.**
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

  /**
   * kNN under the collection's policy: approximate when an index is opted in
   * AND the corpus is at or above `minVectors`, exact otherwise.
   *
   * ⭐ The default below the threshold is EXACT, deliberately: an index that
   * builds on a 300-vector collection pays a build the queries can never
   * amortise, and buys a recall cliff for a scan that was already sub-millisecond.
   */
  async topK(query: Float32Array, k: number, opts: VectorTopKOptions = {}): Promise<VectorHit[]> {
    const cfg = this.indexConfig
    if (opts.exact === true || cfg === undefined || this.indexUnusable || this.points < cfg.minVectors) {
      return this.cosineTopK(query, k, opts)
    }
    // The exact path throws per-vector on a model mismatch as it scans; the
    // indexed path never scans every vector, so the same guard has to be a set
    // membership test. Same error, same trigger, O(1).
    if (opts.expectModel !== undefined) {
      for (const model of this.modelCounts.keys()) {
        if (model !== opts.expectModel) throw new EmbeddingModelMismatchError(opts.expectModel, model)
      }
    }
    await this.ensureIndex(cfg)
    const idx = this.index
    if (idx === undefined) return this.cosineTopK(query, k, opts)
    return idx.search(query, k, {
      ...(opts.minScore !== undefined ? { minScore: opts.minScore } : {}),
      ...(opts.nprobe !== undefined ? { nprobe: opts.nprobe } : {}),
    })
  }

  /** Build (or rebuild, once churn has made it stale) the index. Concurrency-safe. */
  private async ensureIndex(cfg: VectorIndexConfig): Promise<void> {
    if (this.index !== undefined && !this.index.stale) return
    if (this.indexing !== undefined) return this.indexing
    const build = (async () => {
      const idx = await cfg.create()
      idx.build(this.vectors ?? [])
      if (idx.nlist === 0) { this.indexUnusable = true; this.index = undefined; return }
      this.index = idx
    })()
    this.indexing = build
    try { await build } finally { this.indexing = undefined }
  }
}
