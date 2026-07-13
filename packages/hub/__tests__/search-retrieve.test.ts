import { describe, it, expect, beforeEach } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { withSearch } from '../src/index.js'
import { withI18n } from '../src/via/i18n/index.js'
import type { Noydb } from '../src/kernel/noydb.js'
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

interface Inv { id: string; description: string; notes: string }
async function db(): Promise<Noydb> {
  return createNoydb({ store: memory(), user: 'a', secret: 'pw-retrieve', i18nStrategy: withI18n(), searchStrategy: withSearch() })
}

describe('collection.retrieve() — string fields (#308 L1)', () => {
  let n: Noydb
  beforeEach(async () => { n = await db() })

  async function seed() {
    const v = await n.openVault('v')
    const c = v.collection<Inv>('inv', { textIndexes: ['description', 'notes'] })
    await c.put('a', { id: 'a', description: 'overdue invoice for TCM', notes: '' })
    await c.put('b', { id: 'b', description: 'paid invoice', notes: 'TCM building rent' })
    return c
  }

  it('retrieves across fields, ranked, with snippet + field, no record by default', async () => {
    const c = await seed()
    const hits = await c.retrieve('TCM')
    expect(hits.map((h) => h.id).sort()).toEqual(['a', 'b'])
    const b = hits.find((h) => h.id === 'b')!
    expect(b.field).toBe('notes')
    expect(b.snippet).toContain('TCM')
    expect(b.record).toBeUndefined()
  })

  it('includeRecord returns the decrypted record', async () => {
    const c = await seed()
    const [hit] = await c.retrieve('overdue', { includeRecord: true })
    expect(hit!.record!.id).toBe('a')
  })

  it('reflects writes (dirty-rebuild)', async () => {
    const c = await seed()
    await c.retrieve('invoice')
    await c.put('c', { id: 'c', description: 'new invoice', notes: '' })
    expect((await c.retrieve('invoice')).map((h) => h.id).sort()).toEqual(['a', 'b', 'c'])
  })

  it('warmIndex builds without a query', async () => {
    const c = await seed()
    await c.warmIndex()
    expect((await c.retrieve('invoice')).length).toBe(2)
  })

  it('fields filter restricts results at query time, not index-build time (cache-poison regression)', async () => {
    const v = await n.openVault('v')
    const c = v.collection<Inv>('inv', { textIndexes: ['description', 'notes'] })
    // rec-N: TCM only in notes, NOT in description
    await c.put('N', { id: 'N', description: 'regular invoice', notes: 'TCM building rent' })
    // rec-D: TCM only in description, NOT in notes
    await c.put('D', { id: 'D', description: 'overdue TCM invoice', notes: 'no match here' })

    await c.warmIndex() // builds full index over both fields

    // fields-scoped query: should return only rec-N (TCM is in notes)
    const notesHits = await c.retrieve('TCM', { fields: ['notes'] })
    expect(notesHits.map((h) => h.id)).toEqual(['N'])

    // unconstrained query AFTER the fields query: must return BOTH records
    // (proves the fields query did not poison the shared cache)
    const allHits = await c.retrieve('TCM')
    expect(allHits.map((h) => h.id).sort()).toEqual(['D', 'N'])
  })

  it('cold-call: fields-scoped first retrieve does not poison cache for subsequent unscoped retrieve', async () => {
    const v = await n.openVault('v')
    const c = v.collection<Inv>('inv', { textIndexes: ['description', 'notes'] })
    // rec-N: TCM only in notes
    await c.put('N', { id: 'N', description: 'regular invoice', notes: 'TCM building rent' })
    // rec-D: TCM only in description
    await c.put('D', { id: 'D', description: 'overdue TCM invoice', notes: 'no match here' })

    // NO warmIndex — first retrieve is fields-scoped (cold cache)
    const notesHits = await c.retrieve('TCM', { fields: ['notes'] })
    expect(notesHits.map((h) => h.id)).toEqual(['N'])

    // Unscoped retrieve must return BOTH records, not just the notes-only record
    const allHits = await c.retrieve('TCM')
    expect(allHits.map((h) => h.id).sort()).toEqual(['D', 'N'])
  })

  it('writes NOTHING to the store during build+retrieve (zero leakage)', async () => {
    const store = memory()
    const writes: string[] = []
    const wrapped: NoydbStore = { ...store, async put(c, col, id, env, ev) { writes.push(`${c}/${col}/${id}`); return store.put(c, col, id, env, ev) } }
    const n2 = await createNoydb({ store: wrapped, user: 'a', secret: 'pw', i18nStrategy: withI18n(), searchStrategy: withSearch() })
    const v = await n2.openVault('v')
    const c = v.collection<Inv>('inv', { textIndexes: ['description', 'notes'] })
    await c.put('a', { id: 'a', description: 'overdue invoice', notes: '' })
    const before = writes.length
    await c.warmIndex()
    await c.retrieve('invoice', { prefix: true })
    expect(writes.length).toBe(before) // build+retrieve wrote nothing
  })

  it('hits carry a 1-based rank monotonic with score order (#308 L1.5)', async () => {
    const v = await n.openVault('v')
    const c = v.collection<Inv>('inv', { textIndexes: ['description', 'notes'] })
    // Record a: TCM appears in description (stronger match)
    await c.put('a', { id: 'a', description: 'TCM TCM overdue invoice', notes: 'regular payment' })
    // Record b: TCM appears in notes only (weaker match)
    await c.put('b', { id: 'b', description: 'paid invoice', notes: 'TCM building rent' })

    const hits = await c.retrieve('TCM')
    expect(hits.length).toBe(2)
    // Hits are returned in score order (highest first)
    expect(hits[0]!.id).toBe('a') // description match scores higher
    expect(hits[1]!.id).toBe('b') // notes match scores lower
    // Verify rank is 1-based and monotonic
    expect(hits[0]!.rank).toBe(1)
    expect(hits[1]!.rank).toBe(2)
  })
})
