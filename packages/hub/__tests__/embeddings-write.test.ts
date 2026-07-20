/**
 * Write-time embedding derivation — encrypted _vec sidecar (#308 L2).
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { withSearch } from '../src/index.js'
import type { Noydb } from '../src/kernel/noydb.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { ConflictError, EmbeddingDimMismatchError } from '../src/kernel/errors.js'

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
// deterministic stub encoder: 3-dim bag-of-chars hash → unit-ish vector
const enc = (dim: number, model = 'stub') => ({
  dim, model, source: 'text' as const,
  encode: async (t: string) => { const v = new Float32Array(dim); for (let i = 0; i < t.length; i++) { const idx = t.charCodeAt(i) % dim; v[idx] = (v[idx] ?? 0) + 1 } return v },
})

describe('embeddings write derivation (#308 L2)', () => {
  it('put derives an ENCRYPTED _vec sidecar (no plaintext vector), not hydrated as a record', async () => {
    const store = memory()
    const puts: string[] = []
    const wrapped: NoydbStore = { ...store, async put(c, col, id, e, ev) { puts.push(`${col}/${id}`); return store.put(c, col, id, e, ev) } }
    const db = await createNoydb({ store: wrapped, user: 'a', secret: 'pw-emb', searchStrategy: withSearch() })
    const v = await db.openVault('v')
    const c = v.collection<Doc>('d', { embeddings: enc(8) })
    await c.put('x', { id: 'x', text: 'overdue invoice' })
    expect(puts.some((p) => p.startsWith('_vec/d/x'))).toBe(true)
    const env = await wrapped.get('v', '_vec', 'd/x')
    expect(JSON.stringify(env)).not.toContain('overdue')          // source text not leaked
    expect((await c.list()).map((r) => r.id)).toEqual(['x'])   // _vec not a phantom record
  })

  it('dim mismatch → EmbeddingDimMismatchError', async () => {
    const db = await createNoydb({ store: memory(), user: 'a', secret: 'pw', searchStrategy: withSearch() })
    const v = await db.openVault('v')
    const c = v.collection<Doc>('d', { embeddings: { ...enc(8), encode: async () => new Float32Array(4) } })
    await expect(c.put('x', { id: 'x', text: 'hi' })).rejects.toThrow(EmbeddingDimMismatchError)
  })

  it('CRDT + embeddings → throws at construction (guard)', async () => {
    const db = await createNoydb({ store: memory(), user: 'a', secret: 'pw', searchStrategy: withSearch() })
    const v = await db.openVault('v')
    expect(() =>
      v.collection<Doc>('d', { embeddings: enc(8), crdt: 'lww-map' }),
    ).toThrow(/embeddings are not supported on CRDT collections/)
  })
})
