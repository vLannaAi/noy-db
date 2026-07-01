/**
 * retrieve({ within }) — retrieve ∩ where payload filter (#308 L3 Task 4).
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/noydb.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { ConflictError } from '../src/kernel/errors.js'

function memory(): NoydbStore {
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

interface Doc { id: string; text: string; status: string }

// Deterministic stub encoder: bag-of-chars hash → Float32Array of given dim.
const enc = (dim: number, model = 'stub') => ({
  dim, model, source: 'text' as const,
  encode: async (t: string) => { const v = new Float32Array(dim); for (let i = 0; i < t.length; i++) { const ci = t.charCodeAt(i) % dim; v[ci] = (v[ci] ?? 0) + 1 } return v },
})

async function seed() {
  const db = await createNoydb({ store: memory(), user: 'a', secret: 'pw-within' })
  const v = await db.openVault('v')
  const c = v.collection<Doc>('docs', { textIndexes: ['text'], embeddings: enc(16) })
  await c.put('d1', { id: 'd1', text: 'revenue report', status: 'open' })
  await c.put('d2', { id: 'd2', text: 'revenue summary', status: 'closed' })
  await c.put('d3', { id: 'd3', text: 'revenue forecast', status: 'open' })
  return c
}

describe('retrieve({ within })  — retrieve ∩ where', () => {
  it('lexical ∩ where keeps only ids matching the query and re-ranks', async () => {
    const c = await seed()
    const hits = await c.retrieve('revenue', { within: c.query().where('status', '==', 'open') })
    expect(new Set(hits.map(h => h.id))).toEqual(new Set(['d1', 'd3']))
    expect(hits.map(h => h.rank)).toEqual(hits.map((_, i) => i + 1))
  })

  it('hybrid ∩ where filters the fused list', async () => {
    const c = await seed()
    const hits = await c.retrieve('revenue', { mode: 'hybrid', within: c.query().where('status', '==', 'closed') })
    expect(new Set(hits.map(h => h.id))).toEqual(new Set(['d2']))
  })

  it('semantic ∩ where filters the cosine list', async () => {
    const c = await seed()
    const hits = await c.retrieve('revenue', { mode: 'semantic', within: c.query().where('status', '==', 'open') })
    expect(hits.every(h => h.id === 'd1' || h.id === 'd3')).toBe(true)
  })

  it('an empty within result yields no hits', async () => {
    const c = await seed()
    const hits = await c.retrieve('revenue', { within: c.query().where('status', '==', 'void') })
    expect(hits).toEqual([])
  })
})
