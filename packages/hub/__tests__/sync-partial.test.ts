import { describe, it, expect, beforeEach } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/types.js'
import { ConflictError } from '../src/errors.js'
import { createNoydb } from '../src/noydb.js'

// ─── Inline memory adapter with optional listSince support ─────────────────

function inlineMemory(opts: { supportsListSince?: boolean } = {}): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function gc(c: string, col: string) {
    let comp = store.get(c); if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col); if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  const adapter: NoydbStore = {
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
      if (comp) for (const [n, coll] of comp) { if (!n.startsWith('_')) { const r: Record<string, EncryptedEnvelope> = {}; for (const [id, e] of coll) r[id] = e; s[n] = r } }
      return s
    },
    async saveAll(c, data) {
      for (const [n, recs] of Object.entries(data)) { const coll = gc(c, n); for (const [id, e] of Object.entries(recs)) coll.set(id, e) }
    },
  }
  if (opts.supportsListSince) {
    adapter.listSince = async (c, col, since) => {
      const coll = store.get(c)?.get(col)
      if (!coll) return []
      return [...coll.entries()]
        .filter(([_id, env]) => env._ts > since)
        .map(([id]) => id)
    }
  }
  return adapter
}

interface Invoice { amount: number; status: string }

const COMP = 'COMP-PARTIAL'

describe('partial sync (v0.9 #133)', () => {
  describe('push({ collections })', () => {
    it('only pushes dirty records from the specified collection', async () => {
      const local = inlineMemory()
      const remote = inlineMemory()

      const db = await createNoydb({ store: local, sync: remote, user: 'u', encrypt: false })
      const comp = await db.openVault(COMP)
      const invoices = comp.collection<Invoice>('invoices')
      const payments = comp.collection<Invoice>('payments')

      await invoices.put('inv-1', { amount: 100, status: 'draft' })
      await payments.put('pay-1', { amount: 50, status: 'pending' })

      expect(db.syncStatus(COMP).dirty).toBe(2)

      // Only push invoices
      const result = await db.push(COMP, { collections: ['invoices'] })
      expect(result.pushed).toBe(1)
      expect(result.errors).toHaveLength(0)

      // invoices pushed, payments not
      expect(await remote.get(COMP, 'invoices', 'inv-1')).not.toBeNull()
      expect(await remote.get(COMP, 'payments', 'pay-1')).toBeNull()

      // payments still dirty
      expect(db.syncStatus(COMP).dirty).toBe(1)
    })

    it('omitting collections pushes all dirty records (backward compat)', async () => {
      const local = inlineMemory()
      const remote = inlineMemory()

      const db = await createNoydb({ store: local, sync: remote, user: 'u', encrypt: false })
      const comp = await db.openVault(COMP)
      await comp.collection<Invoice>('invoices').put('inv-1', { amount: 100, status: 'a' })
      await comp.collection<Invoice>('payments').put('pay-1', { amount: 50, status: 'b' })

      const result = await db.push(COMP)
      expect(result.pushed).toBe(2)
      expect(db.syncStatus(COMP).dirty).toBe(0)
    })

    it('pushing an empty collection filter produces 0 pushed', async () => {
      const local = inlineMemory()
      const remote = inlineMemory()

      const db = await createNoydb({ store: local, sync: remote, user: 'u', encrypt: false })
      const comp = await db.openVault(COMP)
      await comp.collection<Invoice>('invoices').put('inv-1', { amount: 100, status: 'a' })

      const result = await db.push(COMP, { collections: ['payments'] })
      expect(result.pushed).toBe(0)
      expect(db.syncStatus(COMP).dirty).toBe(1) // still dirty
    })
  })

  describe('pull({ collections })', () => {
    it('only pulls records from the specified collection', async () => {
      const localA = inlineMemory()
      const localB = inlineMemory()
      const remote = inlineMemory()

      const dbA = await createNoydb({ store: localA, sync: remote, user: 'a', encrypt: false })
      const dbB = await createNoydb({ store: localB, sync: remote, user: 'b', encrypt: false })

      const compA = await dbA.openVault(COMP)
      await compA.collection<Invoice>('invoices').put('inv-1', { amount: 100, status: 'x' })
      await compA.collection<Invoice>('payments').put('pay-1', { amount: 50, status: 'y' })
      await dbA.push(COMP)

      await dbB.openVault(COMP)
      const result = await dbB.pull(COMP, { collections: ['invoices'] })

      expect(result.pulled).toBe(1)
      expect(await localB.get(COMP, 'invoices', 'inv-1')).not.toBeNull()
      expect(await localB.get(COMP, 'payments', 'pay-1')).toBeNull()
    })
  })

  describe('pull({ modifiedSince })', () => {
    it('only pulls records with _ts after the cutoff', async () => {
      const local = inlineMemory()
      const remote = inlineMemory()

      // Seed the remote adapter directly with controlled timestamps
      const cutoff = '2026-01-15T00:00:00.000Z'
      await remote.put(COMP, 'invoices', 'inv-old', {
        _noydb: 1, _v: 1, _ts: '2026-01-10T00:00:00.000Z', _iv: '', _data: JSON.stringify({ amount: 1, status: 'old' }),
      })
      await remote.put(COMP, 'invoices', 'inv-new', {
        _noydb: 1, _v: 1, _ts: '2026-01-20T00:00:00.000Z', _iv: '', _data: JSON.stringify({ amount: 2, status: 'new' }),
      })

      const db = await createNoydb({ store: local, sync: remote, user: 'u', encrypt: false })
      await db.openVault(COMP)
      const result = await db.pull(COMP, { modifiedSince: cutoff })

      // Only inv-new (_ts after cutoff) should be pulled
      expect(await local.get(COMP, 'invoices', 'inv-new')).not.toBeNull()
      expect(await local.get(COMP, 'invoices', 'inv-old')).toBeNull()
      expect(result.pulled).toBe(1)
    })

    it('combines collections + modifiedSince filters', async () => {
      const local = inlineMemory()
      const remote = inlineMemory()

      const cutoff = '2026-01-15T00:00:00.000Z'
      // invoices/inv-recent is after cutoff — should be pulled
      await remote.put(COMP, 'invoices', 'inv-recent', {
        _noydb: 1, _v: 1, _ts: '2026-01-20T00:00:00.000Z', _iv: '', _data: JSON.stringify({ amount: 1, status: 'a' }),
      })
      // payments/pay-recent is after cutoff but wrong collection — should be skipped
      await remote.put(COMP, 'payments', 'pay-recent', {
        _noydb: 1, _v: 1, _ts: '2026-01-20T00:00:00.000Z', _iv: '', _data: JSON.stringify({ amount: 2, status: 'b' }),
      })

      const db = await createNoydb({ store: local, sync: remote, user: 'u', encrypt: false })
      await db.openVault(COMP)
      // Filter to invoices only + modifiedSince
      const result = await db.pull(COMP, { collections: ['invoices'], modifiedSince: cutoff })

      expect(await local.get(COMP, 'invoices', 'inv-recent')).not.toBeNull()
      expect(await local.get(COMP, 'payments', 'pay-recent')).toBeNull()
      expect(result.pulled).toBe(1)
    })
  })

  describe('sync() with options', () => {
    it('passes push and pull options through', async () => {
      const localA = inlineMemory()
      const localB = inlineMemory()
      const remote = inlineMemory()

      const dbA = await createNoydb({ store: localA, sync: remote, user: 'a', encrypt: false })
      const compA = await dbA.openVault(COMP)
      await compA.collection<Invoice>('invoices').put('inv-1', { amount: 1, status: 'a' })
      await compA.collection<Invoice>('payments').put('pay-1', { amount: 2, status: 'b' })

      // Only sync invoices
      const result = await dbA.sync(COMP, {
        push: { collections: ['invoices'] },
        pull: { collections: ['invoices'] },
      })

      expect(result.push.pushed).toBe(1)
      expect(await remote.get(COMP, 'payments', 'pay-1')).toBeNull()
    })
  })
})
