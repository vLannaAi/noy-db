/**
 * Scan-mode full-text search — collection.search() (#308).
 * Zero-leakage client-side BM25 scan; eager mode only.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createNoydb } from '../src/noydb.js'
import { ConflictError } from '../src/errors.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/types.js'
import { tokenize, searchScan } from '../src/with-lookup/search/index.js'

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
    async saveAll(c, data) { for (const [n, recs] of Object.entries(data)) { const coll = gc(c, n); for (const [id, e] of Object.entries(recs)) coll.set(id, e) } },
  }
}

interface Doc extends Record<string, unknown> { id: string; title: string }

describe('tokenize (#308)', () => {
  it('NFKC-normalizes, lowercases, and splits on word boundaries', () => {
    expect(tokenize('Overdue  Invoice #42!')).toEqual(['overdue', 'invoice', '42'])
    expect(tokenize('')).toEqual([])
  })
})

describe('searchScan (pure, #308)', () => {
  const entries = [
    { id: 'a', record: { title: 'overdue invoice for acme' } },
    { id: 'b', record: { title: 'paid invoice' } },
    { id: 'c', record: { title: 'meeting notes' } },
  ]
  it('ranks by relevance and supports any/all + limit + prefix', () => {
    const any = searchScan(entries, 'title', 'invoice')
    expect(any.map((r) => r.id).sort()).toEqual(['a', 'b'])

    const all = searchScan(entries, 'title', 'overdue invoice', { match: 'all' })
    expect(all.map((r) => r.id)).toEqual(['a'])

    const top = searchScan(entries, 'title', 'invoice', { limit: 1 })
    expect(top).toHaveLength(1)

    const pre = searchScan(entries, 'title', 'inv', { prefix: true })
    expect(pre.map((r) => r.id).sort()).toEqual(['a', 'b'])

    expect(searchScan(entries, 'title', 'zzz')).toEqual([])
  })
})

describe('collection.search() (#308)', () => {
  let coll: Awaited<ReturnType<typeof open>>
  async function open() {
    const db = await createNoydb({ store: memory(), user: 'u', secret: 'search-pass-123456' })
    const vault = await db.openVault('v')
    const c = vault.collection<Doc>('docs')
    await c.put('a', { id: 'a', title: 'overdue invoice for acme' })
    await c.put('b', { id: 'b', title: 'paid invoice' })
    await c.put('c', { id: 'c', title: 'meeting notes' })
    return { db, vault, c }
  }
  beforeEach(async () => { coll = await open() })

  it('returns ranked {id,score,record} hits', async () => {
    const hits = await coll.c.search('title', 'invoice')
    expect(hits.map((h) => h.id).sort()).toEqual(['a', 'b'])
    expect(hits[0]!.score).toBeGreaterThan(0)
    expect(hits[0]!.record.title).toContain('invoice')
  })

  it('typeahead via prefix', async () => {
    const hits = await coll.c.search('title', 'mee', { prefix: true })
    expect(hits.map((h) => h.id)).toEqual(['c'])
  })

  it('does not return a deleted record (cache eviction)', async () => {
    await coll.c.delete('b')
    const hits = await coll.c.search('title', 'invoice')
    expect(hits.map((h) => h.id)).toEqual(['a'])
  })

  it('throws in lazy mode (scan needs eager)', async () => {
    const db = await createNoydb({ store: memory(), user: 'u', secret: 'search-pass-123456' })
    const vault = await db.openVault('v2')
    const lazy = vault.collection<Doc>('docs', { prefetch: false, cache: { maxRecords: 100 } })
    await lazy.put('a', { id: 'a', title: 'x' })
    await expect(lazy.search('title', 'x')).rejects.toThrow(/eager mode/)
  })
})
