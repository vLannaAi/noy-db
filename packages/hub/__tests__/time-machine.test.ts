/**
 * Tests for `vault.at(timestamp)` — v0.16 #215 time-machine queries.
 *
 * Strategy: write three versions of a record separated by short
 * sleeps so each envelope gets a distinct `_ts`; then query at
 * timestamps between each write and verify the returned record
 * matches the expected version.
 *
 * Covers:
 *   - read at a time before any put → null
 *   - read between v1 and v2 → v1 content
 *   - read between v2 and v3 → v2 content
 *   - read after v3 → v3 content
 *   - read after delete → null (ledger cross-check)
 *   - list() excludes records deleted before target ts
 *   - writes on VaultInstant throw ReadOnlyAtInstantError
 *   - plaintext (encrypt: false) vault round-trips correctly
 */
import { describe, expect, it, beforeEach } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/types.js'
import { ConflictError, ReadOnlyAtInstantError, createNoydb } from '../src/index.js'
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
    async saveAll(v, data2) {
      for (const [cn, recs] of Object.entries(data2)) {
        const coll = getColl(v, cn)
        for (const [id, e] of Object.entries(recs)) coll.set(id, e)
      }
    },
  }
}

interface Invoice { amount: number; status: string }

async function tick(ms = 15): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

describe('vault.at(ts) — time-machine queries', () => {
  let db: Noydb

  beforeEach(async () => {
    db = await createNoydb({
      store: memoryStore(),
      user: 'owner',
      encrypt: false,
      history: { enabled: true },
    })
  })

  describe('get() — version resolution at a point in time', () => {
    it('returns null when queried before any put', async () => {
      const vault = await db.openVault('acme')
      const invoices = vault.collection<Invoice>('invoices')
      // Capture a timestamp before any write
      const beforeAll = new Date(Date.now() - 1000).toISOString()
      await invoices.put('inv-1', { amount: 100, status: 'draft' })

      const past = await vault.at(beforeAll).collection<Invoice>('invoices').get('inv-1')
      expect(past).toBeNull()
    })

    it('returns the v1 record for a timestamp between v1 and v2', async () => {
      const vault = await db.openVault('acme')
      const invoices = vault.collection<Invoice>('invoices')

      await invoices.put('inv-1', { amount: 100, status: 'draft' })
      await tick()
      const tBetween = new Date().toISOString()
      await tick()
      await invoices.put('inv-1', { amount: 100, status: 'sent' })

      const at = await vault.at(tBetween).collection<Invoice>('invoices').get('inv-1')
      expect(at).toEqual({ amount: 100, status: 'draft' })
    })

    it('walks through three versions and returns the right one at each midpoint', async () => {
      const vault = await db.openVault('acme')
      const invoices = vault.collection<Invoice>('invoices')

      await invoices.put('inv-1', { amount: 100, status: 'draft' })
      await tick()
      const t1 = new Date().toISOString()    // between v1 and v2
      await tick()

      await invoices.put('inv-1', { amount: 100, status: 'sent' })
      await tick()
      const t2 = new Date().toISOString()    // between v2 and v3
      await tick()

      await invoices.put('inv-1', { amount: 100, status: 'paid' })
      await tick()
      const t3 = new Date().toISOString()    // after v3

      expect(await vault.at(t1).collection<Invoice>('invoices').get('inv-1'))
        .toEqual({ amount: 100, status: 'draft' })
      expect(await vault.at(t2).collection<Invoice>('invoices').get('inv-1'))
        .toEqual({ amount: 100, status: 'sent' })
      expect(await vault.at(t3).collection<Invoice>('invoices').get('inv-1'))
        .toEqual({ amount: 100, status: 'paid' })
    })

    it('accepts a Date object as well as an ISO string', async () => {
      const vault = await db.openVault('acme')
      const invoices = vault.collection<Invoice>('invoices')
      await invoices.put('inv-1', { amount: 42, status: 'draft' })
      await tick()

      const now = new Date()
      const viaDate = await vault.at(now).collection<Invoice>('invoices').get('inv-1')
      const viaIso = await vault.at(now.toISOString()).collection<Invoice>('invoices').get('inv-1')
      expect(viaDate).toEqual(viaIso)
      expect(viaDate).toEqual({ amount: 42, status: 'draft' })
    })
  })

  describe('delete semantics', () => {
    it('returns null for a record deleted before the query timestamp', async () => {
      const vault = await db.openVault('acme')
      const invoices = vault.collection<Invoice>('invoices')

      await invoices.put('inv-1', { amount: 100, status: 'draft' })
      await tick()
      await invoices.delete('inv-1')
      await tick()
      const afterDelete = new Date().toISOString()

      const result = await vault.at(afterDelete).collection<Invoice>('invoices').get('inv-1')
      expect(result).toBeNull()
    })

    it('still returns the record when queried between put and delete', async () => {
      const vault = await db.openVault('acme')
      const invoices = vault.collection<Invoice>('invoices')

      await invoices.put('inv-1', { amount: 100, status: 'draft' })
      await tick()
      const betweenPutAndDelete = new Date().toISOString()
      await tick()
      await invoices.delete('inv-1')

      const result = await vault.at(betweenPutAndDelete).collection<Invoice>('invoices').get('inv-1')
      expect(result).toEqual({ amount: 100, status: 'draft' })
    })
  })

  describe('list() — IDs alive at a given instant', () => {
    it('returns only records that existed and were not deleted by the target time', async () => {
      const vault = await db.openVault('acme')
      const invoices = vault.collection<Invoice>('invoices')

      await invoices.put('a', { amount: 1, status: 'x' })
      await invoices.put('b', { amount: 2, status: 'x' })
      await tick()
      await invoices.delete('a')
      await tick()
      await invoices.put('c', { amount: 3, status: 'x' })

      const now = new Date().toISOString()
      const ids = await vault.at(now).collection<Invoice>('invoices').list()
      // a was deleted; b and c survived
      expect(ids.sort()).toEqual(['b', 'c'])
    })
  })

  describe('read-only contract', () => {
    it('put() throws ReadOnlyAtInstantError', async () => {
      const vault = await db.openVault('acme')
      const past = vault.at('2020-01-01T00:00:00Z').collection<Invoice>('invoices')
      await expect(past.put('inv-1', { amount: 1, status: 'x' })).rejects.toBeInstanceOf(ReadOnlyAtInstantError)
    })

    it('delete() throws ReadOnlyAtInstantError', async () => {
      const vault = await db.openVault('acme')
      const past = vault.at('2020-01-01T00:00:00Z').collection<Invoice>('invoices')
      await expect(past.delete('inv-1')).rejects.toBeInstanceOf(ReadOnlyAtInstantError)
    })

    it('error carries the timestamp for diagnostic display', async () => {
      const vault = await db.openVault('acme')
      const past = vault.at('2020-01-01T00:00:00Z').collection<Invoice>('invoices')
      try {
        await past.put('inv-1', { amount: 1, status: 'x' })
      } catch (err) {
        expect((err as Error).message).toContain('2020-01-01T00:00:00Z')
      }
    })
  })
})

describe('vault.at(ts) — encrypted mode round-trip', () => {
  it('decrypts historical snapshots with the collection DEK', async () => {
    const db = await createNoydb({
      store: memoryStore(),
      user: 'owner',
      secret: 'test-passphrase-12345678',
      history: { enabled: true },
    })
    const vault = await db.openVault('acme')
    const invoices = vault.collection<Invoice>('invoices')

    await invoices.put('inv-1', { amount: 100, status: 'draft' })
    await tick()
    const t1 = new Date().toISOString()
    await tick()
    await invoices.put('inv-1', { amount: 100, status: 'sent' })

    const past = await vault.at(t1).collection<Invoice>('invoices').get('inv-1')
    expect(past).toEqual({ amount: 100, status: 'draft' })
  })
})
