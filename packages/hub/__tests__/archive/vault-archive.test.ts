/**
 * #307 — vault.archive() / restore() / listArchived() integration.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, withArchive, withGuard, RecordLockedError } from '../../src/index.js'
import { withTransactions } from '../../src/with-commit/tx/index.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../../src/index.js'
import { ConflictError } from '../../src/index.js'

function memory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const gc = (v: string, c: string): Map<string, EncryptedEnvelope> => {
    let vm = store.get(v); if (!vm) { vm = new Map(); store.set(v, vm) }
    let cm = vm.get(c); if (!cm) { cm = new Map(); vm.set(c, cm) }
    return cm
  }
  return {
    name: 'memory',
    async get(v, c, id) { return store.get(v)?.get(c)?.get(id) ?? null },
    async put(v, c, id, env, ev) {
      const cm = gc(v, c); const ex = cm.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      cm.set(id, env)
    },
    async delete(v, c, id) { store.get(v)?.get(c)?.delete(id) },
    async list(v, c) { return [...(store.get(v)?.get(c)?.keys() ?? [])] },
    async loadAll(v) {
      const vm = store.get(v); const snap: VaultSnapshot = {}
      if (vm) for (const [n, cm] of vm) {
        const r: Record<string, EncryptedEnvelope> = {}
        for (const [id, e] of cm) r[id] = e
        snap[n] = r
      }
      return snap
    },
    async saveAll(v, data) {
      for (const [n, recs] of Object.entries(data)) {
        const cm = gc(v, n)
        for (const [id, e] of Object.entries(recs)) cm.set(id, e)
      }
    },
  }
}

interface Invoice extends Record<string, unknown> { id: string; year: number; status?: string; hold?: boolean }

describe('#307 record cold-storage archival', () => {
  it('archives eligible records to the cold store and removes them from primary; restore brings them back', async () => {
    const cold = memory()
    const db = await createNoydb({ store: memory(), user: 'owner', secret: 'pw', archiveStrategy: withArchive({ store: cold }) })
    const vault = await db.openVault('books')
    const inv = vault.collection<Invoice>('invoices', { archive: { archiveWhen: (r) => r.year <= 2022 } })

    await inv.put('a', { id: 'a', year: 2020 })
    await inv.put('b', { id: 'b', year: 2025 })

    const res = await vault.archive()
    expect(res.archived).toBe(1)

    // a is gone from primary (cold), b remains
    expect(await inv.get('a')).toBeNull()
    expect((await inv.get('b'))?.year).toBe(2025)
    expect(await vault.listArchived()).toEqual([{ collection: 'invoices', id: 'a' }])

    // restore brings a back, decryptable, and clears the cold copy
    expect(await vault.restore('invoices', 'a')).toBe(true)
    expect((await inv.get('a'))?.year).toBe(2020)
    expect(await vault.listArchived()).toEqual([])
  })

  it('legalHold blocks archival', async () => {
    const cold = memory()
    const db = await createNoydb({ store: memory(), user: 'owner', secret: 'pw', archiveStrategy: withArchive({ store: cold }) })
    const vault = await db.openVault('books')
    const inv = vault.collection<Invoice>('invoices', {
      archive: { archiveWhen: () => true, legalHold: (r) => r.hold === true },
    })
    await inv.put('a', { id: 'a', year: 2020, hold: true })
    await inv.put('b', { id: 'b', year: 2020 })

    const res = await vault.archive()
    expect(res.archived).toBe(1) // only b
    expect(res.held).toBe(1)
    expect(await inv.get('a')).not.toBeNull() // a retained under hold
    expect(await inv.get('b')).toBeNull()
  })

  it('archives a guard-locked record — relocation bypasses guards', async () => {
    const cold = memory()
    const db = await createNoydb({
      store: memory(), user: 'owner', secret: 'pw',
      archiveStrategy: withArchive({ store: cold }),
      // a guard that makes issued invoices un-deletable (WORM)
      guardStrategies: [withGuard<Invoice>({
        collection: 'invoices',
        onDelete: (existing) => { if (existing.status === 'issued') throw new RecordLockedError('invoices', existing.id, 'issued') },
      })],
      transactionsStrategy: withTransactions(),
    })
    const vault = await db.openVault('books')
    const inv = vault.collection<Invoice>('invoices', { archive: { archiveWhen: (r) => r.year <= 2022 } })

    await inv.put('a', { id: 'a', year: 2020, status: 'issued' })
    // a normal delete is blocked by the immutable guard:
    await expect(inv.delete('a')).rejects.toThrow()
    // but archival relocates it anyway (low-level, guard-bypassing):
    const res = await vault.archive()
    expect(res.archived).toBe(1)
    expect(await inv.get('a')).toBeNull()
    expect(await vault.listArchived()).toEqual([{ collection: 'invoices', id: 'a' }])
  })

  it('throws if no archiveStrategy is configured', async () => {
    const db = await createNoydb({ store: memory(), user: 'owner', secret: 'pw' })
    const vault = await db.openVault('books')
    vault.collection<Invoice>('invoices', { archive: { archiveWhen: () => true } })
    await expect(vault.archive()).rejects.toThrow(/archiveStrategy/)
  })
})
