/**
 * Tests for `vault.frame()` — v0.16 #217 shadow vaults.
 *
 * Covers:
 *   - get / list / query reads succeed through the frame
 *   - put / delete / update / putMany / deleteMany throw ReadOnlyFrameError
 *   - History reads (`history`, `getVersion`) still work — history is
 *     inherently read-only
 *   - Frame survives live updates — reads reflect the underlying
 *     vault's current state at read time
 *   - Error message references the attempted operation for diagnostics
 */
import { describe, it, expect, beforeEach } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/types.js'
import { ConflictError, ReadOnlyFrameError, createNoydb } from '../src/index.js'
import { withShadow } from '../src/shadow/index.js'
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

describe('vault.frame() — read-only shadow view', () => {
  let db: Noydb

  beforeEach(async () => {
    db = await createNoydb({
      store: memoryStore(),
      user: 'owner',
      encrypt: false,
      shadowStrategy: withShadow(),
    })
  })

  describe('reads', () => {
    it('get() returns the current record', async () => {
      const vault = await db.openVault('acme')
      await vault.collection<Invoice>('invoices').put('inv-1', { amount: 100, status: 'sent' })

      const frame = vault.frame()
      const invoice = await frame.collection<Invoice>('invoices').get('inv-1')
      expect(invoice).toEqual({ amount: 100, status: 'sent' })
    })

    it('list() returns every live record', async () => {
      const vault = await db.openVault('acme')
      const invoices = vault.collection<Invoice>('invoices')
      await invoices.put('inv-1', { amount: 100, status: 'draft' })
      await invoices.put('inv-2', { amount: 200, status: 'sent' })

      const frame = vault.frame()
      const all = await frame.collection<Invoice>('invoices').list()
      expect(all).toHaveLength(2)
    })

    it('query() returns the chainable builder', async () => {
      const vault = await db.openVault('acme')
      const invoices = vault.collection<Invoice>('invoices')
      await invoices.put('inv-1', { amount: 100, status: 'draft' })
      await invoices.put('inv-2', { amount: 200, status: 'sent' })
      await invoices.put('inv-3', { amount: 300, status: 'sent' })

      const frame = vault.frame()
      const sent = await frame.collection<Invoice>('invoices')
        .query()
        .where('status', '==', 'sent')
        .toArray()
      expect(sent).toHaveLength(2)
    })

    it('reflects live updates — frame is a view, not a snapshot', async () => {
      const vault = await db.openVault('acme')
      const invoices = vault.collection<Invoice>('invoices')
      const frame = vault.frame()

      expect(await frame.collection<Invoice>('invoices').list()).toHaveLength(0)
      await invoices.put('inv-1', { amount: 100, status: 'draft' })
      expect(await frame.collection<Invoice>('invoices').list()).toHaveLength(1)
    })

    it('collections() exposes the live vault\'s collection names', async () => {
      const vault = await db.openVault('acme')
      await vault.collection<Invoice>('invoices').put('inv-1', { amount: 1, status: 'x' })
      await vault.collection<Invoice>('receipts').put('rc-1', { amount: 1, status: 'x' })

      const frame = vault.frame()
      const names = (await frame.collections()).sort()
      expect(names).toEqual(['invoices', 'receipts'])
    })

    it('history reads still work (history is inherently read-only)', async () => {
      const vault = await db.openVault('acme', { historyConfig: { enabled: true } })
      const invoices = vault.collection<Invoice>('invoices')
      await invoices.put('inv-1', { amount: 100, status: 'draft' })
      await invoices.put('inv-1', { amount: 100, status: 'sent' })

      const frame = vault.frame()
      const frameCol = frame.collection<Invoice>('invoices')
      const history = await frameCol.history('inv-1')
      expect(history.length).toBeGreaterThan(0)

      const v1 = await frameCol.getVersion('inv-1', 1)
      expect(v1).toEqual({ amount: 100, status: 'draft' })
    })
  })

  describe('writes throw ReadOnlyFrameError', () => {
    it('put() throws', async () => {
      const vault = await db.openVault('acme')
      const frame = vault.frame()
      await expect(
        frame.collection<Invoice>('invoices').put('inv-1', { amount: 1, status: 'x' }),
      ).rejects.toBeInstanceOf(ReadOnlyFrameError)
    })

    it('delete() throws', async () => {
      const vault = await db.openVault('acme')
      await vault.collection<Invoice>('invoices').put('inv-1', { amount: 1, status: 'x' })

      const frame = vault.frame()
      await expect(
        frame.collection<Invoice>('invoices').delete('inv-1'),
      ).rejects.toBeInstanceOf(ReadOnlyFrameError)
    })

    it('putMany() throws', async () => {
      const vault = await db.openVault('acme')
      const frame = vault.frame()
      await expect(
        frame.collection<Invoice>('invoices').putMany([
          ['inv-1', { amount: 1, status: 'x' }],
          ['inv-2', { amount: 2, status: 'x' }],
        ]),
      ).rejects.toBeInstanceOf(ReadOnlyFrameError)
    })

    it('deleteMany() throws', async () => {
      const vault = await db.openVault('acme')
      const frame = vault.frame()
      await expect(
        frame.collection<Invoice>('invoices').deleteMany(['inv-1', 'inv-2']),
      ).rejects.toBeInstanceOf(ReadOnlyFrameError)
    })

    it('revert() throws', async () => {
      const vault = await db.openVault('acme', { historyConfig: { enabled: true } })
      const invoices = vault.collection<Invoice>('invoices')
      await invoices.put('inv-1', { amount: 1, status: 'x' })
      await invoices.put('inv-1', { amount: 2, status: 'x' })

      const frame = vault.frame()
      await expect(
        frame.collection<Invoice>('invoices').revert('inv-1', 1),
      ).rejects.toBeInstanceOf(ReadOnlyFrameError)
    })

    it('error message names the attempted operation', async () => {
      const vault = await db.openVault('acme')
      const frame = vault.frame()
      try {
        await frame.collection<Invoice>('invoices').put('x', { amount: 1, status: 'x' })
      } catch (err) {
        expect((err as Error).message).toContain('put()')
      }
    })
  })
})
