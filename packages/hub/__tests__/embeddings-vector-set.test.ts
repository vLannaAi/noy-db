// packages/hub/__tests__/embeddings-vector-set.test.ts
import { describe, it, expect } from 'vitest'
import { VectorSet, type StoredVector } from '../src/embeddings/vector-set.js'
import { EmbeddingModelMismatchError } from '../src/errors.js'

const vecs: StoredVector[] = [
  { id: 'a', vec: new Float32Array([1, 0, 0]), model: 'm1' },
  { id: 'b', vec: new Float32Array([0.9, 0.1, 0]), model: 'm1' },
  { id: 'c', vec: new Float32Array([0, 1, 0]), model: 'm1' },
]

describe('VectorSet (#308 L2)', () => {
  it('loads once (load fn not called twice) and ranks by cosine', async () => {
    const vs = new VectorSet()
    let calls = 0
    const load = async () => { calls++; return vecs }
    await vs.ensureLoaded(load); await vs.ensureLoaded(load)
    expect(calls).toBe(1); expect(vs.loaded).toBe(true)
    const hits = vs.cosineTopK(new Float32Array([1, 0, 0]), 2)
    expect(hits.map((h) => h.id)).toEqual(['a', 'b']) // a=1.0, b≈0.994
    expect(hits[0]!.score).toBeCloseTo(1, 5)
  })
  it('k limits, minScore filters', async () => {
    const vs = new VectorSet(); await vs.ensureLoaded(async () => vecs)
    expect(vs.cosineTopK(new Float32Array([1, 0, 0]), 1).length).toBe(1)
    expect(vs.cosineTopK(new Float32Array([1, 0, 0]), 5, { minScore: 0.99 }).map((h) => h.id)).toEqual(['a', 'b'])
  })
  it('markDirty forces reload', async () => {
    const vs = new VectorSet(); let calls = 0
    const load = async () => { calls++; return vecs }
    await vs.ensureLoaded(load); vs.markDirty(); expect(vs.loaded).toBe(false)
    await vs.ensureLoaded(load); expect(calls).toBe(2)
  })
  it('model guard throws on mismatch', async () => {
    const vs = new VectorSet(); await vs.ensureLoaded(async () => vecs)
    expect(() => vs.cosineTopK(new Float32Array([1, 0, 0]), 2, { expectModel: 'm2' })).toThrow(EmbeddingModelMismatchError)
  })
})
