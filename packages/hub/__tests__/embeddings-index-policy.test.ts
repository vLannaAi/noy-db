/**
 * #1360 part 2 — WHEN the approximate index is used, and the guarantee that
 * exactness stays reachable.
 *
 * Three separable decisions, tested separately because they fail separately:
 *   1. no `index` on the descriptor  → always exact (the untouched default);
 *   2. opted in but below `minVectors` → still exact (don't pay below the crossover);
 *   3. `{ exact: true }` on the call  → exact regardless of 1 and 2.
 */
import { describe, it, expect, vi } from 'vitest'
import { VectorSet, type StoredVector } from '../src/with-lookup/embeddings/vector-set.js'
import { withVectorIndex, DEFAULT_INDEX_MIN_VECTORS } from '../src/with-lookup/embeddings/with-vector-index.js'
import { EmbeddingModelMismatchError } from '../src/kernel/errors.js'

function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function corpus(n: number, dim = 16, seed = 3): StoredVector[] {
  const r = rng(seed)
  return Array.from({ length: n }, (_, i) => {
    const v = new Float32Array(dim)
    for (let d = 0; d < dim; d++) v[d] = r() * 2 - 1
    return { id: `r${i}`, model: 'm', vec: v }
  })
}
const q = (dim = 16): Float32Array => { const v = new Float32Array(dim); v[0] = 1; v[3] = 0.5; return v }

describe('#1360 vector index policy', () => {
  it('no index opt-in: topK is cosineTopK, and no index is ever built', async () => {
    const vs = new VectorSet()
    const vectors = corpus(500)
    await vs.ensureLoaded(async () => vectors)
    expect(await vs.topK(q(), 10)).toEqual(vs.cosineTopK(q(), 10))
    expect(vs.indexed).toBe(false)
  })

  it('opted in but below minVectors: still exact, still no index', async () => {
    const cfg = withVectorIndex({ minVectors: 1000 })
    const create = vi.spyOn(cfg, 'create')
    const vs = new VectorSet(cfg)
    const vectors = corpus(500)
    await vs.ensureLoaded(async () => vectors)
    expect(await vs.topK(q(), 10)).toEqual(vs.cosineTopK(q(), 10))
    expect(vs.indexed).toBe(false)
    // Not merely "the answer was exact" — the ALGORITHM was never even linked.
    expect(create).not.toHaveBeenCalled()
  })

  it('at or above minVectors: the index is built and serves the query', async () => {
    const vs = new VectorSet(withVectorIndex({ minVectors: 100, nlist: 8 }))
    await vs.ensureLoaded(async () => corpus(500))
    await vs.topK(q(), 10)
    expect(vs.indexed).toBe(true)
  })

  it('{ exact: true } bypasses a built index and never builds one', async () => {
    const cfg = withVectorIndex({ minVectors: 100, nlist: 8 })
    const create = vi.spyOn(cfg, 'create')
    const vs = new VectorSet(cfg)
    const vectors = corpus(500)
    await vs.ensureLoaded(async () => vectors)
    expect(await vs.topK(q(), 10, { exact: true })).toEqual(vs.cosineTopK(q(), 10))
    expect(create).not.toHaveBeenCalled()
    // …and it stays exact after the index exists.
    await vs.topK(q(), 10)
    expect(vs.indexed).toBe(true)
    expect(await vs.topK(q(), 10, { exact: true })).toEqual(vs.cosineTopK(q(), 10))
  })

  it('nprobe = nlist makes the approximate path exhaustive — identical to exact', async () => {
    const vs = new VectorSet(withVectorIndex({ minVectors: 100, nlist: 8 }))
    const vectors = corpus(500)
    await vs.ensureLoaded(async () => vectors)
    const approx = await vs.topK(q(), 10, { nprobe: 8 })
    expect(approx.map((h) => h.id)).toEqual(vs.cosineTopK(q(), 10).map((h) => h.id))
  })

  it('counts VECTORS, not records — chunking crosses the threshold sooner', async () => {
    const chunked: StoredVector[] = Array.from({ length: 50 }, (_, i) => ({
      id: `d${i}`, model: 'm',
      chunks: Array.from({ length: 4 }, (_, c) => ({ id: `c${c}`, start: c, end: c + 1, vec: new Float32Array([c === 0 ? 1 : 0, i / 50]) })),
    }))
    const vs = new VectorSet(withVectorIndex({ minVectors: 150, nlist: 4 }))
    await vs.ensureLoaded(async () => chunked)
    expect(vs.pointCount).toBe(200) // 50 records, 200 vectors
    await vs.topK(new Float32Array([1, 0]), 5)
    expect(vs.indexed).toBe(true)
  })

  it('the model guard fires on the approximate path too', async () => {
    const vs = new VectorSet(withVectorIndex({ minVectors: 10, nlist: 4 }))
    await vs.ensureLoaded(async () => [...corpus(50), { id: 'odd', model: 'other', vec: new Float32Array(16) }])
    await expect(vs.topK(q(), 5, { expectModel: 'm' })).rejects.toBeInstanceOf(EmbeddingModelMismatchError)
    expect(() => vs.cosineTopK(q(), 5, { expectModel: 'm' })).toThrow(EmbeddingModelMismatchError)
  })

  it('the documented default threshold is the measured crossover', () => {
    expect(DEFAULT_INDEX_MIN_VECTORS).toBe(20_000)
    expect(withVectorIndex().minVectors).toBe(DEFAULT_INDEX_MIN_VECTORS)
    expect(withVectorIndex().nprobe).toBe(8)
  })
})

describe('#1360 incremental set maintenance', () => {
  it('upsert adds, replaces and keeps the exact path in step', async () => {
    const vs = new VectorSet()
    await vs.ensureLoaded(async () => corpus(10))
    expect(vs.pointCount).toBe(10)
    vs.upsert({ id: 'new', model: 'm', vec: new Float32Array(16).fill(0).map((_, i) => (i === 0 ? 1 : 0)) as Float32Array })
    expect(vs.pointCount).toBe(11)
    expect((await vs.topK(q(), 1))[0]!.id).toBe('new')
    vs.upsert({ id: 'new', model: 'm', vec: new Float32Array(16) })
    expect(vs.pointCount).toBe(11)
    expect((await vs.topK(q(), 1))[0]!.id).not.toBe('new')
  })

  it('removeRecord drops it from results and is a no-op for an unknown id', async () => {
    const vs = new VectorSet()
    await vs.ensureLoaded(async () => corpus(20))
    const top = (await vs.topK(q(), 1))[0]!.id
    vs.removeRecord(top)
    vs.removeRecord('nope')
    expect(vs.pointCount).toBe(19)
    expect((await vs.topK(q(), 20)).map((h) => h.id)).not.toContain(top)
  })

  it('upsert / removeRecord on an unloaded set are no-ops, not a partial load', async () => {
    const vs = new VectorSet()
    vs.upsert({ id: 'a', model: 'm', vec: new Float32Array([1]) })
    vs.removeRecord('a')
    expect(vs.loaded).toBe(false)
    let loads = 0
    await vs.ensureLoaded(async () => { loads++; return corpus(5) })
    expect(loads).toBe(1)
    expect(vs.pointCount).toBe(5)
  })

  it('an index built then churned past staleness is rebuilt, not left drifting', async () => {
    const cfg = withVectorIndex({ minVectors: 10, nlist: 4 })
    const create = vi.spyOn(cfg, 'create')
    const vs = new VectorSet(cfg)
    await vs.ensureLoaded(async () => corpus(20))
    await vs.topK(q(), 5)
    expect(create).toHaveBeenCalledTimes(1)
    for (let i = 0; i < 25; i++) vs.upsert({ id: `x${i}`, model: 'm', vec: new Float32Array(16).fill(0.2) })
    await vs.topK(q(), 5)
    expect(create).toHaveBeenCalledTimes(2)
  })

  it('markDirty still forces a full reload — the escape hatch is intact', async () => {
    const vs = new VectorSet(withVectorIndex({ minVectors: 10, nlist: 4 }))
    let loads = 0
    await vs.ensureLoaded(async () => { loads++; return corpus(20) })
    await vs.topK(q(), 5)
    vs.markDirty()
    expect(vs.loaded).toBe(false)
    expect(vs.indexed).toBe(false)
    await vs.ensureLoaded(async () => { loads++; return corpus(20) })
    expect(loads).toBe(2)
  })
})

describe('#1360 degenerate corpora fall back rather than answering emptily', () => {
  it('a corpus of only zero-norm vectors is answered exactly, not with []', async () => {
    // An IVF fit over zero vectors yields no centroids, and an index with no
    // lists returns nothing for every query. The exact path scores them 0 and
    // returns them, so silently keeping the empty index would turn a slow
    // correct answer into a fast wrong one.
    const cfg = withVectorIndex({ minVectors: 5, nlist: 4 })
    const vs = new VectorSet(cfg)
    const zeros: StoredVector[] = Array.from({ length: 20 }, (_, i) => ({ id: `z${i}`, model: 'm', vec: new Float32Array(16) }))
    await vs.ensureLoaded(async () => zeros)
    const hits = await vs.topK(q(), 5)
    expect(hits).toHaveLength(5)
    expect(hits.every((h) => h.score === 0)).toBe(true)
    expect(vs.indexed).toBe(false)
  })
})
