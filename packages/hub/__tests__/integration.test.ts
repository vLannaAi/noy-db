import { describe, it, expect, beforeEach } from 'vitest'
import { createNoydb } from '../src/noydb.js'
import type { Noydb } from '../src/noydb.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/types.js'
import { ConflictError } from '../src/errors.js'

/** Inline memory adapter to avoid circular workspace dependency. */
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
      if (comp) for (const [n, coll] of comp) { if (!n.startsWith('_')) { const r: Record<string, EncryptedEnvelope> = {}; for (const [id, e] of coll) r[id] = e; s[n] = r } }
      return s
    },
    async saveAll(c, data) {
      for (const [n, recs] of Object.entries(data)) { const coll = getCollection(c, n); for (const [id, e] of Object.entries(recs)) coll.set(id, e) }
    },
  }
}

interface Invoice {
  amount: number
  status: string
  client: string
}

describe('integration: full lifecycle', () => {
  let db: Noydb

  describe('encrypted mode', () => {
    beforeEach(async () => {
      db = await createNoydb({
        store: memory(),
        user: 'owner-01',
        secret: 'test-passphrase-12345',
      })
    })

    it('creates instance and opens compartment', async () => {
      const company = await db.openVault('C101')
      expect(company).toBeDefined()
    })

    it('put + get round-trips with encryption', async () => {
      const company = await db.openVault('C101')
      const invoices = company.collection<Invoice>('invoices')

      await invoices.put('inv-001', {
        amount: 5000,
        status: 'draft',
        client: 'บริษัท ABC',
      })

      const result = await invoices.get('inv-001')
      expect(result).toEqual({
        amount: 5000,
        status: 'draft',
        client: 'บริษัท ABC',
      })
    })

    it('list returns all records', async () => {
      const company = await db.openVault('C101')
      const invoices = company.collection<Invoice>('invoices')

      await invoices.put('inv-001', { amount: 1000, status: 'draft', client: 'A' })
      await invoices.put('inv-002', { amount: 2000, status: 'paid', client: 'B' })
      await invoices.put('inv-003', { amount: 3000, status: 'draft', client: 'C' })

      const all = await invoices.list()
      expect(all).toHaveLength(3)
    })

    it('query filters records', async () => {
      const company = await db.openVault('C101')
      const invoices = company.collection<Invoice>('invoices')

      await invoices.put('inv-001', { amount: 1000, status: 'draft', client: 'A' })
      await invoices.put('inv-002', { amount: 2000, status: 'paid', client: 'B' })
      await invoices.put('inv-003', { amount: 3000, status: 'draft', client: 'C' })

      const drafts = invoices.query(i => i.status === 'draft')
      expect(drafts).toHaveLength(2)

      const large = invoices.query(i => i.amount > 1500)
      expect(large).toHaveLength(2)
    })

    it('delete removes a record', async () => {
      const company = await db.openVault('C101')
      const invoices = company.collection<Invoice>('invoices')

      await invoices.put('inv-001', { amount: 1000, status: 'draft', client: 'A' })
      await invoices.delete('inv-001')

      const result = await invoices.get('inv-001')
      expect(result).toBeNull()
    })

    it('count returns correct number', async () => {
      const company = await db.openVault('C101')
      const invoices = company.collection<Invoice>('invoices')

      await invoices.put('inv-001', { amount: 1000, status: 'draft', client: 'A' })
      await invoices.put('inv-002', { amount: 2000, status: 'paid', client: 'B' })

      expect(await invoices.count()).toBe(2)
    })

    it('get non-existent returns null', async () => {
      const company = await db.openVault('C101')
      const invoices = company.collection<Invoice>('invoices')
      expect(await invoices.get('nonexistent')).toBeNull()
    })

    it('emits change events on put and delete', async () => {
      const events: string[] = []
      db.on('change', (e) => events.push(`${e.action}:${e.id}`))

      const company = await db.openVault('C101')
      const invoices = company.collection<Invoice>('invoices')

      await invoices.put('inv-001', { amount: 1000, status: 'draft', client: 'A' })
      await invoices.delete('inv-001')

      expect(events).toEqual(['put:inv-001', 'delete:inv-001'])
    })

    it('dump produces valid backup JSON', async () => {
      const company = await db.openVault('C101')
      const invoices = company.collection<Invoice>('invoices')

      await invoices.put('inv-001', { amount: 5000, status: 'draft', client: 'ABC' })
      await invoices.put('inv-002', { amount: 3000, status: 'paid', client: 'DEF' })

      const backup = await company.dump()
      expect(typeof backup).toBe('string')

      const parsed = JSON.parse(backup) as Record<string, unknown>
      expect(parsed['_noydb_backup']).toBe(1)
      expect(parsed['_compartment']).toBe('C101')
      expect(parsed['collections']).toBeDefined()
    })

    it('dump and load round-trips in unencrypted mode', async () => {
      const plainDb = await createNoydb({ store: memory(), user: 'dev', encrypt: false })
      const comp = await plainDb.openVault('TEST')
      const invoices = comp.collection<Invoice>('invoices')

      await invoices.put('inv-001', { amount: 5000, status: 'draft', client: 'ABC' })
      await invoices.put('inv-002', { amount: 3000, status: 'paid', client: 'DEF' })

      const backup = await comp.dump()

      // Restore into a new vault on a fresh instance
      const plainDb2 = await createNoydb({ store: memory(), user: 'dev', encrypt: false })
      const comp2 = await plainDb2.openVault('TEST')
      await comp2.load(backup)

      const invoices2 = comp2.collection<Invoice>('invoices')
      expect(await invoices2.get('inv-001')).toEqual({ amount: 5000, status: 'draft', client: 'ABC' })
      expect(await invoices2.get('inv-002')).toEqual({ amount: 3000, status: 'paid', client: 'DEF' })
    })

    it('close clears state', async () => {
      db.close()
      // After close, creating a vault should fail gracefully
      await expect(db.openVault('C101')).rejects.toThrow()
    })
  })

  describe('unencrypted mode', () => {
    beforeEach(async () => {
      db = await createNoydb({
        store: memory(),
        user: 'dev',
        encrypt: false,
      })
    })

    it('put + get works without encryption', async () => {
      const company = await db.openVault('C101')
      const invoices = company.collection<Invoice>('invoices')

      await invoices.put('inv-001', { amount: 5000, status: 'draft', client: 'Test' })
      const result = await invoices.get('inv-001')
      expect(result).toEqual({ amount: 5000, status: 'draft', client: 'Test' })
    })
  })
})
