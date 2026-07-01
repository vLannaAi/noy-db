/**
 * Persisted lexical index wiring — #308 L1.5.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/noydb.js'
import { withI18n } from '../src/with-shape/i18n/index.js'
import type { Noydb } from '../src/noydb.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
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

interface Inv { id: string; description: string }

describe('persisted lexical index (#308 L1.5)', () => {
  it('cold-loads a persisted index without re-tokenizing, and keeps the store zero-knowledge', async () => {
    const store = memory()
    const puts: string[] = []
    const wrapped: NoydbStore = { ...store, async put(c, col, id, e, ev) { puts.push(`${col}/${id}`); return store.put(c, col, id, e, ev) } }

    // session 1 — build + persist
    const db1 = await createNoydb({ store: wrapped, user: 'a', secret: 'pw-l15', i18nStrategy: withI18n() })
    const v1 = await db1.openVault('v')
    const c1 = v1.collection<Inv>('inv', { textIndexes: ['description'], textIndexPersist: true })
    await c1.put('a', { id: 'a', description: 'overdue invoice TCM' })
    await c1.flushIndex()
    expect(puts.some((p) => p.startsWith('_ftindex/'))).toBe(true) // an opaque index blob was written
    // the index blob is ciphertext (no plaintext term leaks)
    const blob = await wrapped.get('v', '_ftindex', 'inv')
    expect(JSON.stringify(blob)).not.toContain('invoice')

    // session 2 — fresh db over the SAME store: retrieve must work WITHOUT a rebuild
    const db2 = await createNoydb({ store: wrapped, user: 'a', secret: 'pw-l15', i18nStrategy: withI18n() })
    const v2 = await db2.openVault('v')
    const c2 = v2.collection<Inv>('inv', { textIndexes: ['description'], textIndexPersist: true })
    const hits = await c2.retrieve('invoice')
    expect(hits.map((h) => h.id)).toEqual(['a'])
  })

  it('the index blob is NOT hydrated as a record', async () => {
    const db = await createNoydb({ store: memory(), user: 'a', secret: 'pw', i18nStrategy: withI18n() })
    const v = await db.openVault('v')
    const c = v.collection<Inv>('inv', { textIndexes: ['description'], textIndexPersist: true })
    await c.put('a', { id: 'a', description: 'invoice' })
    await c.flushIndex()
    expect((await c.query().toArray()).map((r) => r.id)).toEqual(['a']) // only the real record
  })

  it('cold-load session-2 retrieve does not write any new _ftindex blobs (fingerprint matched, loaded not rebuilt)', async () => {
    const store = memory()
    const puts: string[] = []
    const wrapped: NoydbStore = {
      ...store,
      async put(c, col, id, e, ev) { puts.push(`${col}/${id}`); return store.put(c, col, id, e, ev) },
    }

    // session 1 — build + persist the index
    const db1 = await createNoydb({ store: wrapped, user: 'a', secret: 'pw-l15', i18nStrategy: withI18n() })
    const v1 = await db1.openVault('v')
    const c1 = v1.collection<Inv>('inv', { textIndexes: ['description'], textIndexPersist: true })
    await c1.put('r1', { id: 'r1', description: 'overdue invoice TCM' })
    await c1.flushIndex()

    // session 2 — fresh db on same store
    const db2 = await createNoydb({ store: wrapped, user: 'a', secret: 'pw-l15', i18nStrategy: withI18n() })
    const v2 = await db2.openVault('v')
    const c2 = v2.collection<Inv>('inv', { textIndexes: ['description'], textIndexPersist: true })

    // snapshot _ftindex put count before retrieve
    const ftindexPutsBefore = puts.filter((p) => p.startsWith('_ftindex/')).length

    // cold-load retrieve — must return correct results
    const hits = await c2.retrieve('invoice')
    expect(hits.map((h) => h.id)).toEqual(['r1'])

    // assert NO new _ftindex writes during session-2 retrieve (blob was deserialized, not rebuilt)
    const ftindexPutsAfter = puts.filter((p) => p.startsWith('_ftindex/')).length
    expect(ftindexPutsAfter).toBe(ftindexPutsBefore)
  })

  it('zero _ftindex I/O when textIndexPersist is not set (MemoryIndexStore path)', async () => {
    const store = memory()
    const ftindexOps: string[] = []
    const wrapped: NoydbStore = {
      ...store,
      async put(c, col, id, e, ev) {
        if (col === '_ftindex') ftindexOps.push(`put:${col}/${id}`)
        return store.put(c, col, id, e, ev)
      },
      async get(c, col, id) {
        if (col === '_ftindex') ftindexOps.push(`get:${col}/${id}`)
        return store.get(c, col, id)
      },
      async delete(c, col, id) {
        if (col === '_ftindex') ftindexOps.push(`delete:${col}/${id}`)
        return store.delete(c, col, id)
      },
    }

    // collection WITHOUT textIndexPersist
    const db = await createNoydb({ store: wrapped, user: 'a', secret: 'pw-nocost', i18nStrategy: withI18n() })
    const v = await db.openVault('v')
    const c = v.collection<Inv>('inv', { textIndexes: ['description'] /* no textIndexPersist */ })
    await c.put('r1', { id: 'r1', description: 'overdue invoice TCM' })
    await c.flushIndex()
    const hits = await c.retrieve('invoice')
    expect(hits.map((h) => h.id)).toEqual(['r1'])

    // the _ftindex collection must have received zero put/get/delete calls
    expect(ftindexOps).toHaveLength(0)
  })
})
