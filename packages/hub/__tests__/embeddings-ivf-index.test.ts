/**
 * #1360 part 2 — IVF-flat unit behaviour.
 *
 * The index's contract is that it returns the SAME SHAPE of answer as
 * `VectorSet.cosineTopK` (one hit per record, best chunk, scores that are
 * cosines, `k` counting records) while being free to return a SUBSET of the
 * true top-k. Everything except that subset freedom is asserted exactly here;
 * the subset freedom is quantified in `embeddings-ivf-recall.test.ts`.
 */
import { describe, it, expect } from 'vitest'
import { IvfFlatIndex, defaultNlist } from '../src/with-lookup/embeddings/ivf-flat.js'
import { cosine } from '../src/with-lookup/embeddings/cosine.js'
import type { StoredVector } from '../src/with-lookup/embeddings/vector-set.js'

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

function vec(r: () => number, dim: number): Float32Array {
  const v = new Float32Array(dim)
  for (let i = 0; i < dim; i++) v[i] = r() * 2 - 1
  return v
}

function corpus(n: number, dim: number, seed = 7): StoredVector[] {
  const r = rng(seed)
  return Array.from({ length: n }, (_, i) => ({ id: `r${i}`, model: 'm', vec: vec(r, dim) }))
}

/** Exact top-k over the same records, for comparison. */
function exactTopK(vectors: readonly StoredVector[], q: Float32Array, k: number): string[] {
  return vectors
    .map((v) => ({ id: v.id, s: v.chunks ? Math.max(...v.chunks.map((c) => cosine(q, c.vec))) : cosine(q, v.vec!) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, k)
    .map((h) => h.id)
}

describe('#1360 IvfFlatIndex', () => {
  it('probing every list is exhaustive — same ids AND same scores as brute force', () => {
    // The load-bearing property: the approximation is entirely in WHICH lists
    // get scanned. Scan them all and the arithmetic must agree with cosine()
    // exactly, which is what lets `minScore` mean the same thing on both paths.
    const vectors = corpus(400, 32)
    const idx = new IvfFlatIndex({ nlist: 12, iterations: 3 })
    idx.build(vectors)
    const r = rng(99)
    for (let t = 0; t < 5; t++) {
      const q = vec(r, 32)
      const hits = idx.search(q, 10, { nprobe: idx.nlist })
      expect(hits.map((h) => h.id)).toEqual(exactTopK(vectors, q, 10))
      for (const h of hits) {
        const v = vectors.find((x) => x.id === h.id)!
        expect(h.score).toBeCloseTo(cosine(q, v.vec!), 5)
      }
    }
  })

  it('every point lands in exactly one list — size equals the corpus', () => {
    const vectors = corpus(500, 16)
    const idx = new IvfFlatIndex({ nlist: 20, iterations: 2 })
    idx.build(vectors)
    expect(idx.size).toBe(500)
  })

  it('scores a chunked record by its BEST chunk and returns that span, like the exact path', () => {
    const target = new Float32Array([1, 0, 0, 0])
    const vectors: StoredVector[] = [
      {
        id: 'doc', model: 'm',
        chunks: [
          { id: 'a', start: 0, end: 5, vec: new Float32Array([0, 1, 0, 0]) },
          { id: 'b', start: 5, end: 9, vec: new Float32Array([1, 0, 0, 0]) },
        ],
      },
      { id: 'other', model: 'm', vec: new Float32Array([0, 0, 1, 0]) },
    ]
    const idx = new IvfFlatIndex({ nlist: 2, iterations: 2 })
    idx.build(vectors)
    const hits = idx.search(target, 5, { nprobe: 2 })
    expect(hits[0]!.id).toBe('doc')
    expect(hits[0]!.chunk).toEqual({ id: 'b', start: 5, end: 9 })
    expect(hits[0]!.score).toBeCloseTo(1, 6)
    // `k` counts RECORDS: a two-chunk record is one hit, never two.
    expect(hits.filter((h) => h.id === 'doc')).toHaveLength(1)
  })

  it('upsert replaces a record in place — no duplicate hit, new vector wins', () => {
    const vectors = corpus(300, 8)
    const idx = new IvfFlatIndex({ nlist: 8, iterations: 2 })
    idx.build(vectors)
    const before = idx.size
    const q = new Float32Array([1, 0, 0, 0, 0, 0, 0, 0])
    idx.upsert({ id: 'r42', model: 'm', vec: new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]) })
    expect(idx.size).toBe(before)
    const hits = idx.search(q, 5, { nprobe: idx.nlist })
    expect(hits[0]!.id).toBe('r42')
    expect(hits.filter((h) => h.id === 'r42')).toHaveLength(1)
  })

  it('upsert can change a record from single-vector to chunked, and back', () => {
    const idx = new IvfFlatIndex({ nlist: 2, iterations: 2 })
    idx.build([{ id: 'a', model: 'm', vec: new Float32Array([1, 0]) }, { id: 'b', model: 'm', vec: new Float32Array([0, 1]) }])
    idx.upsert({ id: 'a', model: 'm', chunks: [
      { id: 'c0', start: 0, end: 1, vec: new Float32Array([1, 0]) },
      { id: 'c1', start: 1, end: 2, vec: new Float32Array([0, 1]) },
    ] })
    expect(idx.size).toBe(3)
    expect(idx.search(new Float32Array([1, 0]), 1, { nprobe: 2 })[0]!.chunk?.id).toBe('c0')
    idx.upsert({ id: 'a', model: 'm', vec: new Float32Array([1, 0]) })
    expect(idx.size).toBe(2)
    expect(idx.search(new Float32Array([1, 0]), 1, { nprobe: 2 })[0]!.chunk).toBeUndefined()
  })

  it('remove drops every point of a record and is idempotent', () => {
    const vectors = corpus(200, 8)
    const idx = new IvfFlatIndex({ nlist: 6, iterations: 2 })
    idx.build(vectors)
    idx.remove('r7')
    idx.remove('r7')
    expect(idx.size).toBe(199)
    const q = vectors.find((v) => v.id === 'r7')!.vec!
    expect(idx.search(q, 200, { nprobe: idx.nlist }).map((h) => h.id)).not.toContain('r7')
  })

  it('re-putting the same id repeatedly does not grow the index', () => {
    // Regression guard: freeing a record's slot on remove would mint a new one
    // on every write, and `put()` is remove-then-add.
    const idx = new IvfFlatIndex({ nlist: 4, iterations: 2 })
    idx.build(corpus(100, 8))
    for (let i = 0; i < 500; i++) idx.upsert({ id: 'r3', model: 'm', vec: new Float32Array([1, 0, 0, 0, 0, 0, 0, i / 500]) })
    expect(idx.size).toBe(100)
    expect(idx.search(new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]), 100, { nprobe: idx.nlist }).filter((h) => h.id === 'r3')).toHaveLength(1)
  })

  it('an incrementally built index (upsert only) answers like a batch-built one', () => {
    // Requirement: buildable incrementally as records are put, not only in bulk.
    const vectors = corpus(400, 16, 11)
    const batch = new IvfFlatIndex({ nlist: 10, iterations: 3 })
    batch.build(vectors)
    const incremental = new IvfFlatIndex({ nlist: 10, iterations: 3 })
    incremental.build(vectors.slice(0, 200))
    for (const v of vectors.slice(200)) incremental.upsert(v)
    expect(incremental.size).toBe(400)
    const r = rng(5)
    for (let t = 0; t < 5; t++) {
      const q = vec(r, 16)
      // Exhaustive probing makes both exact, so incremental assignment cannot
      // change the ANSWER — only which list a point sits in.
      expect(incremental.search(q, 10, { nprobe: incremental.nlist }).map((h) => h.id))
        .toEqual(batch.search(q, 10, { nprobe: batch.nlist }).map((h) => h.id))
    }
  })

  it('honours minScore and k', () => {
    const vectors = corpus(300, 8)
    const idx = new IvfFlatIndex({ nlist: 8, iterations: 2 })
    idx.build(vectors)
    const q = vec(rng(3), 8)
    expect(idx.search(q, 3, { nprobe: idx.nlist })).toHaveLength(3)
    for (const h of idx.search(q, 50, { nprobe: idx.nlist, minScore: 0.5 })) expect(h.score).toBeGreaterThanOrEqual(0.5)
    expect(idx.search(q, 0, { nprobe: idx.nlist })).toEqual([])
  })

  it('is deterministic — the same corpus and seed give the same index', () => {
    const vectors = corpus(300, 12, 21)
    const a = new IvfFlatIndex({ nlist: 9, iterations: 3 })
    const b = new IvfFlatIndex({ nlist: 9, iterations: 3 })
    a.build(vectors); b.build(vectors)
    const q = vec(rng(31), 12)
    expect(a.search(q, 10, { nprobe: 2 })).toEqual(b.search(q, 10, { nprobe: 2 }))
  })

  it('a zero-norm query returns nothing rather than an arbitrary list', () => {
    const idx = new IvfFlatIndex({ nlist: 4, iterations: 2 })
    idx.build(corpus(100, 8))
    expect(idx.search(new Float32Array(8), 5)).toEqual([])
  })

  it('a dimension-mismatched vector scores nothing, as cosine() would', () => {
    const idx = new IvfFlatIndex({ nlist: 2, iterations: 2 })
    idx.build([{ id: 'ok', model: 'm', vec: new Float32Array([1, 0, 0, 0]) }, { id: 'wrong', model: 'm', vec: new Float32Array([1, 0]) }])
    const hits = idx.search(new Float32Array([1, 0, 0, 0]), 5, { nprobe: 2 })
    expect(hits.map((h) => h.id)).toEqual(['ok'])
  })

  it('a zero vector scores 0 rather than NaN, matching cosine()', () => {
    const idx = new IvfFlatIndex({ nlist: 2, iterations: 2 })
    idx.build([{ id: 'zero', model: 'm', vec: new Float32Array([0, 0]) }, { id: 'a', model: 'm', vec: new Float32Array([-1, 0]) }])
    const hits = idx.search(new Float32Array([1, 0]), 5, { nprobe: 2 })
    expect(hits.find((h) => h.id === 'zero')!.score).toBe(0)
  })

  it('an empty corpus searches without throwing', () => {
    const idx = new IvfFlatIndex()
    idx.build([])
    expect(idx.search(new Float32Array([1, 0]), 5)).toEqual([])
    expect(idx.size).toBe(0)
  })

  it('reports staleness once churn has outgrown the fit', () => {
    const idx = new IvfFlatIndex({ nlist: 4, iterations: 2 })
    expect(idx.stale).toBe(true) // never built
    idx.build(corpus(100, 8))
    expect(idx.stale).toBe(false)
    for (let i = 0; i < 101; i++) idx.upsert({ id: `n${i}`, model: 'm', vec: new Float32Array(8).fill(0.1) })
    expect(idx.stale).toBe(true)
  })

  it('defaultNlist stays inside its band and grows with the corpus', () => {
    expect(defaultNlist(0)).toBe(4)
    expect(defaultNlist(10_000_000)).toBe(256)
    expect(defaultNlist(100_000)).toBeGreaterThan(defaultNlist(10_000))
  })
})
