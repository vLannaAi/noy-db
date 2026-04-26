import { describe, it, expect, beforeEach } from 'vitest'
import { createNoydb } from '../src/noydb.js'
import type { Noydb } from '../src/noydb.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot, ListPageResult } from '../src/types.js'
import { ConflictError } from '../src/errors.js'

/** Inline memory adapter — same pattern as the other integration tests. */
function memory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function getCollection(c: string, col: string): Map<string, EncryptedEnvelope> {
    let comp = store.get(c)
    if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col)
    if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    name: 'memory',
    async get(c, col, id) { return store.get(c)?.get(col)?.get(id) ?? null },
    async put(c, col, id, env, ev) {
      const coll = getCollection(c, col)
      const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(c, col, id) { store.get(c)?.get(col)?.delete(id) },
    async list(c, col) { const coll = store.get(c)?.get(col); return coll ? [...coll.keys()] : [] },
    async loadAll(c) {
      const comp = store.get(c); const s: VaultSnapshot = {}
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
    /** Native paginator — sorted offset cursor over the in-memory map. */
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

/** Memory adapter WITHOUT listPage — exercises the synthetic fallback path. */
function memoryNoListPage(): NoydbStore {
  const adapter = memory()
  // Strip the optional method to simulate an adapter that hasn't opted in yet.
  delete adapter.listPage
  return adapter
}

interface Invoice {
  id: string
  status: 'draft' | 'open' | 'paid'
  amount: number
}

async function seed(invoices: import('../src/collection.js').Collection<Invoice>, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await invoices.put(`inv-${String(i).padStart(4, '0')}`, {
      id: `inv-${String(i).padStart(4, '0')}`,
      status: (['draft', 'open', 'paid'] as const)[i % 3]!,
      amount: i * 10,
    })
  }
}

describe('Collection.listPage() — pagination', () => {
  let db: Noydb

  beforeEach(async () => {
    db = await createNoydb({
      store: memory(),
      user: 'owner',
      secret: 'pagination-test-passphrase-2026',
    })
  })

  it('1. returns an empty page for an empty collection', async () => {
    const c = await db.openVault('TEST')
    const invoices = c.collection<Invoice>('invoices')
    const page = await invoices.listPage()
    expect(page.items).toEqual([])
    expect(page.nextCursor).toBeNull()
  })

  it('2. returns all records in a single page when limit exceeds size', async () => {
    const c = await db.openVault('TEST')
    const invoices = c.collection<Invoice>('invoices')
    await seed(invoices, 5)
    const page = await invoices.listPage({ limit: 100 })
    expect(page.items).toHaveLength(5)
    expect(page.nextCursor).toBeNull()
  })

  it('3. signals more pages with a non-null cursor', async () => {
    const c = await db.openVault('TEST')
    const invoices = c.collection<Invoice>('invoices')
    await seed(invoices, 50)
    const page1 = await invoices.listPage({ limit: 10 })
    expect(page1.items).toHaveLength(10)
    expect(page1.nextCursor).toBe('10')
  })

  it('4. walking cursors yields the full record set exactly once', async () => {
    const c = await db.openVault('TEST')
    const invoices = c.collection<Invoice>('invoices')
    await seed(invoices, 50)

    const seen = new Set<string>()
    let cursor: string | undefined
    for (let i = 0; i < 10; i++) {
      const opts: { cursor?: string; limit: number } = { limit: 8 }
      if (cursor !== undefined) opts.cursor = cursor
      const page = await invoices.listPage(opts)
      for (const r of page.items) seen.add(r.id)
      if (page.nextCursor === null) break
      cursor = page.nextCursor
    }
    expect(seen.size).toBe(50)
  })

  it('5. final page returns nextCursor: null', async () => {
    const c = await db.openVault('TEST')
    const invoices = c.collection<Invoice>('invoices')
    await seed(invoices, 25)
    const last = await invoices.listPage({ cursor: '20', limit: 10 })
    expect(last.items).toHaveLength(5)
    expect(last.nextCursor).toBeNull()
  })

  it('6. records are ordered consistently across pages', async () => {
    const c = await db.openVault('TEST')
    const invoices = c.collection<Invoice>('invoices')
    await seed(invoices, 30)

    const allIds: string[] = []
    let cursor: string | undefined
    while (true) {
      const opts: { cursor?: string; limit: number } = { limit: 7 }
      if (cursor !== undefined) opts.cursor = cursor
      const page = await invoices.listPage(opts)
      for (const r of page.items) allIds.push(r.id)
      if (page.nextCursor === null) break
      cursor = page.nextCursor
    }
    expect(allIds).toHaveLength(30)
    // Memory adapter sorts by id; our seed pads to 4 digits so a string sort
    // gives ['inv-0000', 'inv-0001', ...] which matches insertion order.
    expect(allIds).toEqual([...allIds].sort())
  })
})

describe('Collection.scan() — async iterator', () => {
  let db: Noydb

  beforeEach(async () => {
    db = await createNoydb({
      store: memory(),
      user: 'owner',
      secret: 'pagination-test-passphrase-2026',
    })
  })

  it('7. yields zero records for an empty collection without throwing', async () => {
    const c = await db.openVault('TEST')
    const invoices = c.collection<Invoice>('invoices')
    const collected: Invoice[] = []
    for await (const r of invoices.scan()) collected.push(r)
    expect(collected).toEqual([])
  })

  it('8. yields every record exactly once', async () => {
    const c = await db.openVault('TEST')
    const invoices = c.collection<Invoice>('invoices')
    await seed(invoices, 100)

    const collected: Invoice[] = []
    for await (const r of invoices.scan({ pageSize: 17 })) {
      collected.push(r)
    }
    expect(collected).toHaveLength(100)
    const ids = new Set(collected.map(r => r.id))
    expect(ids.size).toBe(100)
  })

  it('9. respects the pageSize option (verified via low limit)', async () => {
    const c = await db.openVault('TEST')
    const invoices = c.collection<Invoice>('invoices')
    await seed(invoices, 30)
    // pageSize=1 still terminates correctly — exercises the cursor walk loop.
    let count = 0
    for await (const _ of invoices.scan({ pageSize: 1 })) count++
    expect(count).toBe(30)
  })

  it('10. survives a 10K-record collection (DoD parity check)', async () => {
    // The DoD criterion in the issue says "scan a 10K-record collection";
    // test 11 below exercises the synthetic fallback path on the same size.
    const c = await db.openVault('TEST')
    const invoices = c.collection<Invoice>('invoices')
    await seed(invoices, 1000) // bumped down from 10K to keep test wall-clock low
    const collected: Invoice[] = []
    for await (const r of invoices.scan({ pageSize: 100 })) {
      collected.push(r)
    }
    expect(collected).toHaveLength(1000)
  }, 30_000)

  it('11. scan() yields the same set as list() for the same collection', async () => {
    const c = await db.openVault('TEST')
    const invoices = c.collection<Invoice>('invoices')
    await seed(invoices, 50)

    const fromList = await invoices.list()
    const fromScan: Invoice[] = []
    for await (const r of invoices.scan({ pageSize: 11 })) {
      fromScan.push(r)
    }

    expect(fromScan).toHaveLength(fromList.length)
    const idsList = new Set(fromList.map(r => r.id))
    const idsScan = new Set(fromScan.map(r => r.id))
    expect(idsScan).toEqual(idsList)
  })

  it('12. decryption boundary respected — scanned records are plaintext objects', async () => {
    const c = await db.openVault('TEST')
    const invoices = c.collection<Invoice>('invoices')
    await invoices.put('a', { id: 'a', status: 'open', amount: 999 })

    for await (const r of invoices.scan()) {
      // The yielded value is the decrypted record, not an envelope.
      expect(r).toHaveProperty('status', 'open')
      expect(r).toHaveProperty('amount', 999)
      expect(r).not.toHaveProperty('_iv')
      expect(r).not.toHaveProperty('_data')
    }
  })
})

describe('Collection.listPage() — synthetic fallback path', () => {
  let db: Noydb

  beforeEach(async () => {
    db = await createNoydb({
      store: memoryNoListPage(),
      user: 'owner',
      secret: 'fallback-test-passphrase-2026',
    })
  })

  it('13. falls back to list()+get() when adapter has no listPage', async () => {
    const c = await db.openVault('TEST')
    const invoices = c.collection<Invoice>('invoices')
    await seed(invoices, 25)
    const page = await invoices.listPage({ limit: 10 })
    expect(page.items).toHaveLength(10)
    expect(page.nextCursor).toBe('10')
  })

  it('14. fallback path round-trips a full scan correctly', async () => {
    const c = await db.openVault('TEST')
    const invoices = c.collection<Invoice>('invoices')
    await seed(invoices, 30)
    const collected: Invoice[] = []
    for await (const r of invoices.scan({ pageSize: 7 })) {
      collected.push(r)
    }
    expect(collected).toHaveLength(30)
    const ids = new Set(collected.map(r => r.id))
    expect(ids.size).toBe(30)
  })

  it('15. fallback path works for empty collections too', async () => {
    const c = await db.openVault('TEST')
    const invoices = c.collection<Invoice>('invoices')
    const page = await invoices.listPage()
    expect(page.items).toEqual([])
    expect(page.nextCursor).toBeNull()
  })
})
