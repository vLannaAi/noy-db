import { describe, it, expect, beforeEach } from 'vitest'
import { createNoydb } from '../src/noydb.js'
import type { Noydb } from '../src/noydb.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/types.js'
import { ConflictError } from '../src/errors.js'
import { Query } from '../src/query/index.js'

/** Inline memory adapter — same pattern as integration.test.ts. */
function memory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function getCollection(c: string, col: string) {
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
      // Preserve any existing _keyring entries that loadAll() filters out.
      const existing = store.get(c)
      if (existing) {
        for (const [name, coll] of existing) {
          if (name.startsWith('_')) comp.set(name, coll)
        }
      }
      store.set(c, comp)
    },
  }
}

interface Invoice {
  amount: number
  status: 'draft' | 'open' | 'paid' | 'overdue'
  client: string
  dueDate: string
}

describe('Collection.query() — integration with crypto + adapter', () => {
  let db: Noydb

  beforeEach(async () => {
    db = await createNoydb({
      store: memory(),
      user: 'owner',
      secret: 'integration-test-passphrase-2026',
    })
    const c = await db.openVault('TEST')
    const invoices = c.collection<Invoice>('invoices')
    await invoices.put('inv-001', { amount: 100,  status: 'draft', client: 'Alpha',   dueDate: '2026-04-01' })
    await invoices.put('inv-002', { amount: 250,  status: 'open',  client: 'Bravo',   dueDate: '2026-03-15' })
    await invoices.put('inv-003', { amount: 5000, status: 'open',  client: 'Charlie', dueDate: '2026-05-01' })
    await invoices.put('inv-004', { amount: 800,  status: 'paid',  client: 'Delta',   dueDate: '2026-02-28' })
    await invoices.put('inv-005', { amount: 1500, status: 'overdue', client: 'Echo',  dueDate: '2026-01-10' })
  })

  it('returns a Query builder when called with no arguments', async () => {
    const c = await db.openVault('TEST')
    const invoices = c.collection<Invoice>('invoices')
    const q = invoices.query()
    expect(q).toBeInstanceOf(Query)
  })

  it('still supports the legacy predicate form', async () => {
    const c = await db.openVault('TEST')
    const invoices = c.collection<Invoice>('invoices')
    const drafts = invoices.query(i => i.status === 'draft')
    expect(drafts).toHaveLength(1)
    expect(drafts[0]?.client).toBe('Alpha')
  })

  it('runs a chained query against decrypted records', async () => {
    const c = await db.openVault('TEST')
    const invoices = c.collection<Invoice>('invoices')
    const result = invoices.query()
      .where('status', '==', 'open')
      .where('amount', '>', 1000)
      .toArray()
    expect(result).toHaveLength(1)
    expect(result[0]?.client).toBe('Charlie')
  })

  it('orderBy + limit work together', async () => {
    const c = await db.openVault('TEST')
    const invoices = c.collection<Invoice>('invoices')
    const top2 = invoices.query()
      .orderBy('amount', 'desc')
      .limit(2)
      .toArray()
    expect(top2.map(r => r.amount)).toEqual([5000, 1500])
  })

  it('count() reports total matches', async () => {
    const c = await db.openVault('TEST')
    const invoices = c.collection<Invoice>('invoices')
    expect(invoices.query().where('status', '==', 'open').count()).toBe(2)
  })

  it('first() returns one or null', async () => {
    const c = await db.openVault('TEST')
    const invoices = c.collection<Invoice>('invoices')
    expect(invoices.query().where('status', '==', 'paid').first()?.client).toBe('Delta')
    expect(invoices.query().where('status', '==', 'nonexistent').first()).toBeNull()
  })

  it('subscribe() reacts to put() and delete()', async () => {
    const c = await db.openVault('TEST')
    const invoices = c.collection<Invoice>('invoices')

    const seen: Invoice[][] = []
    const stop = invoices.query()
      .where('status', '==', 'open')
      .subscribe((r) => seen.push(r))

    expect(seen).toHaveLength(1)
    expect(seen[0]).toHaveLength(2)

    await invoices.put('inv-006', { amount: 999, status: 'open', client: 'Foxtrot', dueDate: '2026-06-01' })
    expect(seen).toHaveLength(2)
    expect(seen[1]).toHaveLength(3)

    await invoices.delete('inv-002')
    expect(seen).toHaveLength(3)
    expect(seen[2]).toHaveLength(2)

    stop()
    await invoices.put('inv-007', { amount: 1, status: 'open', client: 'Golf', dueDate: '2026-07-01' })
    expect(seen).toHaveLength(3) // unsubscribed — no new entry
  })

  it('survives a 1K-record dataset across all operators', async () => {
    const c = await db.openVault('TEST')
    const stress = c.collection<Invoice>('stress')
    const N = 1000
    for (let i = 0; i < N; i++) {
      await stress.put(`s-${i}`, {
        amount: i * 10,
        status: (['draft', 'open', 'paid', 'overdue'] as const)[i % 4]!,
        client: `Client-${i % 25}`,
        dueDate: `2026-${String((i % 12) + 1).padStart(2, '0')}-15`,
      })
    }

    expect(stress.query().count()).toBe(N)
    expect(stress.query().where('status', '==', 'open').count()).toBe(250)
    expect(stress.query().where('amount', 'between', [0, 999]).count()).toBe(100)
    expect(stress.query().where('amount', '<', 100).count()).toBe(10)
    expect(stress.query().where('client', 'in', ['Client-0', 'Client-1']).count()).toBe(80)
    expect(stress.query().where('client', 'startsWith', 'Client-').count()).toBe(N)
    // 1000 records cycling through 12 months: month 1 occurs at i = 0,12,24,...
    // Indexes 0..999 give months 1..12; month 1 hits ⌈1000/12⌉ = 84 records.
    expect(stress.query().where('dueDate', 'contains', '2026-01').count()).toBe(84)
    expect(stress.query().orderBy('amount', 'desc').limit(5).toArray().map(r => r.amount))
      .toEqual([9990, 9980, 9970, 9960, 9950])
  })
})
