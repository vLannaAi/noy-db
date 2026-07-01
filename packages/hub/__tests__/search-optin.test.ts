/**
 * Gate test for the search / retrieval capability (S4). A collection's
 * `search` / `retrieve` / `similarTo` / `warmIndex` / `flushIndex` methods, and
 * the put()-time embedding-vector compute for collections declaring
 * `embeddings`, throw `SearchNotEnabledError` unless `searchStrategy:
 * withSearch()` is passed to createNoydb; opting in makes them live.
 *
 * Embeddings↔search pairing (spec open item, resolved): a single `withSearch()`
 * enables BOTH the query surface and the embedding write-hook — computing a
 * vector that no gated `similarTo` / semantic `retrieve` could read is dead
 * weight, so embedding compute is not separately gatable.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, ConflictError, SearchNotEnabledError, withSearch } from '../src/index.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/index.js'

interface Doc { id: string; title: string; text: string }

function memory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const gc = (c: string, col: string): Map<string, EncryptedEnvelope> => {
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
      store.set(c, comp)
    },
  }
}

// deterministic stub encoder (bag-of-chars into a fixed-dim vector)
const enc = (dim: number, model = 'stub') => ({
  dim, model, source: 'text' as const,
  encode: async (t: string) => { const v = new Float32Array(dim); for (let i = 0; i < t.length; i++) { const idx = t.charCodeAt(i) % dim; v[idx] = (v[idx] ?? 0) + 1 } return v },
})

describe('search opt-in gate (S4)', () => {
  it('throws SearchNotEnabledError for search/retrieve/similarTo/warmIndex/flushIndex when not opted in', async () => {
    const db = await createNoydb({ store: memory(), user: 'a', secret: 'pw-search' })
    const v = await db.openVault('v')
    const c = v.collection<Doc>('docs', { textIndexes: ['title'] })
    await expect(c.search('title', 'invoice')).rejects.toThrow(SearchNotEnabledError)
    await expect(c.retrieve('invoice')).rejects.toThrow(SearchNotEnabledError)
    await expect(c.similarTo(new Float32Array(8))).rejects.toThrow(SearchNotEnabledError)
    await expect(c.warmIndex()).rejects.toThrow(SearchNotEnabledError)
    await expect(c.flushIndex()).rejects.toThrow(SearchNotEnabledError)
  })

  it('throws SearchNotEnabledError at put() for an embeddings collection when not opted in', async () => {
    const db = await createNoydb({ store: memory(), user: 'a', secret: 'pw-search' })
    const v = await db.openVault('v')
    const c = v.collection<Doc>('docs', { embeddings: enc(8) })
    await expect(c.put('x', { id: 'x', title: 'A', text: 'overdue invoice' }))
      .rejects.toThrow(SearchNotEnabledError)
  })

  it('works when opted in via withSearch(): search + embedding-backed similarTo', async () => {
    const db = await createNoydb({ store: memory(), user: 'a', secret: 'pw-search', searchStrategy: withSearch() })
    const v = await db.openVault('v')
    const c = v.collection<Doc>('docs', { textIndexes: ['title'], embeddings: enc(8) })
    await c.put('x', { id: 'x', title: 'invoice paid', text: 'overdue invoice' })
    const hits = await c.search('title', 'invoice')
    expect(hits.map((h) => h.id)).toContain('x')
    const sim = await c.similarTo(await enc(8).encode('overdue invoice'), { k: 1 })
    expect(sim[0]?.id).toBe('x')
  })
})
