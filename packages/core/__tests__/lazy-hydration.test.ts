import { describe, it, expect, beforeEach } from 'vitest'
import { createNoydb } from '../src/noydb.js'
import type { Noydb } from '../src/noydb.js'
import type { NoydbAdapter, EncryptedEnvelope, CompartmentSnapshot, ListPageResult } from '../src/types.js'
import { ConflictError } from '../src/errors.js'

/**
 * Inline memory adapter — same pattern as the other integration tests,
 * but with a `_getCalls` counter so tests can prove that lazy mode hits
 * the adapter on cache miss instead of using a preloaded snapshot.
 */
function memory(): NoydbAdapter & { _getCalls: number; _resetCounters(): void } {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  let getCalls = 0
  function getCollection(c: string, col: string): Map<string, EncryptedEnvelope> {
    let comp = store.get(c)
    if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col)
    if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    name: 'memory',
    get _getCalls() { return getCalls },
    _resetCounters() { getCalls = 0 },
    async get(c, col, id) {
      getCalls++
      return store.get(c)?.get(col)?.get(id) ?? null
    },
    async put(c, col, id, env, ev) {
      const coll = getCollection(c, col)
      const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(c, col, id) { store.get(c)?.get(col)?.delete(id) },
    async list(c, col) { const coll = store.get(c)?.get(col); return coll ? [...coll.keys()] : [] },
    async loadAll(c) {
      const comp = store.get(c); const s: CompartmentSnapshot = {}
      if (comp) for (const [n, coll] of comp) {
        if (!n.startsWith('_')) {
          const r: Record<string, EncryptedEnvelope> = {}
          for (const [id, e] of coll) r[id] = e
          s[n] = r
        }
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
      if (existing) {
        for (const [name, coll] of existing) {
          if (name.startsWith('_')) comp.set(name, coll)
        }
      }
      store.set(c, comp)
    },
    async listPage(c, col, cursor, limit = 100): Promise<ListPageResult> {
      const coll = store.get(c)?.get(col)
      if (!coll) return { items: [], nextCursor: null }
      const ids = [...coll.keys()].sort()
      const start = cursor ? parseInt(cursor, 10) : 0
      const end = Math.min(start + limit, ids.length)
      const items: ListPageResult['items'] = []
      for (let i = start; i < end; i++) {
        const id = ids[i]!
        const envelope = coll.get(id)
        if (envelope) items.push({ id, envelope })
      }
      return {
        items,
        nextCursor: end < ids.length ? String(end) : null,
      }
    },
  }
}

interface Invoice {
  id: string
  amount: number
  status: 'draft' | 'open' | 'paid'
  client: string
}

/**
 * Helper that pre-seeds an adapter with N invoices via an EAGER collection,
 * then constructs a fresh Noydb pointing at the SAME adapter so the second
 * Noydb can open the collection in LAZY mode and observe records that
 * were already on disk.
 *
 * Returns the opened compartment too so test bodies don't have to call
 * `openCompartment` themselves — the compartment open triggers a keyring
 * read which would otherwise pollute the get-call counter.
 */
async function seedAdapterAndReopen(n: number): Promise<{
  db: Noydb
  adapter: ReturnType<typeof memory>
  comp: Awaited<ReturnType<Noydb['openCompartment']>>
}> {
  const adapter = memory()

  // Phase 1: write N records via an EAGER collection.
  const seeder = await createNoydb({
    adapter,
    user: 'owner',
    secret: 'lazy-test-passphrase-2026',
  })
  const seederComp = await seeder.openCompartment('TEST')
  const seederColl = seederComp.collection<Invoice>('invoices')
  for (let i = 0; i < n; i++) {
    await seederColl.put(`inv-${String(i).padStart(4, '0')}`, {
      id: `inv-${String(i).padStart(4, '0')}`,
      amount: i * 10,
      status: (['draft', 'open', 'paid'] as const)[i % 3]!,
      client: `Client-${i % 5}`,
    })
  }

  // Phase 2: open a SECOND Noydb against the SAME adapter so the lazy
  // collection observes records via adapter.get() rather than via the
  // seeder's in-memory cache. We open the compartment here so the
  // keyring read happens BEFORE the counter reset.
  const db = await createNoydb({
    adapter,
    user: 'owner',
    secret: 'lazy-test-passphrase-2026',
  })
  const comp = await db.openCompartment('TEST')

  adapter._resetCounters()
  return { db, adapter, comp }
}

// ─── Construction-time validation ──────────────────────────────────

describe('Collection — lazy mode construction', () => {
  let comp: Awaited<ReturnType<Noydb['openCompartment']>>

  beforeEach(async () => {
    const db = await createNoydb({
      adapter: memory(),
      user: 'owner',
      secret: 'lazy-test-passphrase-2026',
    })
    comp = await db.openCompartment('TEST')
  })

  it('1. lazy mode without cache options throws', () => {
    expect(() => comp.collection<Invoice>('invoices', { prefetch: false }))
      .toThrow(/lazy mode .* requires a cache option/)
  })

  it('2. lazy mode with empty cache options throws', () => {
    expect(() => comp.collection<Invoice>('invoices', { prefetch: false, cache: {} }))
      .toThrow(/requires a cache option/)
  })

  it('3. lazy mode with indexes throws', () => {
    expect(() => comp.collection<Invoice>('invoices', {
      prefetch: false,
      cache: { maxRecords: 100 },
      indexes: ['status'],
    })).toThrow(/secondary indexes are not supported in lazy mode/)
  })

  it('4. lazy mode with byte budget string is parsed correctly', () => {
    // Should construct without throwing.
    const coll = comp.collection<Invoice>('invoices', {
      prefetch: false,
      cache: { maxBytes: '50KB' },
    })
    expect(coll.cacheStats().lazy).toBe(true)
  })

  it('5. lazy mode with invalid byte budget throws', () => {
    expect(() => comp.collection<Invoice>('invoices', {
      prefetch: false,
      cache: { maxBytes: 'not-a-size' },
    })).toThrow(/invalid byte budget/)
  })
})

// ─── Eager mode preserved (v0.2 behavior) ──────────────────────────

describe('Collection — eager mode preserves v0.2 behavior', () => {
  it('6. default behavior loads all records on first access', async () => {
    const { adapter, comp } = await seedAdapterAndReopen(10)
    const invoices = comp.collection<Invoice>('invoices') // eager (default)
    const all = await invoices.list()
    expect(all).toHaveLength(10)
    // ensureHydrated walks the adapter once per id (10 records → 10 gets).
    expect(adapter._getCalls).toBe(10)
  })

  it('7. cacheStats reports lazy: false in eager mode', async () => {
    const { comp } = await seedAdapterAndReopen(0)
    const invoices = comp.collection<Invoice>('invoices')
    expect(invoices.cacheStats().lazy).toBe(false)
  })
})

// ─── Lazy mode behavior ────────────────────────────────────────────

describe('Collection — lazy mode behavior', () => {
  it('8. constructor does NOT trigger any adapter reads', async () => {
    const { adapter, comp } = await seedAdapterAndReopen(100)
    comp.collection<Invoice>('invoices', { prefetch: false, cache: { maxRecords: 10 } })
    // openCompartment may have triggered some keyring reads, but our reset
    // happens AFTER that. The fresh collection itself should do zero gets.
    expect(adapter._getCalls).toBe(0)
  })

  it('9. get() on cache miss triggers exactly one adapter.get()', async () => {
    const { adapter, comp } = await seedAdapterAndReopen(50)
    const invoices = comp.collection<Invoice>('invoices', {
      prefetch: false,
      cache: { maxRecords: 10 },
    })

    const before = adapter._getCalls
    const r = await invoices.get('inv-0007')
    expect(r?.id).toBe('inv-0007')
    expect(adapter._getCalls).toBe(before + 1)
  })

  it('10. get() on cache hit does NOT touch the adapter', async () => {
    const { adapter, comp } = await seedAdapterAndReopen(50)
    const invoices = comp.collection<Invoice>('invoices', {
      prefetch: false,
      cache: { maxRecords: 10 },
    })

    await invoices.get('inv-0007') // populate the cache
    const before = adapter._getCalls
    await invoices.get('inv-0007') // should be a hit
    expect(adapter._getCalls).toBe(before)

    const stats = invoices.cacheStats()
    expect(stats.hits).toBeGreaterThanOrEqual(1)
    expect(stats.size).toBe(1)
  })

  it('11. LRU eviction caps the cache at maxRecords', async () => {
    const { comp } = await seedAdapterAndReopen(50)
    const invoices = comp.collection<Invoice>('invoices', {
      prefetch: false,
      cache: { maxRecords: 5 },
    })

    // Read 10 distinct records — only 5 should remain in cache.
    for (let i = 0; i < 10; i++) {
      await invoices.get(`inv-${String(i).padStart(4, '0')}`)
    }

    const stats = invoices.cacheStats()
    expect(stats.size).toBe(5)
    expect(stats.evictions).toBe(5)
  })

  it('12. recently-touched records survive eviction', async () => {
    const { adapter, comp } = await seedAdapterAndReopen(50)
    const invoices = comp.collection<Invoice>('invoices', {
      prefetch: false,
      cache: { maxRecords: 3 },
    })

    await invoices.get('inv-0000')
    await invoices.get('inv-0001')
    await invoices.get('inv-0002')

    // Touch inv-0000 — it becomes the MRU.
    await invoices.get('inv-0000')

    // Add a new record — should evict inv-0001 (now LRU), not 0000.
    await invoices.get('inv-0003')

    adapter._resetCounters()
    await invoices.get('inv-0000') // should be a hit, no adapter call
    expect(adapter._getCalls).toBe(0)
  })

  it('13. put() in lazy mode writes through and inserts into the LRU', async () => {
    const { comp } = await seedAdapterAndReopen(0)
    const invoices = comp.collection<Invoice>('invoices', {
      prefetch: false,
      cache: { maxRecords: 10 },
    })

    await invoices.put('a', { id: 'a', amount: 100, status: 'draft', client: 'A' })
    expect(invoices.cacheStats().size).toBe(1)

    // Verify the write went to the adapter (read it back via a fresh get).
    const got = await invoices.get('a')
    expect(got?.amount).toBe(100)
  })

  it('14. delete() in lazy mode removes from cache and adapter', async () => {
    const { comp } = await seedAdapterAndReopen(5)
    const invoices = comp.collection<Invoice>('invoices', {
      prefetch: false,
      cache: { maxRecords: 10 },
    })

    await invoices.get('inv-0000')
    expect(invoices.cacheStats().size).toBe(1)

    await invoices.delete('inv-0000')
    expect(invoices.cacheStats().size).toBe(0)

    // Reading it back should now return null.
    const r = await invoices.get('inv-0000')
    expect(r).toBeNull()
  })

  it('15. list() throws in lazy mode with a redirect to scan()', async () => {
    const { comp } = await seedAdapterAndReopen(5)
    const invoices = comp.collection<Invoice>('invoices', {
      prefetch: false,
      cache: { maxRecords: 10 },
    })
    await expect(invoices.list()).rejects.toThrow(/list\(\) is not available in lazy mode/)
  })

  it('16. query() throws in lazy mode with a redirect to scan() + filter', async () => {
    const { comp } = await seedAdapterAndReopen(5)
    const invoices = comp.collection<Invoice>('invoices', {
      prefetch: false,
      cache: { maxRecords: 10 },
    })
    expect(() => invoices.query()).toThrow(/query\(\) is not available in lazy mode/)
  })

  it('17. count() works in lazy mode via adapter.list()', async () => {
    const { comp } = await seedAdapterAndReopen(50)
    const invoices = comp.collection<Invoice>('invoices', {
      prefetch: false,
      cache: { maxRecords: 10 },
    })
    expect(await invoices.count()).toBe(50)
    // count() uses adapter.list() (just ids), not the full record fetch.
    // The cache should still be empty because we never called get().
    expect(invoices.cacheStats().size).toBe(0)
  })

  it('18. scan() works in lazy mode and does NOT pollute the LRU', async () => {
    const { comp } = await seedAdapterAndReopen(50)
    const invoices = comp.collection<Invoice>('invoices', {
      prefetch: false,
      cache: { maxRecords: 10 },
    })

    let collected = 0
    for await (const _ of invoices.scan({ pageSize: 25 })) {
      collected++
    }
    expect(collected).toBe(50)

    // Crucial property: the LRU is still empty because scan() bypasses
    // the cache. If scan() populated the LRU, evictions would race with
    // streaming and the LRU would become a useless write-once buffer.
    expect(invoices.cacheStats().size).toBe(0)
  })

  it('19. integration: 200-record collection bounded to 20 random-access reads stays under cap', async () => {
    const { comp } = await seedAdapterAndReopen(200)
    const invoices = comp.collection<Invoice>('invoices', {
      prefetch: false,
      cache: { maxRecords: 20 },
    })

    // Random-access read every record exactly once.
    for (let i = 0; i < 200; i++) {
      const id = `inv-${String(i).padStart(4, '0')}`
      const r = await invoices.get(id)
      expect(r?.id).toBe(id)
      // Cache size should never exceed 20.
      expect(invoices.cacheStats().size).toBeLessThanOrEqual(20)
    }

    const stats = invoices.cacheStats()
    expect(stats.size).toBe(20)
    expect(stats.evictions).toBe(180)
    expect(stats.misses).toBe(200) // every read was a miss (sequential, no overlap)
  })

  it('20. update path in lazy mode increments version correctly', async () => {
    const { comp } = await seedAdapterAndReopen(0)
    const invoices = comp.collection<Invoice>('invoices', {
      prefetch: false,
      cache: { maxRecords: 10 },
    })

    await invoices.put('a', { id: 'a', amount: 100, status: 'draft', client: 'A' })
    await invoices.put('a', { id: 'a', amount: 200, status: 'open',  client: 'A' })
    const got = await invoices.get('a')
    expect(got?.amount).toBe(200)
    expect(got?.status).toBe('open')
  })

  it('21. byte-budget eviction works against real records', async () => {
    const { comp } = await seedAdapterAndReopen(20)
    // Each invoice's JSON is roughly 80–100 bytes. Cap at 250 bytes
    // — should hold 2-3 records depending on JSON encoding overhead.
    const invoices = comp.collection<Invoice>('invoices', {
      prefetch: false,
      cache: { maxBytes: 250 },
    })

    for (let i = 0; i < 10; i++) {
      await invoices.get(`inv-${String(i).padStart(4, '0')}`)
    }

    const stats = invoices.cacheStats()
    expect(stats.bytes).toBeLessThanOrEqual(250)
    expect(stats.evictions).toBeGreaterThan(0)
  })
})
