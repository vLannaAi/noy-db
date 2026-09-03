/**
 * #1354 end-to-end — the collection-level opt-in (`textIndexPositions`), the
 * `boost` retrieve option, and the persisted-sidecar half: a blob written under
 * a different positional coverage (or an older format stamp) is REBUILT, never
 * read leniently.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { withSearch } from '../src/index.js'
import type { Noydb } from '../src/kernel/noydb.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { ConflictError } from '../src/kernel/errors.js'
import { PersistedIndexStore, type Fingerprint } from '../src/with-lookup/search/persisted-index-store.js'
import { InvertedIndex, type IndexDoc } from '../src/with-lookup/search/inverted-index.js'
import { serializeIndex } from '../src/with-lookup/search/serialize.js'

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

interface Doc { id: string; name: string; notes: string }

async function db(): Promise<Noydb> {
  return createNoydb({ store: toMemory(), user: 'a', secret: 'pw-1354', searchStrategy: withSearch() })
}

const rows: Doc[] = [
  { id: '1', name: 'tax invoice 2026', notes: 'nothing of note' },
  { id: '2', name: 'invoice tax summary', notes: 'the tax paperwork and the invoice are filed' },
  { id: '3', name: 'rent receipt', notes: 'tax invoice attached' },
]

describe('#1354 retrieve() — phrase / proximity through a collection', () => {
  let n: Noydb

  beforeEach(async () => { n = await db() })

  async function seed(positions?: readonly ('name' | 'notes')[]) {
    const v = await n.openVault('v')
    const c = v.collection<Doc>('docs', {
      prefetch: true,
      textIndexes: ['name', 'notes'],
      ...(positions ? { textIndexPositions: positions } : {}),
    })
    for (const r of rows) await c.put(r.id, r)
    return c
  }

  it('a phrase clause matches only the adjacent, ordered occurrence', async () => {
    const c = await seed(['name'])
    expect((await c.retrieve('"tax invoice"')).map((h) => h.id)).toEqual(['1'])
  })

  it('proximity widens the same clause, unordered', async () => {
    const c = await seed(['name'])
    expect((await c.retrieve('"tax invoice"~1')).map((h) => h.id).sort()).toEqual(['1', '2'])
  })

  it('a phrase never spans two fields of the same record', async () => {
    const c = await seed(['name', 'notes'])
    // Record 3's `name` ends "receipt" and its `notes` begins "tax invoice".
    // Concatenated, that reads "receipt tax" — as a phrase it must not match.
    expect(await c.retrieve('"receipt tax"')).toEqual([])
    // Not vacuous: both terms are present on record 3, and even a 1-token
    // proximity window over the same pair still finds nothing, because the two
    // postings are separate fields with separate position spaces.
    expect((await c.retrieve('receipt tax', { match: 'all' })).map((h) => h.id)).toEqual([])
    expect((await c.retrieve('receipt', { match: 'all' })).map((h) => h.id)).toEqual(['3'])
    expect((await c.retrieve('tax', { match: 'all' })).map((h) => h.id)).toContain('3')
    expect(await c.retrieve('"receipt tax"~1')).toEqual([])
  })

  it('opting a field OUT means it cannot answer a phrase', async () => {
    const c = await seed(['name'])
    // "tax invoice" is adjacent in record 3's NOTES, which did not opt in.
    expect((await c.retrieve('"tax invoice"')).map((h) => h.id)).not.toContain('3')
  })

  it('a phrase query with no field opted in throws, and says which option to add', async () => {
    const c = await seed()
    await expect(c.retrieve('"tax invoice"')).rejects.toThrow(/textIndexPositions/)
  })

  it('boost re-weights fields; an unboosted query is unchanged', async () => {
    const c = await seed()
    const plain = await c.retrieve('tax')
    const unboosted = await c.retrieve('tax', { boost: {} })
    expect(unboosted).toEqual(plain)
    const boosted = await c.retrieve('tax', { boost: { name: 20 } })
    expect(boosted.map((h) => h.id)[0]).toBe('1')
    expect(boosted.every((h) => h.rank >= 1)).toBe(true)
  })
})

describe('#1354 persisted sidecar — a mismatched blob rebuilds, never lies', () => {
  const docs: IndexDoc[] = [{ id: 'a', fields: [{ field: 'd', text: 'tax invoice' }] }]

  function storeOver(blob: { json: string; fingerprint: Fingerprint } | null) {
    const state = { blob, saves: 0 }
    const store = new PersistedIndexStore({
      load: async () => state.blob,
      save: async (json, f) => { state.saves++; state.blob = { json, fingerprint: f } },
      remove: async () => { state.blob = null },
      currentFingerprint: () => ({ count: 1, maxVersion: 1 }),
      debounceMs: 10,
    })
    return { store, state }
  }

  it('a position-free blob is not reused once the collection opts in', async () => {
    const cold = storeOver(null)
    await cold.store.ensureBuilt(() => docs) // written with NO positions
    const warm = storeOver(cold.state.blob)
    let builds = 0
    const idx = await warm.store.ensureBuilt(() => { builds++; return docs }, { positions: ['d'] })
    expect(builds).toBe(1) // rebuilt rather than adopted
    expect(idx.query('"tax invoice"').map((h) => h.id)).toEqual(['a'])
  })

  it('a positional blob is not reused once the collection opts back OUT', async () => {
    const cold = storeOver(null)
    await cold.store.ensureBuilt(() => docs, { positions: ['d'] })
    const warm = storeOver(cold.state.blob)
    let builds = 0
    await warm.store.ensureBuilt(() => { builds++; return docs })
    expect(builds).toBe(1)
  })

  it('a matching blob IS reused (the rebuild is not unconditional)', async () => {
    const cold = storeOver(null)
    await cold.store.ensureBuilt(() => docs, { positions: ['d'] })
    const warm = storeOver(cold.state.blob)
    let builds = 0
    const idx = await warm.store.ensureBuilt(() => { builds++; return docs }, { positions: ['d'] })
    expect(builds).toBe(0)
    expect(idx.query('"tax invoice"').map((h) => h.id)).toEqual(['a'])
  })

  it('a blob stamped for an older format rebuilds instead of being read leniently', async () => {
    const raw = JSON.parse(serializeIndex(InvertedIndex.build(docs, { positions: ['d'] }))) as Record<string, unknown>
    raw['v'] = 1
    const warm = storeOver({ json: JSON.stringify(raw), fingerprint: { count: 1, maxVersion: 1 } })
    let builds = 0
    const idx = await warm.store.ensureBuilt(() => { builds++; return docs }, { positions: ['d'] })
    expect(builds).toBe(1)
    expect(idx.query('"tax invoice"').map((h) => h.id)).toEqual(['a'])
  })
})
