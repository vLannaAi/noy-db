/**
 * Tests for `Collection.putMany / getMany / deleteMany` (v0.16 #242).
 *
 * Covers:
 *   - putMany writes every record and emits one change event per record
 *   - getMany preserves input order and returns null for missing ids
 *   - deleteMany removes every record idempotently
 *   - Mixed success/failure with per-item detail in the result
 *   - deleteMany of a non-existent id is NOT a failure (idempotent)
 *   - history is saved per-record on each putMany overwrite
 */
import { describe, it, expect, beforeEach } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot, ChangeEvent } from '../src/types.js'
import { ConflictError, createNoydb } from '../src/index.js'
import type { Noydb } from '../src/index.js'

function memoryStore(): NoydbStore {
  const data = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const getColl = (v: string, c: string) => {
    let vm = data.get(v); if (!vm) { vm = new Map(); data.set(v, vm) }
    let cm = vm.get(c); if (!cm) { cm = new Map(); vm.set(c, cm) }
    return cm
  }
  return {
    name: 'memory',
    async get(v, c, id) { return data.get(v)?.get(c)?.get(id) ?? null },
    async put(v, c, id, env, ev) {
      const coll = getColl(v, c); const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(v, c, id) { data.get(v)?.get(c)?.delete(id) },
    async list(v, c) { return [...(data.get(v)?.get(c)?.keys() ?? [])] },
    async loadAll(v) {
      const vm = data.get(v); const snap: VaultSnapshot = {}
      if (vm) for (const [cn, cm] of vm) {
        if (cn.startsWith('_')) continue
        const r: Record<string, EncryptedEnvelope> = {}
        for (const [id, e] of cm) r[id] = e
        snap[cn] = r
      }
      return snap
    },
    async saveAll() { /* n/a */ },
  }
}

interface Invoice { amount: number; status: string }

describe('Collection.putMany / getMany / deleteMany', () => {
  let db: Noydb

  beforeEach(async () => {
    db = await createNoydb({
      store: memoryStore(),
      user: 'owner',
      encrypt: false,
    })
  })

  describe('putMany', () => {
    it('writes every record and returns ok:true with success ids', async () => {
      const vault = await db.openVault('acme')
      const invoices = vault.collection<Invoice>('invoices')

      const result = await invoices.putMany([
        ['inv-1', { amount: 100, status: 'draft' }],
        ['inv-2', { amount: 200, status: 'draft' }],
        ['inv-3', { amount: 300, status: 'draft' }],
      ])
      expect(result.ok).toBe(true)
      expect(result.success.sort()).toEqual(['inv-1', 'inv-2', 'inv-3'])
      expect(result.failures).toEqual([])

      expect(await invoices.get('inv-1')).toEqual({ amount: 100, status: 'draft' })
      expect(await invoices.get('inv-2')).toEqual({ amount: 200, status: 'draft' })
      expect(await invoices.get('inv-3')).toEqual({ amount: 300, status: 'draft' })
    })

    it('emits one change event per record', async () => {
      const vault = await db.openVault('acme')
      const invoices = vault.collection<Invoice>('invoices')
      const events: ChangeEvent[] = []
      db.on('change', (e) => events.push(e))

      await invoices.putMany([
        ['inv-1', { amount: 100, status: 'draft' }],
        ['inv-2', { amount: 200, status: 'draft' }],
        ['inv-3', { amount: 300, status: 'draft' }],
      ])

      expect(events).toHaveLength(3)
      expect(events.every(e => e.action === 'put' && e.collection === 'invoices')).toBe(true)
      expect(events.map(e => e.id).sort()).toEqual(['inv-1', 'inv-2', 'inv-3'])
    })
  })

  describe('getMany', () => {
    it('returns a Map in input order with null for missing ids', async () => {
      const vault = await db.openVault('acme')
      const invoices = vault.collection<Invoice>('invoices')
      await invoices.put('inv-1', { amount: 100, status: 'draft' })
      await invoices.put('inv-3', { amount: 300, status: 'draft' })

      const result = await invoices.getMany(['inv-1', 'inv-2', 'inv-3', 'inv-4'])
      expect([...result.keys()]).toEqual(['inv-1', 'inv-2', 'inv-3', 'inv-4'])
      expect(result.get('inv-1')).toEqual({ amount: 100, status: 'draft' })
      expect(result.get('inv-2')).toBeNull()
      expect(result.get('inv-3')).toEqual({ amount: 300, status: 'draft' })
      expect(result.get('inv-4')).toBeNull()
    })

    it('handles an empty id list', async () => {
      const vault = await db.openVault('acme')
      const result = await vault.collection<Invoice>('invoices').getMany([])
      expect(result.size).toBe(0)
    })
  })

  describe('deleteMany', () => {
    it('removes every record and returns ok:true', async () => {
      const vault = await db.openVault('acme')
      const invoices = vault.collection<Invoice>('invoices')
      await invoices.putMany([
        ['inv-1', { amount: 100, status: 'draft' }],
        ['inv-2', { amount: 200, status: 'draft' }],
      ])

      const result = await invoices.deleteMany(['inv-1', 'inv-2'])
      expect(result.ok).toBe(true)
      expect(result.success.sort()).toEqual(['inv-1', 'inv-2'])
      expect(await invoices.get('inv-1')).toBeNull()
      expect(await invoices.get('inv-2')).toBeNull()
    })

    it('is idempotent — deleting a non-existent id is not a failure', async () => {
      const vault = await db.openVault('acme')
      const invoices = vault.collection<Invoice>('invoices')
      await invoices.put('inv-1', { amount: 100, status: 'draft' })

      const result = await invoices.deleteMany(['inv-1', 'never-existed', 'also-never'])
      expect(result.ok).toBe(true)
      expect(result.success.sort()).toEqual(['also-never', 'inv-1', 'never-existed'])
      expect(result.failures).toEqual([])
    })
  })

  describe('putMany atomic mode (#240 wire-up)', () => {
    it('commits every record on success', async () => {
      const vault = await db.openVault('acme')
      const invoices = vault.collection<Invoice>('invoices')
      const result = await invoices.putMany(
        [
          ['inv-1', { amount: 100, status: 'draft' }],
          ['inv-2', { amount: 200, status: 'draft' }],
        ],
        { atomic: true },
      )
      expect(result.ok).toBe(true)
      expect(result.success.sort()).toEqual(['inv-1', 'inv-2'])
      expect(await invoices.get('inv-1')).toEqual({ amount: 100, status: 'draft' })
      expect(await invoices.get('inv-2')).toEqual({ amount: 200, status: 'draft' })
    })

    it('throws ConflictError on expectedVersion mismatch and writes nothing', async () => {
      const vault = await db.openVault('acme')
      const invoices = vault.collection<Invoice>('invoices')
      await invoices.put('inv-1', { amount: 100, status: 'draft' })

      await expect(
        invoices.putMany(
          [
            ['inv-1', { amount: 999, status: 'paid' }, { expectedVersion: 42 }],
            ['inv-2', { amount: 200, status: 'draft' }],
          ],
          { atomic: true },
        ),
      ).rejects.toBeInstanceOf(ConflictError)

      expect(await invoices.get('inv-1')).toEqual({ amount: 100, status: 'draft' })
      expect(await invoices.get('inv-2')).toBeNull()
    })
  })

  describe('history interaction', () => {
    it('putMany overwrites trigger per-record history snapshots', async () => {
      const vault = await db.openVault('acme')
      const invoices = vault.collection<Invoice>('invoices')

      await invoices.putMany([
        ['inv-1', { amount: 100, status: 'draft' }],
        ['inv-2', { amount: 200, status: 'draft' }],
      ])
      await invoices.putMany([
        ['inv-1', { amount: 100, status: 'sent' }],
        ['inv-2', { amount: 200, status: 'sent' }],
      ])

      const h1 = await invoices.history('inv-1')
      const h2 = await invoices.history('inv-2')
      // Each record has one history entry (the v1 snapshot captured at v2 overwrite).
      expect(h1).toHaveLength(1)
      expect(h2).toHaveLength(1)
      expect(h1[0]!.record.status).toBe('draft')
      expect(h2[0]!.record.status).toBe('draft')
    })
  })
})
