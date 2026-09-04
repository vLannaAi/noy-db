/**
 * IVF-flat — the approximate vector index (#1360 part 2).
 *
 * ## Why IVF-flat and not HNSW
 *
 * The choice is a build-cost argument, not a taste one, and the numbers are in
 * `test-harnesses/benchmarks/src/vector-ann-index.bench.ts`.
 *
 * Every index here is paid for **once per session**: the vector set is loaded
 * from the encrypted `_vec` sidecars into memory, so an index built over it
 * dies with the process. There is no persisted index to amortise against —
 * `_vec` holds vectors, never a graph — so the only question that matters is
 * *how many queries does the build cost, and how many does it save?*
 *
 * - **IVF-flat** builds in `n · nlist` dot products = exactly `nlist`
 *   brute-force queries, and `nlist` is a knob we choose. At the defaults it is
 *   tens of query-equivalents, and one query then costs ~`(nlist + nprobe ·
 *   n/nlist)/n` of a brute-force scan.
 * - **HNSW** builds in `n · log n · efConstruction` distance computations —
 *   hundreds to thousands of query-equivalents at the same corpus — and its
 *   deletes need tombstones plus periodic graph repair. It wins on
 *   queries-per-second at *very* large n with a *persisted* graph. Neither
 *   condition holds here.
 *
 * The deciding property is that a noy-db collection is mutable: `put()` and
 * `forget()` run constantly, and IVF handles both in `O(nlist)` (assign to the
 * nearest centroid / splice out of one list) with no graph to repair.
 *
 * ## The scoring identity — why this is exact arithmetic on an approximate set
 *
 * Cosine is scale-invariant, so with a unit-normalised query `q̂`:
 *
 *     cosine(q, v) = dot(q̂, v) · (1/‖v‖)
 *
 * The index therefore stores the **caller's own `Float32Array` by reference**
 * plus one scalar `1/‖v‖` per point, and never a normalised copy. That is the
 * difference between `O(n)` and `O(n·d)` of index memory: at 100k × 768 a
 * normalised copy would be another ~300 MB. Scores this class returns are the
 * same numbers `cosine()` returns, bit for bit up to float association order —
 * so a hit's score is comparable with an exact hit's score, and `minScore`
 * means the same thing on both paths.
 *
 * ## What is approximate, and where recall goes
 *
 * Only the CANDIDATE SET is approximate: a true neighbour whose point sits in
 * an unprobed list is missed. `nprobe` is the dial; recall is measured, not
 * assumed (`__tests__/embeddings-ivf-recall.test.ts` and the benchmark).
 *
 * ⭐ Chunking interacts here: a record is scored by its best chunk *among the
 * probed lists*. A record whose best chunk is unprobed can still be returned
 * via a weaker chunk, with a lower score than exact search would give it. That
 * is a score difference, not only a membership difference, and it is why the
 * recall test compares folded RECORD results rather than raw points.
 *
 * ⚠️ **Ties do not order identically to the exact path**, even at `nprobe =
 * nlist`. Both sort by score with a stable sort, but over different scan
 * orders, so two records holding the SAME score can swap places. Neither path
 * ever promised a tie-break order. A real embedding corpus has no exact ties;
 * a test with a toy encoder is full of them, so compare by score there.
 */
import type { EmbeddingChunk } from './chunks.js'
import type { StoredVector, VectorHit } from './vector-set.js'
import type { VectorIndex, VectorIndexSearchOptions } from './vector-index.js'

/**
 * Default partition count for a corpus of `n` points.
 *
 * Build cost is `nlist` brute-force-query-equivalents and query cost is
 * roughly `(nlist + nprobe·n/nlist)/n` of one, so `nlist` trades build against
 * query *linearly in opposite directions*.
 *
 * MEASURED (768d, 100,000 vectors, `nprobe: 8`; full table in
 * `test-harnesses/benchmarks/src/vector-ann-index.bench.ts`):
 *
 * | nlist       | scan  | speedup | recall@10 | build         |
 * |-------------|-------|---------|-----------|---------------|
 * | 79 = √n/4   | 10.3% |  9.7x   | 0.895     |  56 queries   |
 * | 316 = √n    |  3.0% | 33.8x   | 0.813     | 288 queries   |
 *
 * √n is the better index and the worse DEFAULT. This index is per-session —
 * it is rebuilt from the decrypted sidecars every time the process starts and
 * is never persisted — so a build has only this session's queries to amortise
 * against, and 288 query-equivalents is a bad opening bid for a consumer who
 * runs a dozen searches. `√n/4` costs ~56 and still cuts the scan by 10x.
 * A long-lived query-heavy session should override it; that is what the knob
 * is for. The CAP (256) matters as much as the formula: it bounds the build at
 * the top end, where an uncapped √n grows without limit.
 */
export function defaultNlist(n: number): number {
  return Math.max(4, Math.min(256, Math.round(Math.sqrt(n) / 4)))
}

/** Deterministic PRNG — the index must be identical across runs for a given corpus. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!
  return s
}

/** `1/‖v‖`, or 0 for a zero vector — which makes its score 0, exactly as `cosine()` does. */
function invNorm(v: Float32Array): number {
  let n = 0
  for (let i = 0; i < v.length; i++) n += v[i]! * v[i]!
  return n === 0 ? 0 : 1 / Math.sqrt(n)
}

interface IvfParams {
  readonly nlist: number | undefined
  readonly nprobe: number
  readonly sampleSize: number
  readonly iterations: number
  readonly seed: number
}

const IVF_DEFAULTS: IvfParams = {
  nlist: undefined,
  nprobe: 8,
  sampleSize: 4096,
  iterations: 6,
  seed: 0x9e3779b9,
}

export class IvfFlatIndex implements VectorIndex {
  private readonly params: IvfParams

  /** Unit-length partition representatives, `nlist` of them. */
  private centroids: Float32Array[] = []
  /** `lists[c]` = point slots assigned to centroid `c`. */
  private lists: number[][] = []

  // Points, as parallel arrays. A "point" is one vector: a whole-record vector
  // or one chunk of a chunked record. Parallel arrays rather than an object
  // per point because at the gating scale there are hundreds of thousands of
  // them and per-object overhead would dwarf the payload we deliberately
  // refused to copy.
  private pVec: (Float32Array | undefined)[] = []
  private pInv: number[] = []
  private pRecord: number[] = []
  private pChunk: (EmbeddingChunk | undefined)[] = []
  /** Owning list, or -1 for a free slot. */
  private pList: number[] = []

  private recordIds: string[] = []
  private slotOfRecord = new Map<string, number>()
  private pointsOfRecord = new Map<string, number[]>()
  private freeSlots: number[] = []
  private live = 0
  private builtAt = 0
  /**
   * Points actually scored by the last {@link search} — the deterministic
   * measure of what the index bought.
   *
   * Wall-clock speedup is not reproducible on a loaded machine (measured: the
   * same cell varied 100x across reps while other work ran), but the fraction
   * of the corpus a query touches is exact arithmetic and identical on every
   * machine. The benchmark reports both and treats this as the primary number;
   * latency follows from it and the brute-force table's µs-per-vector.
   */
  lastProbedPoints = 0

  constructor(params: Partial<IvfParams> = {}) {
    this.params = { ...IVF_DEFAULTS, ...params }
  }

  get size(): number { return this.live }
  get nlist(): number { return this.centroids.length }

  /**
   * Rebuild when the corpus has doubled or halved since the fit. Incremental
   * upserts assign to EXISTING centroids, so a set that grew 10x around new
   * topics is partitioned by a map of the old ones — recall decays silently,
   * which is the failure mode this flag exists to stop.
   */
  get stale(): boolean {
    if (this.centroids.length === 0) return true
    return this.live > this.builtAt * 2 || this.live * 2 < this.builtAt
  }

  build(vectors: readonly StoredVector[]): void {
    this.centroids = []
    this.lists = []
    this.pVec = []; this.pInv = []; this.pRecord = []; this.pChunk = []; this.pList = []
    this.recordIds = []
    this.slotOfRecord = new Map()
    this.pointsOfRecord = new Map()
    this.freeSlots = []
    this.live = 0

    // Materialise the points first (unassigned), then fit, then assign.
    for (const v of vectors) this.addPoints(v, -1)
    this.builtAt = this.live

    const dim = this.firstDim()
    if (dim === 0) return
    const k = Math.max(1, Math.min(this.params.nlist ?? defaultNlist(this.live), this.live))
    this.centroids = fitCentroids(this.sampleUnitVectors(dim), k, this.params)
    // No centroids means no usable vector to fit on — every point was
    // zero-norm or off-dimension. Leave the points unassigned; `nlist === 0`
    // is the signal `VectorSet` reads to fall back to the exact scan, which
    // scores those vectors 0 rather than dropping them.
    if (this.centroids.length === 0) return
    this.lists = Array.from({ length: this.centroids.length }, () => [] as number[])
    for (let p = 0; p < this.pVec.length; p++) {
      if (this.pVec[p] === undefined) continue
      this.assign(p)
    }
  }

  upsert(vector: StoredVector): void {
    this.remove(vector.id)
    this.addPoints(vector, -1)
    if (this.centroids.length === 0) return
    for (const p of this.pointsOfRecord.get(vector.id) ?? []) if (this.pList[p] === -1) this.assign(p)
  }

  remove(recordId: string): void {
    const pts = this.pointsOfRecord.get(recordId)
    if (!pts) return
    for (const p of pts) {
      const l = this.pList[p]!
      if (l >= 0) {
        const list = this.lists[l]!
        const at = list.indexOf(p)
        if (at >= 0) { list[at] = list[list.length - 1]!; list.pop() }
      }
      this.pVec[p] = undefined
      this.pChunk[p] = undefined
      this.pList[p] = -1
      this.freeSlots.push(p)
      this.live--
    }
    this.pointsOfRecord.delete(recordId)
    // The record's SLOT is deliberately kept. `put()` on an existing id is
    // remove-then-add, and freeing the slot there would mint a new one on
    // every write — unbounded growth on the hottest path. A slot is 8 bytes
    // and one string; a re-put reuses it.
  }

  search(query: Float32Array, k: number, opts: VectorIndexSearchOptions = {}): VectorHit[] {
    if (k <= 0 || this.centroids.length === 0) return []
    const qi = invNorm(query)
    const minScore = opts.minScore ?? -Infinity
    // A zero-norm query scores 0 against everything (cosine's contract). There
    // is no meaningful ranking to approximate, so answer exactly rather than
    // returning whichever list the arbitrary probe order happened to pick.
    if (qi === 0) return []
    const qn = new Float32Array(query.length)
    for (let i = 0; i < query.length; i++) qn[i] = query[i]! * qi

    const nprobe = Math.max(1, Math.min(opts.nprobe ?? this.params.nprobe, this.centroids.length))
    const probes = this.topCentroids(qn, nprobe)
    this.lastProbedPoints = 0

    // Fold to one hit per RECORD by best chunk, exactly as the exact path does
    // — `k` counts records, never fragments.
    const best = new Map<number, { score: number; chunk: EmbeddingChunk | undefined }>()
    for (const c of probes) {
      this.lastProbedPoints += this.lists[c]!.length
      for (const p of this.lists[c]!) {
        const v = this.pVec[p]
        if (v === undefined || v.length !== qn.length) continue
        const score = dot(qn, v) * this.pInv[p]!
        const r = this.pRecord[p]!
        const cur = best.get(r)
        if (cur === undefined || score > cur.score) best.set(r, { score, chunk: this.pChunk[p] })
      }
    }
    const hits: VectorHit[] = []
    for (const [r, b] of best) {
      if (b.score < minScore) continue
      hits.push(b.chunk ? { id: this.recordIds[r]!, score: b.score, chunk: b.chunk } : { id: this.recordIds[r]!, score: b.score })
    }
    hits.sort((a, b) => b.score - a.score)
    return hits.slice(0, k)
  }

  /**
   * A deterministic fixed-stride sample of the corpus, unit-normalised — the
   * only place the index materialises normalised copies, and it is bounded by
   * `sampleSize` rather than by `n`. A stride (not a random draw) so the fit
   * is reproducible without spending the PRNG, which is saved for k-means++
   * seeding where it actually buys recall.
   */
  private sampleUnitVectors(dim: number): Float32Array[] {
    const slots = this.pVec.length
    const want = Math.min(slots, this.params.sampleSize)
    const stride = Math.max(1, Math.floor(slots / Math.max(1, want)))
    const sample: Float32Array[] = []
    for (let p = 0; p < slots && sample.length < want; p += stride) {
      const v = this.pVec[p]
      const inv = this.pInv[p]!
      if (v === undefined || inv === 0 || v.length !== dim) continue
      const u = new Float32Array(dim)
      for (let i = 0; i < dim; i++) u[i] = v[i]! * inv
      sample.push(u)
    }
    return sample
  }

  private firstDim(): number {
    for (const v of this.pVec) if (v !== undefined && v.length > 0) return v.length
    return 0
  }

  private topCentroids(qn: Float32Array, nprobe: number): number[] {
    // nlist is capped at 256, so a full scan + partial selection is cheaper
    // than any heap — and it is a rounding error next to the list scan.
    const scores = new Float64Array(this.centroids.length)
    for (let c = 0; c < this.centroids.length; c++) {
      const cv = this.centroids[c]!
      scores[c] = cv.length === qn.length ? dot(qn, cv) : -Infinity
    }
    const order: number[] = []
    for (let c = 0; c < scores.length; c++) order.push(c)
    order.sort((a, b) => scores[b]! - scores[a]!)
    return order.slice(0, nprobe)
  }

  private assign(p: number): void {
    const v = this.pVec[p]
    if (v === undefined || this.centroids.length === 0) return
    let bestC = 0
    let bestS = -Infinity
    const inv = this.pInv[p]!
    for (let c = 0; c < this.centroids.length; c++) {
      const cv = this.centroids[c]!
      if (cv.length !== v.length) continue
      const s = dot(cv, v) * inv
      if (s > bestS) { bestS = s; bestC = c }
    }
    this.pList[p] = bestC
    this.lists[bestC]!.push(p)
  }

  private recordSlot(id: string): number {
    const existing = this.slotOfRecord.get(id)
    if (existing !== undefined) return existing
    const slot = this.recordIds.length
    this.recordIds.push(id)
    this.slotOfRecord.set(id, slot)
    return slot
  }

  /** Materialise one record's points into free slots. `list` -1 = unassigned. */
  private addPoints(v: StoredVector, list: number): void {
    const r = this.recordSlot(v.id)
    const pts: number[] = []
    const push = (vec: Float32Array, chunk: EmbeddingChunk | undefined): void => {
      const p = this.freeSlots.pop() ?? this.pVec.length
      this.pVec[p] = vec
      this.pInv[p] = invNorm(vec)
      this.pRecord[p] = r
      this.pChunk[p] = chunk
      this.pList[p] = list
      pts.push(p)
      this.live++
    }
    if (v.chunks && v.chunks.length > 0) {
      for (const c of v.chunks) push(c.vec, { id: c.id, start: c.start, end: c.end })
    } else if (v.vec) {
      push(v.vec, undefined)
    }
    if (pts.length > 0) this.pointsOfRecord.set(v.id, pts)
  }
}

/**
 * Spherical k-means over a deterministic SAMPLE, not the corpus.
 *
 * Clustering all `n` points would cost `iterations · n · k · d`; assigning
 * them once costs `n · k · d`. Fitting on a sample makes the iterations free
 * relative to the single unavoidable assignment pass, which is the whole
 * reason IVF's build stays affordable at the #1360 gating scale.
 */
function fitCentroids(sample: readonly Float32Array[], k: number, params: IvfParams): Float32Array[] {
  if (sample.length === 0) return []
  const dim = sample[0]!.length
  const kk = Math.min(k, sample.length)

  // k-means++ seeding on unit vectors, weighting by squared cosine distance.
  const rand = mulberry32(params.seed)
  const centroids: Float32Array[] = [sample[Math.floor(rand() * sample.length)]!.slice()]
  const best = new Float64Array(sample.length).fill(Infinity)
  while (centroids.length < kk) {
    const last = centroids[centroids.length - 1]!
    let total = 0
    for (let i = 0; i < sample.length; i++) {
      const d = 1 - dot(sample[i]!, last)
      const w = d * d
      if (w < best[i]!) best[i] = w
      total += best[i]!
    }
    if (total === 0) break
    let target = rand() * total
    let pick = sample.length - 1
    for (let i = 0; i < sample.length; i++) { target -= best[i]!; if (target <= 0) { pick = i; break } }
    centroids.push(sample[pick]!.slice())
  }

  // Lloyd, spherical: mean, then re-normalise. An empty cluster KEEPS its
  // previous centroid rather than being re-seeded — a dead list costs one
  // wasted centroid comparison per query, whereas re-seeding mid-fit makes the
  // result depend on the iteration count in a way nothing else here does.
  for (let it = 0; it < params.iterations; it++) {
    const sums = Array.from({ length: centroids.length }, () => new Float64Array(dim))
    const counts = new Int32Array(centroids.length)
    for (const u of sample) {
      let bc = 0, bs = -Infinity
      for (let c = 0; c < centroids.length; c++) {
        const s = dot(u, centroids[c]!)
        if (s > bs) { bs = s; bc = c }
      }
      const acc = sums[bc]!
      for (let i = 0; i < dim; i++) acc[i]! += u[i]!
      counts[bc]!++
    }
    for (let c = 0; c < centroids.length; c++) {
      if (counts[c] === 0) continue
      const acc = sums[c]!
      let n = 0
      for (let i = 0; i < dim; i++) n += acc[i]! * acc[i]!
      if (n === 0) continue
      const inv = 1 / Math.sqrt(n)
      const cv = centroids[c]!
      for (let i = 0; i < dim; i++) cv[i] = acc[i]! * inv
    }
  }
  return centroids
}
