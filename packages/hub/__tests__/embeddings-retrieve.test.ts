/**
 * Semantic retrieval — retrieve(mode:'semantic') + collection.similarTo() (#308 L2).
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { withSearch } from '../src/index.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { ConflictError, EmbeddingModelMismatchError } from '../src/kernel/errors.js'

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

interface Doc { id: string; text: string }

// Deterministic stub encoder: bag-of-chars hash → Float32Array of given dim.
// Each character increments the bucket at (charCode % dim). Different strings
// produce meaningfully different vectors, making similarity reproducible.
const enc = (dim: number, model = 'stub') => ({
  dim, model, source: 'text' as const,
  encode: async (t: string) => { const v = new Float32Array(dim); for (let i = 0; i < t.length; i++) { const idx = t.charCodeAt(i) % dim; v[idx] = (v[idx] ?? 0) + 1 } return v },
})

describe('semantic retrieval (#308 L2)', () => {

  // Test A: retrieve(mode:'semantic') returns the matching doc as rank-1 with rank+score
  it('A: retrieve(mode:semantic) returns nearest doc as rank-1, hits carry rank and score', async () => {
    const db = await createNoydb({ store: memory(), user: 'a', secret: 'pw-sem-a', searchStrategy: withSearch() })
    const v = await db.openVault('v')
    const encoder = enc(8)
    const c = v.collection<Doc>('docs', { embeddings: encoder })
    await c.put('invoice', { id: 'invoice', text: 'overdue invoice payment' })
    await c.put('client', { id: 'client', text: 'client account setup' })
    await c.put('report', { id: 'report', text: 'quarterly financial report' })

    const hits = await c.retrieve('overdue invoice payment', { mode: 'semantic' })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.id).toBe('invoice')
    expect(hits[0]!.rank).toBe(1)
    expect(typeof hits[0]!.score).toBe('number')
    expect(hits[0]!.score).toBeGreaterThan(0)
    // score should decrease (or stay equal) as rank increases
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i]!.score).toBeLessThanOrEqual(hits[i - 1]!.score)
      expect(hits[i]!.rank).toBe(i + 1)
    }
  })

  // Test B: collection.similarTo() with raw vector returns matching doc
  it('B: similarTo(vector, { k:1 }) returns the doc whose encoding is closest', async () => {
    const db = await createNoydb({ store: memory(), user: 'a', secret: 'pw-sem-b', searchStrategy: withSearch() })
    const v = await db.openVault('v')
    const encoder = enc(8)
    const c = v.collection<Doc>('docs', { embeddings: encoder })
    await c.put('alpha', { id: 'alpha', text: 'alpha text example' })
    await c.put('beta', { id: 'beta', text: 'beta completely different zzzzzz' })

    const queryVec = await encoder.encode('alpha text example')
    const hits = await c.similarTo(queryVec, { k: 1 })
    expect(hits.length).toBe(1)
    expect(hits[0]!.id).toBe('alpha')
  })

  // Test C: minScore filters out far docs
  it('C: minScore filters out docs below the threshold', async () => {
    const db = await createNoydb({ store: memory(), user: 'a', secret: 'pw-sem-c', searchStrategy: withSearch() })
    const v = await db.openVault('v')
    const encoder = enc(8)
    const c = v.collection<Doc>('docs', { embeddings: encoder })
    await c.put('near', { id: 'near', text: 'near match text query' })
    await c.put('far', { id: 'far', text: 'zzzzzzzzzzzzzzzzzzzzz' })

    // Very high minScore — only exact matches pass
    const hitsHigh = await c.retrieve('near match text query', { mode: 'semantic', minScore: 0.999 })
    // near should match itself exactly; far should be filtered
    const ids = hitsHigh.map((h) => h.id)
    expect(ids).not.toContain('far')

    // minScore of 0 keeps everything
    const hitsAll = await c.retrieve('near match text query', { mode: 'semantic', minScore: 0 })
    expect(hitsAll.length).toBe(2)
  })

  // Test D: model guard — open with different model → throws EmbeddingModelMismatchError
  it('D: model guard — stored vec under model "stub" + descriptor model "stub2" → EmbeddingModelMismatchError', async () => {
    const store = memory()
    // Write with model 'stub'
    const db1 = await createNoydb({ store, user: 'a', secret: 'pw-sem-d', searchStrategy: withSearch() })
    const v1 = await db1.openVault('v')
    const c1 = v1.collection<Doc>('docs', { embeddings: enc(8, 'stub') })
    await c1.put('x', { id: 'x', text: 'some text here' })

    // Re-open with model 'stub2' — should throw on semantic retrieve
    const db2 = await createNoydb({ store, user: 'a', secret: 'pw-sem-d', searchStrategy: withSearch() })
    const v2 = await db2.openVault('v')
    const c2 = v2.collection<Doc>('docs', { embeddings: enc(8, 'stub2') })
    await expect(c2.retrieve('some text here', { mode: 'semantic' })).rejects.toThrow(EmbeddingModelMismatchError)
  })

  // Test E: leakage — retrieve(mode:'semantic') only reads _vec (get), never writes; _vec env body has no plaintext source term
  it('E: leakage — semantic retrieve reads _vec but writes nothing new; _vec env body has no plaintext source text', async () => {
    const store = memory()
    const gets: string[] = []
    const puts: string[] = []
    const wrapped: NoydbStore = {
      ...store,
      async get(c, col, id) { gets.push(`${col}/${id}`); return store.get(c, col, id) },
      async put(c, col, id, env, ev) { puts.push(`${col}/${id}`); return store.put(c, col, id, env, ev) },
    }

    const db = await createNoydb({ store: wrapped, user: 'a', secret: 'pw-sem-e', searchStrategy: withSearch() })
    const v = await db.openVault('v')
    const encoder = enc(8)
    const c = v.collection<Doc>('docs', { embeddings: encoder })
    await c.put('doc1', { id: 'doc1', text: 'overdue invoice' })

    // Reset tracking after the put phase
    gets.length = 0
    puts.length = 0

    await c.retrieve('overdue invoice', { mode: 'semantic' })

    // Should have read _vec entries (get)
    expect(gets.some((g) => g.startsWith('_vec/'))).toBe(true)
    // Should NOT have written anything new during retrieve
    expect(puts.filter((p) => p.startsWith('_vec/'))).toHaveLength(0)

    // The raw envelope body stored in _vec should not contain the plaintext source text
    const env = await store.get('v', '_vec', 'docs/doc1')
    expect(JSON.stringify(env)).not.toContain('overdue')
    expect(JSON.stringify(env)).not.toContain('invoice')
  })
})
