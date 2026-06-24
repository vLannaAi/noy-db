/**
 * Hybrid retrieve leakage test — asserts that retrieve(mode:'hybrid', within)
 * writes ZERO new store keys (#308 L3 privacy invariant).
 *
 * L3 adds no store artifacts: it is pure in-trusted-tier compute over
 * L1's in-memory index, L2's in-memory vectors, and the eager cache.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/noydb.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/types.js'
import { ConflictError } from '../src/errors.js'

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
  encode: async (t: string) => { const v = new Float32Array(dim); for (let i = 0; i < t.length; i++) v[t.charCodeAt(i) % dim] += 1; return v },
})

describe('hybrid retrieve leakage (#308 L3 privacy invariant)', () => {
  it('hybrid retrieve with within writes no new store keys', async () => {
    // Wrap the memory store to record every put as "${col}/${id}"
    const writes = new Set<string>()
    const base = memory()
    const wrapped: NoydbStore = {
      ...base,
      async put(c, col, id, env, ev) {
        writes.add(`${col}/${id}`)
        return base.put(c, col, id, env, ev)
      },
    }

    const db = await createNoydb({ store: wrapped, user: 'a', secret: 'pw-leak-test' })
    const v = await db.openVault('v')
    const c = v.collection<Doc>('docs', { textIndexes: ['text'], embeddings: enc(16) })

    // Seed — these writes are EXPECTED (records + _vec sidecars)
    await c.put('d1', { id: 'd1', text: 'revenue report', status: 'open' })
    await c.put('d2', { id: 'd2', text: 'revenue summary', status: 'closed' })
    await c.put('d3', { id: 'd3', text: 'revenue forecast', status: 'open' })

    // Snapshot the write-set AFTER seeding — retrieve must not add to it
    const before = new Set(writes)

    // Hybrid retrieve with within filter — must add ZERO new store entries
    await c.retrieve('revenue', { mode: 'hybrid', within: c.query().where('status', '==', 'open') })

    expect(new Set(writes)).toEqual(before)

    db.close()
  })

  it('lexical retrieve with within also writes no new store keys', async () => {
    const writes = new Set<string>()
    const base = memory()
    const wrapped: NoydbStore = {
      ...base,
      async put(c, col, id, env, ev) {
        writes.add(`${col}/${id}`)
        return base.put(c, col, id, env, ev)
      },
    }

    const db = await createNoydb({ store: wrapped, user: 'a', secret: 'pw-leak-lex' })
    const v = await db.openVault('v')
    const c = v.collection<Doc>('docs', { textIndexes: ['text'], embeddings: enc(16) })

    await c.put('d1', { id: 'd1', text: 'revenue report', status: 'open' })
    await c.put('d2', { id: 'd2', text: 'revenue summary', status: 'closed' })

    const before = new Set(writes)

    await c.retrieve('revenue', { within: c.query().where('status', '==', 'open') })

    expect(new Set(writes)).toEqual(before)

    db.close()
  })

  it('semantic retrieve with within also writes no new store keys', async () => {
    const writes = new Set<string>()
    const base = memory()
    const wrapped: NoydbStore = {
      ...base,
      async put(c, col, id, env, ev) {
        writes.add(`${col}/${id}`)
        return base.put(c, col, id, env, ev)
      },
    }

    const db = await createNoydb({ store: wrapped, user: 'a', secret: 'pw-leak-sem' })
    const v = await db.openVault('v')
    const c = v.collection<Doc>('docs', { textIndexes: ['text'], embeddings: enc(16) })

    await c.put('d1', { id: 'd1', text: 'revenue report', status: 'open' })
    await c.put('d2', { id: 'd2', text: 'revenue summary', status: 'closed' })

    const before = new Set(writes)

    await c.retrieve('revenue', { mode: 'semantic', within: c.query().where('status', '==', 'open') })

    expect(new Set(writes)).toEqual(before)

    db.close()
  })
})
