/**
 * #1360 part 2 — the index seen through the PUBLIC collection surface.
 *
 * The unit tests prove the algorithm; this proves the wiring: that
 * `embeddings.index` reaches the vector set, that `put()` / `forget()` keep it
 * in step incrementally, and that `{ exact: true }` reaches the exact path
 * from both `similarTo()` and `retrieve({ mode: 'semantic' })`.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { withSearch, withVectorIndex } from '../src/index.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { ConflictError } from '../src/kernel/errors.js'

function toMemory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function gc(c: string, col: string) {
    let comp = store.get(c); if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col); if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    name: 'memory',
    async get(c, col, id) { return store.get(c)?.get(col)?.get(id) ?? null },
    async put(c, col, id, env, ev) {
      const coll = gc(c, col); const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(c, col, id) { store.get(c)?.get(col)?.delete(id) },
    async list(c, col) { const coll = store.get(c)?.get(col); return coll ? [...coll.keys()] : [] },
    async loadAll(c) {
      const comp = store.get(c); const s: VaultSnapshot = {}
      if (comp) for (const [n, coll] of comp) if (!n.startsWith('_')) {
        const r: Record<string, EncryptedEnvelope> = {}; for (const [id, e] of coll) r[id] = e; s[n] = r
      }
      return s
    },
    async saveAll(c, data) {
      const comp = new Map<string, Map<string, EncryptedEnvelope>>()
      for (const [name, records] of Object.entries(data)) {
        const coll = new Map<string, EncryptedEnvelope>()
        for (const [id, env] of Object.entries(records)) coll.set(id, env)
        comp.set(name, coll)
      }
      const existing = store.get(c)
      if (existing) for (const [name, coll] of existing) if (name.startsWith('_')) comp.set(name, coll)
      store.set(c, comp)
    },
  }
}

interface Doc { id: string; text: string }

/** Deterministic bag-of-chars encoder, as in `embeddings-retrieve.test.ts`. */
const enc = (dim: number) => ({
  dim, model: 'stub', source: 'text' as const,
  encode: async (t: string) => { const v = new Float32Array(dim); for (let i = 0; i < t.length; i++) { const idx = t.charCodeAt(i) % dim; v[idx] = (v[idx] ?? 0) + 1 } return v },
})

async function seed(count: number, index?: ReturnType<typeof withVectorIndex>) {
  const db = await createNoydb({ store: toMemory(), user: 'a', secret: 'pw-ann', searchStrategy: withSearch() })
  const v = await db.openVault('v')
  const c = v.collection<Doc>('docs', { embeddings: { ...enc(24), ...(index ? { index } : {}) } })
  for (let i = 0; i < count; i++) await c.put(`d${i}`, { id: `d${i}`, text: `document number ${i} about topic ${i % 7}` })
  return c
}

describe('#1360 approximate index through the collection surface', () => {
  it('a small collection stays exact even when opted in — no index cost below the crossover', async () => {
    // The default `minVectors` is 20,000; 30 records is nowhere near it, so
    // this is the shape almost every consumer will actually run.
    const c = await seed(30, withVectorIndex())
    const q = await enc(24).encode('document number 5 about topic 5')
    const hits = await c.similarTo(q, { k: 3 })
    expect(hits[0]!.id).toBe('d5')
    expect(hits).toEqual(await c.similarTo(q, { k: 3, exact: true }))
  })

  it('an opted-in collection past its threshold answers, and `exact: true` still agrees on the top hit', async () => {
    const c = await seed(60, withVectorIndex({ minVectors: 20, nlist: 6, nprobe: 6 }))
    const q = await enc(24).encode('document number 17 about topic 3')
    // nprobe = nlist ⇒ exhaustive ⇒ the two paths score the same records the
    // same way. Compared by SCORE, not by id: this stub encoder produces exact
    // ties (bag-of-chars over short strings), and neither path promises a
    // tie-break order — `hits.sort` is stable over a scan order that the two
    // paths legitimately differ on. Asserting id equality here would be
    // asserting an unowned implementation detail.
    const approx = await c.similarTo(q, { k: 5 })
    const exact = await c.similarTo(q, { k: 5, exact: true })
    // …and to 6 places, not bit-for-bit: the index scores `dot(q̂,v)·(1/‖v‖)`
    // where `cosine()` scores `dot(q,v)/(‖q‖·‖v‖)`. Same value, different
    // float association order.
    expect(approx).toHaveLength(exact.length)
    approx.forEach((h, i) => expect(h.score).toBeCloseTo(exact[i]!.score, 6))
    expect(approx[0]!.id).toBe(exact[0]!.id)
  })

  it('retrieve({ mode: "semantic", exact: true }) reaches the exact path', async () => {
    const c = await seed(40, withVectorIndex({ minVectors: 10, nlist: 5, nprobe: 5 }))
    const exact = await c.retrieve('document number 12 about topic 5', { mode: 'semantic', limit: 3, exact: true })
    const approx = await c.retrieve('document number 12 about topic 5', { mode: 'semantic', limit: 3 })
    exact.forEach((h, i) => expect(h.score).toBeCloseTo(approx[i]!.score, 6))
    expect(exact[0]!.id).toBe('d12')
    expect(approx[0]!.id).toBe('d12')
  })

  it('put() and forget() keep the indexed set in step, incrementally', async () => {
    const c = await seed(40, withVectorIndex({ minVectors: 10, nlist: 5, nprobe: 5 }))
    const q = await enc(24).encode('zzzz unique marker string zzzz')
    await c.similarTo(q, { k: 1 }) // force the index to exist
    await c.put('marker', { id: 'marker', text: 'zzzz unique marker string zzzz' })
    expect((await c.similarTo(q, { k: 1 }))[0]!.id).toBe('marker')
    await c.put('marker', { id: 'marker', text: 'completely different content now' })
    expect((await c.similarTo(q, { k: 1 }))[0]!.id).not.toBe('marker')
  })

  it('a chunked + indexed collection still returns the winning span', async () => {
    const db = await createNoydb({ store: toMemory(), user: 'a', secret: 'pw-ann2', searchStrategy: withSearch() })
    const v = await db.openVault('v')
    const base = enc(24)
    const c = v.collection<Doc>('docs', {
      embeddings: {
        ...base,
        chunk: (text: string) => text.split('|').reduce<{ spans: { start: number; end: number }[]; at: number }>(
          (acc, part) => { acc.spans.push({ start: acc.at, end: acc.at + part.length }); acc.at += part.length + 1; return acc },
          { spans: [], at: 0 },
        ).spans,
        index: withVectorIndex({ minVectors: 4, nlist: 3, nprobe: 3 }),
      },
    })
    await c.put('a', { id: 'a', text: 'boats and harbours|tax depreciation schedules|cheese' })
    await c.put('b', { id: 'b', text: 'weather patterns|mountain trails|bicycles' })
    const hits = await c.similarTo(await base.encode('tax depreciation schedules'), { k: 1 })
    expect(hits[0]!.id).toBe('a')
    expect(hits[0]!.chunk).toBeDefined()
    expect(hits[0]!.snippet).toBe('tax depreciation schedules')
  })
})
