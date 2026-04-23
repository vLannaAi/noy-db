import { describe, it, expect, beforeEach } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/types.js'
import { ConflictError } from '../src/errors.js'
import { createNoydb } from '../src/noydb.js'
import type { Noydb } from '../src/noydb.js'

function persistentMemory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function gc(c: string, col: string) {
    let comp = store.get(c); if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col); if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
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
}

interface Invoice { amount: number; status: string }

describe('audit history', () => {
  const COMP = 'C101'
  let adapter: NoydbStore
  let db: Noydb

  beforeEach(async () => {
    adapter = persistentMemory()
    db = await createNoydb({
      store: adapter,
      user: 'owner-01',
      encrypt: false,
      history: { enabled: true },
    })
  })

  describe('basic tracking', () => {
    it('first put creates no history (no previous version)', async () => {
      const comp = await db.openVault(COMP)
      const invoices = comp.collection<Invoice>('invoices')
      await invoices.put('inv-1', { amount: 1000, status: 'draft' })

      const history = await invoices.history('inv-1')
      expect(history).toHaveLength(0) // first version, nothing to track
    })

    it('second put creates one history entry with the first version', async () => {
      const comp = await db.openVault(COMP)
      const invoices = comp.collection<Invoice>('invoices')
      await invoices.put('inv-1', { amount: 1000, status: 'draft' })
      await invoices.put('inv-1', { amount: 2000, status: 'sent' })

      const history = await invoices.history('inv-1')
      expect(history).toHaveLength(1)
      expect(history[0]!.version).toBe(1)
      expect(history[0]!.record).toEqual({ amount: 1000, status: 'draft' })
    })

    it('multiple updates create full version chain', async () => {
      const comp = await db.openVault(COMP)
      const invoices = comp.collection<Invoice>('invoices')
      await invoices.put('inv-1', { amount: 1000, status: 'draft' })
      await invoices.put('inv-1', { amount: 2000, status: 'sent' })
      await invoices.put('inv-1', { amount: 2000, status: 'paid' })
      await invoices.put('inv-1', { amount: 2500, status: 'adjusted' })

      const history = await invoices.history('inv-1')
      expect(history).toHaveLength(3) // versions 1, 2, 3 (current is 4)
      // Newest first
      expect(history[0]!.version).toBe(3)
      expect(history[0]!.record.status).toBe('paid')
      expect(history[1]!.version).toBe(2)
      expect(history[1]!.record.status).toBe('sent')
      expect(history[2]!.version).toBe(1)
      expect(history[2]!.record.status).toBe('draft')
    })

    it('delete saves final version to history', async () => {
      const comp = await db.openVault(COMP)
      const invoices = comp.collection<Invoice>('invoices')
      await invoices.put('inv-1', { amount: 1000, status: 'draft' })
      await invoices.delete('inv-1')

      const history = await invoices.history('inv-1')
      expect(history).toHaveLength(1)
      expect(history[0]!.record).toEqual({ amount: 1000, status: 'draft' })
    })

    it('history entries include timestamps', async () => {
      const comp = await db.openVault(COMP)
      const invoices = comp.collection<Invoice>('invoices')
      await invoices.put('inv-1', { amount: 1000, status: 'v1' })
      await invoices.put('inv-1', { amount: 2000, status: 'v2' })

      const history = await invoices.history('inv-1')
      expect(history[0]!.timestamp).toBeDefined()
      expect(new Date(history[0]!.timestamp).getTime()).not.toBeNaN()
    })
  })

  describe('user attribution', () => {
    it('tracks which user made the change', async () => {
      const comp = await db.openVault(COMP)
      const invoices = comp.collection<Invoice>('invoices')
      await invoices.put('inv-1', { amount: 1000, status: 'draft' })
      await invoices.put('inv-1', { amount: 2000, status: 'updated' })

      const history = await invoices.history('inv-1')
      expect(history[0]!.userId).toBe('owner-01')
    })
  })

  describe('getVersion', () => {
    it('retrieves a specific past version', async () => {
      const comp = await db.openVault(COMP)
      const invoices = comp.collection<Invoice>('invoices')
      await invoices.put('inv-1', { amount: 1000, status: 'v1' })
      await invoices.put('inv-1', { amount: 2000, status: 'v2' })
      await invoices.put('inv-1', { amount: 3000, status: 'v3' })

      const v1 = await invoices.getVersion('inv-1', 1)
      expect(v1).toEqual({ amount: 1000, status: 'v1' })

      const v2 = await invoices.getVersion('inv-1', 2)
      expect(v2).toEqual({ amount: 2000, status: 'v2' })
    })

    it('returns null for non-existent version', async () => {
      const comp = await db.openVault(COMP)
      const invoices = comp.collection<Invoice>('invoices')
      await invoices.put('inv-1', { amount: 1000, status: 'v1' })

      const v99 = await invoices.getVersion('inv-1', 99)
      expect(v99).toBeNull()
    })
  })

  describe('revert', () => {
    it('restores a record to a past version (creates new version)', async () => {
      const comp = await db.openVault(COMP)
      const invoices = comp.collection<Invoice>('invoices')
      await invoices.put('inv-1', { amount: 1000, status: 'original' })
      await invoices.put('inv-1', { amount: 2000, status: 'changed' })
      await invoices.put('inv-1', { amount: 3000, status: 'wrong' })

      // Revert to version 1
      await invoices.revert('inv-1', 1)

      // Current record should have original content at new version
      const current = await invoices.get('inv-1')
      expect(current).toEqual({ amount: 1000, status: 'original' })

      // History should have versions 1, 2, 3 (revert created v4 = original content)
      const history = await invoices.history('inv-1')
      expect(history).toHaveLength(3)
    })

    it('throws for non-existent version', async () => {
      const comp = await db.openVault(COMP)
      const invoices = comp.collection<Invoice>('invoices')
      await invoices.put('inv-1', { amount: 1000, status: 'v1' })

      await expect(invoices.revert('inv-1', 99)).rejects.toThrow('Version 99 not found')
    })
  })

  describe('history filtering', () => {
    it('limit returns only N entries', async () => {
      const comp = await db.openVault(COMP)
      const invoices = comp.collection<Invoice>('invoices')
      for (let i = 1; i <= 10; i++) {
        await invoices.put('inv-1', { amount: i * 1000, status: `v${i}` })
      }

      const last3 = await invoices.history('inv-1', { limit: 3 })
      expect(last3).toHaveLength(3)
      expect(last3[0]!.version).toBe(9) // newest first
      expect(last3[2]!.version).toBe(7)
    })

    it('from/to filters by timestamp', async () => {
      const comp = await db.openVault(COMP)
      const invoices = comp.collection<Invoice>('invoices')

      // Create versions (timestamps are automatic)
      await invoices.put('inv-1', { amount: 1000, status: 'old' })
      await invoices.put('inv-1', { amount: 2000, status: 'mid' })
      await invoices.put('inv-1', { amount: 3000, status: 'new' })

      // Get all history (should be 2 entries: versions 1 and 2)
      const all = await invoices.history('inv-1')
      expect(all).toHaveLength(2)

      // Filter to future — should return nothing
      const future = await invoices.history('inv-1', { from: '2099-01-01' })
      expect(future).toHaveLength(0)

      // Filter to past — should return all
      const past = await invoices.history('inv-1', { to: '2099-12-31' })
      expect(past).toHaveLength(2)
    })
  })

  describe('pruning', () => {
    it('keepVersions prunes oldest entries', async () => {
      const comp = await db.openVault(COMP)
      const invoices = comp.collection<Invoice>('invoices')
      for (let i = 1; i <= 6; i++) {
        await invoices.put('inv-1', { amount: i * 1000, status: `v${i}` })
      }

      // Should have 5 history entries (versions 1-5, current is 6)
      expect(await invoices.history('inv-1')).toHaveLength(5)

      // Keep only 2 most recent
      const pruned = await invoices.pruneRecordHistory('inv-1', { keepVersions: 2 })
      expect(pruned).toBe(3)

      const remaining = await invoices.history('inv-1')
      expect(remaining).toHaveLength(2)
      expect(remaining[0]!.version).toBe(5) // newest
      expect(remaining[1]!.version).toBe(4)
    })

    it('clearHistory removes all history for a record', async () => {
      const comp = await db.openVault(COMP)
      const invoices = comp.collection<Invoice>('invoices')
      await invoices.put('inv-1', { amount: 1000, status: 'v1' })
      await invoices.put('inv-1', { amount: 2000, status: 'v2' })
      await invoices.put('inv-1', { amount: 3000, status: 'v3' })

      const cleared = await invoices.clearHistory('inv-1')
      expect(cleared).toBe(2) // versions 1 and 2

      const history = await invoices.history('inv-1')
      expect(history).toHaveLength(0)

      // Current record is unaffected
      const current = await invoices.get('inv-1')
      expect(current).toEqual({ amount: 3000, status: 'v3' })
    })

    it('auto-prune when maxVersions is configured', async () => {
      const dbCapped = await createNoydb({
        store: persistentMemory(),
        user: 'owner',
        encrypt: false,
        history: { enabled: true, maxVersions: 3 },
      })

      const comp = await dbCapped.openVault(COMP)
      const invoices = comp.collection<Invoice>('invoices')
      for (let i = 1; i <= 8; i++) {
        await invoices.put('inv-1', { amount: i * 1000, status: `v${i}` })
      }

      // Despite 8 updates, only 3 history entries should remain
      const history = await invoices.history('inv-1')
      expect(history.length).toBeLessThanOrEqual(3)
    })
  })

  describe('history disabled', () => {
    it('no history is saved when disabled', async () => {
      const dbNoHistory = await createNoydb({
        store: persistentMemory(),
        user: 'owner',
        encrypt: false,
        history: { enabled: false },
      })

      const comp = await dbNoHistory.openVault(COMP)
      const invoices = comp.collection<Invoice>('invoices')
      await invoices.put('inv-1', { amount: 1000, status: 'v1' })
      await invoices.put('inv-1', { amount: 2000, status: 'v2' })
      await invoices.put('inv-1', { amount: 3000, status: 'v3' })

      const history = await invoices.history('inv-1')
      expect(history).toHaveLength(0)
    })
  })

  describe('encrypted mode', () => {
    it('history works with encrypted records', async () => {
      const encDb = await createNoydb({
        store: persistentMemory(),
        user: 'owner-enc',
        secret: 'test-passphrase',
        history: { enabled: true },
      })

      const comp = await encDb.openVault(COMP)
      const invoices = comp.collection<Invoice>('invoices')
      await invoices.put('inv-1', { amount: 5000, status: 'draft' })
      await invoices.put('inv-1', { amount: 7500, status: 'sent' })

      const history = await invoices.history('inv-1')
      expect(history).toHaveLength(1)
      expect(history[0]!.record).toEqual({ amount: 5000, status: 'draft' })

      const v1 = await invoices.getVersion('inv-1', 1)
      expect(v1).toEqual({ amount: 5000, status: 'draft' })
    })
  })

  describe('diff', () => {
    it('shows changed fields between two versions', async () => {
      const comp = await db.openVault(COMP)
      const invoices = comp.collection<Invoice>('invoices')
      await invoices.put('inv-1', { amount: 1000, status: 'draft' })
      await invoices.put('inv-1', { amount: 2000, status: 'draft' }) // amount changed
      await invoices.put('inv-1', { amount: 2000, status: 'sent' })  // status changed

      const changes = await invoices.diff('inv-1', 1, 2)
      expect(changes).toHaveLength(1)
      expect(changes[0]).toEqual({ path: 'amount', type: 'changed', from: 1000, to: 2000 })
    })

    it('shows multiple field changes', async () => {
      const comp = await db.openVault(COMP)
      const invoices = comp.collection<Invoice>('invoices')
      await invoices.put('inv-1', { amount: 1000, status: 'draft' })
      await invoices.put('inv-1', { amount: 5000, status: 'paid' })

      const changes = await invoices.diff('inv-1', 1, 2)
      expect(changes).toHaveLength(2)
      expect(changes.find(c => c.path === 'amount')).toEqual({
        path: 'amount', type: 'changed', from: 1000, to: 5000,
      })
      expect(changes.find(c => c.path === 'status')).toEqual({
        path: 'status', type: 'changed', from: 'draft', to: 'paid',
      })
    })

    it('compares against current version when versionB omitted', async () => {
      const comp = await db.openVault(COMP)
      const invoices = comp.collection<Invoice>('invoices')
      await invoices.put('inv-1', { amount: 1000, status: 'draft' })
      await invoices.put('inv-1', { amount: 9999, status: 'final' })

      // Compare v1 against current (v2)
      const changes = await invoices.diff('inv-1', 1)
      expect(changes).toHaveLength(2)
      expect(changes.find(c => c.path === 'amount')?.to).toBe(9999)
    })

    it('returns empty array for identical versions', async () => {
      const comp = await db.openVault(COMP)
      const invoices = comp.collection<Invoice>('invoices')
      await invoices.put('inv-1', { amount: 1000, status: 'same' })
      await invoices.put('inv-1', { amount: 1000, status: 'same' }) // same content

      const changes = await invoices.diff('inv-1', 1, 2)
      expect(changes).toHaveLength(0)
    })

    it('detects added and removed fields', async () => {
      const comp = await db.openVault(COMP)
      const items = comp.collection<Record<string, unknown>>('items')
      await items.put('item-1', { name: 'old', color: 'red' })
      await items.put('item-1', { name: 'new', size: 'large' })

      const changes = await items.diff('item-1', 1, 2)
      expect(changes.find(c => c.path === 'name')).toEqual({
        path: 'name', type: 'changed', from: 'old', to: 'new',
      })
      expect(changes.find(c => c.path === 'color')).toEqual({
        path: 'color', type: 'removed', from: 'red',
      })
      expect(changes.find(c => c.path === 'size')).toEqual({
        path: 'size', type: 'added', to: 'large',
      })
    })

    it('handles nested object diffs', async () => {
      const comp = await db.openVault(COMP)
      const items = comp.collection<Record<string, unknown>>('items')
      await items.put('item-1', { meta: { city: 'Bangkok', zip: '10100' } })
      await items.put('item-1', { meta: { city: 'Chiang Mai', zip: '10100' } })

      const changes = await items.diff('item-1', 1, 2)
      expect(changes).toHaveLength(1)
      expect(changes[0]).toEqual({
        path: 'meta.city', type: 'changed', from: 'Bangkok', to: 'Chiang Mai',
      })
    })
  })

  describe('multi-record isolation', () => {
    it('history is per-record, not mixed between records', async () => {
      const comp = await db.openVault(COMP)
      const invoices = comp.collection<Invoice>('invoices')
      await invoices.put('inv-A', { amount: 100, status: 'a1' })
      await invoices.put('inv-A', { amount: 200, status: 'a2' })
      await invoices.put('inv-B', { amount: 300, status: 'b1' })
      await invoices.put('inv-B', { amount: 400, status: 'b2' })

      const histA = await invoices.history('inv-A')
      expect(histA).toHaveLength(1)
      expect(histA[0]!.record.status).toBe('a1')

      const histB = await invoices.history('inv-B')
      expect(histB).toHaveLength(1)
      expect(histB[0]!.record.status).toBe('b1')
    })
  })
})
