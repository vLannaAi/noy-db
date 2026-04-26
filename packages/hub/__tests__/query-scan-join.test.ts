/**
 * Tests for ScanBuilder.join() — v0.6 #76 streaming joins.
 *
 * Covers:
 *   - Happy path: streaming join with indexed (lookupById) right side
 *   - Hash strategy: streaming join with snapshot()-only right side
 *   - All three ref modes (strict / warn / cascade)
 *   - Null FK passes through regardless of mode
 *   - Multi-FK chaining via repeated .join()
 *   - .where() composes with .join()
 *   - .scan().join().aggregate() — joined streaming aggregation
 *   - Backward compat: .scan() without .join() still works
 *   - Resolves to undefined when joinContext is missing
 *   - Multi-page streaming with joins
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { createNoydb, type Noydb } from '../src/noydb.js'
import type {
  NoydbStore,
  EncryptedEnvelope,
  VaultSnapshot,
  ListPageResult,
} from '../src/types.js'
import { ConflictError, DanglingReferenceError } from '../src/errors.js'
import { ScanBuilder, count, sum, type ScanPageProvider, type JoinContext } from '../src/query/index.js'
import { ref } from '../src/refs.js'

/** Inline memory adapter — same shape as the existing integration tests. */
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
      return { items, nextCursor: end < ids.length ? String(end) : null }
    },
  }
}

interface Client {
  id: string
  name: string
  tier: 'standard' | 'premium'
}

interface Invoice {
  id: string
  amount: number
  status: 'draft' | 'open' | 'paid'
  clientId: string | null
}

interface Category {
  id: string
  label: string
}

interface InvoiceWithCat {
  id: string
  amount: number
  clientId: string
  categoryId: string | null
}

async function seedCompartment(
  db: Noydb,
  opts: { refMode?: 'strict' | 'warn' | 'cascade' } = {},
): Promise<{
  invoices: import('../src/collection.js').Collection<Invoice>
  clients: import('../src/collection.js').Collection<Client>
}> {
  const mode = opts.refMode ?? 'strict'
  const c = await db.openVault('TEST')
  const clients = c.collection<Client>('clients')
  const invoices = c.collection<Invoice>('invoices', {
    refs: { clientId: ref('clients', mode) },
  })

  await clients.put('cli-A', { id: 'cli-A', name: 'Acme Corp',   tier: 'premium' })
  await clients.put('cli-B', { id: 'cli-B', name: 'Beacon LLC',  tier: 'standard' })
  await clients.put('cli-C', { id: 'cli-C', name: 'Crestwood',   tier: 'premium' })

  await invoices.put('inv-1', { id: 'inv-1', amount: 1200, status: 'open',  clientId: 'cli-A' })
  await invoices.put('inv-2', { id: 'inv-2', amount: 300,  status: 'open',  clientId: 'cli-B' })
  await invoices.put('inv-3', { id: 'inv-3', amount: 5000, status: 'paid',  clientId: 'cli-A' })
  await invoices.put('inv-4', { id: 'inv-4', amount: 700,  status: 'draft', clientId: 'cli-C' })

  return { invoices, clients }
}

// ---------------------------------------------------------------------------
// Backward-compat / unit tests with synthetic page provider
// ---------------------------------------------------------------------------

function arrayProvider<T>(records: T[], pageSize = 100): ScanPageProvider<T> {
  return {
    async listPage(opts) {
      const limit = opts.limit ?? pageSize
      const start = opts.cursor ? parseInt(opts.cursor, 10) : 0
      const end = Math.min(start + limit, records.length)
      return {
        items: records.slice(start, end),
        nextCursor: end < records.length ? String(end) : null,
      }
    },
  }
}

describe('ScanBuilder > .join() without joinContext', () => {
  it('throws an actionable error when constructed without a join context', () => {
    const builder = new ScanBuilder(arrayProvider([{ id: 'a', clientId: 'x' }]), 10)
    expect(() => builder.join('clientId', { as: 'client' })).toThrow(
      /requires a join context/i,
    )
  })
})

// ---------------------------------------------------------------------------
// Real-collection integration tests
// ---------------------------------------------------------------------------

describe('Collection.scan().join() > strict mode (default)', () => {
  let db: Noydb

  beforeEach(async () => {
    db = await createNoydb({
      store: memory(),
      user: 'owner',
      secret: 'scan-join-test-passphrase-2026',
    })
  })

  it('attaches the right-side client to every invoice via lookupById', async () => {
    const { invoices } = await seedCompartment(db)
    const collected: Array<Invoice & { client: Client | null }> = []
    for await (const row of invoices.scan({ pageSize: 2 }).join<'client', Client>('clientId', { as: 'client' })) {
      collected.push(row)
    }
    expect(collected).toHaveLength(4)
    const inv1 = collected.find((r) => r.id === 'inv-1')!
    expect(inv1.client).toEqual({ id: 'cli-A', name: 'Acme Corp', tier: 'premium' })
    const inv4 = collected.find((r) => r.id === 'inv-4')!
    expect(inv4.client?.tier).toBe('premium') // Crestwood
  })

  it('composes with .where() — clauses run before joins', async () => {
    const { invoices } = await seedCompartment(db)
    const collected: Array<Invoice & { client: Client | null }> = []
    for await (const row of invoices.scan({ pageSize: 2 })
      .where('status', '==', 'open')
      .join<'client', Client>('clientId', { as: 'client' })
    ) {
      collected.push(row)
    }
    expect(collected).toHaveLength(2)
    expect(collected.map((r) => r.id).sort()).toEqual(['inv-1', 'inv-2'])
    expect(collected.find((r) => r.id === 'inv-1')!.client?.name).toBe('Acme Corp')
  })

  it('walks every page when pageSize is smaller than the collection', async () => {
    const { invoices } = await seedCompartment(db)
    const collected: Array<Invoice & { client: Client | null }> = []
    for await (const row of invoices.scan({ pageSize: 1 }).join<'client', Client>('clientId', { as: 'client' })) {
      collected.push(row)
    }
    expect(collected).toHaveLength(4)
    expect(collected.every((r) => r.client !== null)).toBe(true)
  })
})

describe('ScanBuilder > strict mode throws DanglingReferenceError mid-stream', () => {
  // Strict-mode integration is awkward to set up against a real
  // Collection — write-time strict refs reject the dangling put, and
  // re-opening a Collection with a different ref mode is a no-op
  // because the vault caches the original instance. So we
  // exercise the strict-mode read path at the ScanBuilder unit
  // level with a synthetic JoinContext, the same approach the
  // eager Query.join() tests use for this case.
  it('throws DanglingReferenceError mid-iteration when strict ref encounters a dangling FK', async () => {
    const records = [
      { id: 'inv-1', amount: 100, clientId: 'cli-A' },
      { id: 'inv-bad', amount: 999, clientId: 'cli-MISSING' },
    ]
    const rightSnapshot = [{ id: 'cli-A', name: 'Alpha' }]
    const ctx: JoinContext = {
      leftCollection: 'invoices',
      resolveRef: (field) =>
        field === 'clientId' ? { target: 'clients', mode: 'strict' } : null,
      resolveSource: (name) =>
        name === 'clients'
          ? {
              snapshot: () => rightSnapshot,
              lookupById: (id: string) =>
                rightSnapshot.find((r) => r.id === id),
            }
          : null,
    }
    const builder = new ScanBuilder(arrayProvider(records), 10, [], [], ctx)
      .join<'client', { id: string; name: string }>('clientId', { as: 'client' })

    let threw: unknown = null
    try {
      for await (const _row of builder) {
        // consume — second record should throw
      }
    } catch (err) {
      threw = err
    }
    expect(threw).toBeInstanceOf(DanglingReferenceError)
    const e = threw as DanglingReferenceError
    expect(e.field).toBe('clientId')
    expect(e.refId).toBe('cli-MISSING')
    expect(e.target).toBe('clients')
  })
})

describe('Collection.scan().join() > ref-mode dispatch on dangling refs', () => {
  let db: Noydb

  beforeEach(async () => {
    db = await createNoydb({
      store: memory(),
      user: 'owner',
      secret: 'scan-join-test-passphrase-2026',
    })
  })

  it('warn mode attaches null and emits a one-shot warning', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const c = await db.openVault('TEST')
      const clients = c.collection<Client>('clients')
      const invoices = c.collection<Invoice>('invoices', {
        refs: { clientId: ref('clients', 'warn') },
      })
      await clients.put('cli-A', { id: 'cli-A', name: 'A', tier: 'premium' })
      await invoices.put('inv-1', { id: 'inv-1', amount: 100, status: 'open', clientId: 'cli-A' })
      await invoices.put('inv-2', { id: 'inv-2', amount: 200, status: 'open', clientId: 'cli-MISSING' })
      await invoices.put('inv-3', { id: 'inv-3', amount: 300, status: 'open', clientId: 'cli-MISSING' })

      const collected: Array<Invoice & { client: Client | null }> = []
      for await (const row of invoices.scan({ pageSize: 10 }).join<'client', Client>('clientId', { as: 'client' })) {
        collected.push(row)
      }

      const inv1 = collected.find((r) => r.id === 'inv-1')!
      const inv2 = collected.find((r) => r.id === 'inv-2')!
      const inv3 = collected.find((r) => r.id === 'inv-3')!
      expect(inv1.client?.name).toBe('A')
      expect(inv2.client).toBeNull()
      expect(inv3.client).toBeNull()

      // One-shot dedup — same dangling pair only warns once even
      // though two records hit it.
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(warnSpy.mock.calls[0]![0]).toMatch(/dangling ref/)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('cascade mode attaches null silently', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const c = await db.openVault('TEST')
      const clients = c.collection<Client>('clients')
      const invoices = c.collection<Invoice>('invoices', {
        refs: { clientId: ref('clients', 'cascade') },
      })
      await clients.put('cli-A', { id: 'cli-A', name: 'A', tier: 'premium' })
      await invoices.put('inv-1', { id: 'inv-1', amount: 100, status: 'open', clientId: 'cli-A' })
      await invoices.put('inv-2', { id: 'inv-2', amount: 200, status: 'open', clientId: 'cli-MISSING' })

      const collected: Array<Invoice & { client: Client | null }> = []
      for await (const row of invoices.scan({ pageSize: 10 }).join<'client', Client>('clientId', { as: 'client' })) {
        collected.push(row)
      }

      const inv2 = collected.find((r) => r.id === 'inv-2')!
      expect(inv2.client).toBeNull()
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('null FK value attaches null regardless of mode', async () => {
    const c = await db.openVault('TEST')
    const clients = c.collection<Client>('clients')
    const invoices = c.collection<Invoice>('invoices', {
      refs: { clientId: ref('clients', 'strict') },
    })
    await clients.put('cli-A', { id: 'cli-A', name: 'A', tier: 'premium' })
    // Strict mode allows null FK at write time — that's the
    // "no reference at all" policy.
    await invoices.put('inv-1', { id: 'inv-1', amount: 100, status: 'open', clientId: 'cli-A' })
    await invoices.put('inv-2', { id: 'inv-2', amount: 200, status: 'open', clientId: null })

    const collected: Array<Invoice & { client: Client | null }> = []
    for await (const row of invoices.scan({ pageSize: 10 }).join<'client', Client>('clientId', { as: 'client' })) {
      collected.push(row)
    }
    const inv2 = collected.find((r) => r.id === 'inv-2')!
    expect(inv2.client).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Multi-FK chaining
// ---------------------------------------------------------------------------

describe('Collection.scan().join().join() > multi-FK chaining', () => {
  let db: Noydb

  beforeEach(async () => {
    db = await createNoydb({
      store: memory(),
      user: 'owner',
      secret: 'scan-join-test-passphrase-2026',
    })
  })

  it('chains two .join() calls and attaches both right-side records', async () => {
    const c = await db.openVault('TEST')
    const clients = c.collection<Client>('clients')
    const categories = c.collection<Category>('categories')
    const invoices = c.collection<InvoiceWithCat>('invoices', {
      refs: {
        clientId: ref('clients', 'strict'),
        categoryId: ref('categories', 'warn'),
      },
    })

    await clients.put('cli-A', { id: 'cli-A', name: 'Acme', tier: 'premium' })
    await clients.put('cli-B', { id: 'cli-B', name: 'Beacon', tier: 'standard' })
    await categories.put('cat-1', { id: 'cat-1', label: 'consulting' })
    await categories.put('cat-2', { id: 'cat-2', label: 'hardware' })

    await invoices.put('inv-1', { id: 'inv-1', amount: 100, clientId: 'cli-A', categoryId: 'cat-1' })
    await invoices.put('inv-2', { id: 'inv-2', amount: 200, clientId: 'cli-B', categoryId: 'cat-2' })
    await invoices.put('inv-3', { id: 'inv-3', amount: 300, clientId: 'cli-A', categoryId: null })

    const collected: Array<InvoiceWithCat & { client: Client | null; category: Category | null }> = []
    for await (const row of invoices.scan({ pageSize: 1 })
      .join<'client', Client>('clientId', { as: 'client' })
      .join<'category', Category>('categoryId', { as: 'category' })
    ) {
      collected.push(row)
    }

    expect(collected).toHaveLength(3)
    const inv1 = collected.find((r) => r.id === 'inv-1')!
    expect(inv1.client?.name).toBe('Acme')
    expect(inv1.category?.label).toBe('consulting')
    const inv3 = collected.find((r) => r.id === 'inv-3')!
    expect(inv3.client?.name).toBe('Acme')
    expect(inv3.category).toBeNull() // null FK
  })
})

// ---------------------------------------------------------------------------
// .scan().join().aggregate() — joined streaming aggregation
// ---------------------------------------------------------------------------

describe('Collection.scan().join().aggregate() > joined streaming aggregation', () => {
  let db: Noydb

  beforeEach(async () => {
    db = await createNoydb({
      store: memory(),
      user: 'owner',
      secret: 'scan-join-test-passphrase-2026',
    })
  })

  it('reduces a joined stream — joins are applied before .aggregate() consumes records', async () => {
    // Important ordering: clauses run BEFORE joins in the streaming
    // pipeline (matching the eager Query.toArray() ordering), so
    // .where() / .filter() can only see un-joined fields. Filtering
    // on joined fields requires a follow-up post-aggregate filter
    // in userland — out of scope for v0.6, file an issue if needed.
    //
    // This test verifies that the joined stream reaches the
    // aggregator and that count() / sum() reduce correctly across
    // pages with joins active.
    const { invoices } = await seedCompartment(db)
    const result = await invoices.scan({ pageSize: 2 })
      .where('status', '==', 'open')
      .join<'client', Client>('clientId', { as: 'client' })
      .aggregate({ n: count(), total: sum('amount') })
    // Open invoices: inv-1 (1200), inv-2 (300). Total 1500. Count 2.
    expect(result.n).toBe(2)
    expect(result.total).toBe(1500)
  })

  it('aggregates the entire joined stream without filtering', async () => {
    const { invoices } = await seedCompartment(db)
    const result = await invoices.scan({ pageSize: 1 })
      .join<'client', Client>('clientId', { as: 'client' })
      .aggregate({ n: count(), total: sum('amount') })
    // All 4 invoices: 1200 + 300 + 5000 + 700 = 7200
    expect(result.n).toBe(4)
    expect(result.total).toBe(7200)
  })
})

// ---------------------------------------------------------------------------
// Backward compatibility — scan() without join() unchanged
// ---------------------------------------------------------------------------

describe('Collection.scan() > backward compatibility unchanged', () => {
  let db: Noydb

  beforeEach(async () => {
    db = await createNoydb({
      store: memory(),
      user: 'owner',
      secret: 'scan-join-test-passphrase-2026',
    })
  })

  it('for await without .join() still yields plain records', async () => {
    const { invoices } = await seedCompartment(db)
    const collected: Invoice[] = []
    for await (const r of invoices.scan({ pageSize: 2 })) {
      collected.push(r as Invoice)
    }
    expect(collected).toHaveLength(4)
    // No `client` field attached.
    for (const r of collected) {
      expect((r as unknown as Record<string, unknown>)['client']).toBeUndefined()
    }
  })
})
