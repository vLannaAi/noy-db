import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '@noy-db/hub'
import { ConflictError, createNoydb } from '@noy-db/hub'
import type { Collection } from '@noy-db/hub'
import { buildQueryFromTableState, resetTableState } from '../src/index.js'

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
        if (n.startsWith('_')) continue
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

interface Invoice { id: string; amt: number; status: string }

async function seed(): Promise<Collection<Invoice>> {
  const db = await createNoydb({ store: memory(), user: 'owner', secret: 'pw' })
  const vault = await db.openVault('acme')
  const coll = vault.collection<Invoice>('invoices')
  await coll.put('i1', { id: 'i1', amt: 100, status: 'draft' })
  await coll.put('i2', { id: 'i2', amt: 250, status: 'paid' })
  await coll.put('i3', { id: 'i3', amt: 500, status: 'paid' })
  await coll.put('i4', { id: 'i4', amt: 50,  status: 'draft' })
  return coll
}

describe('buildQueryFromTableState', () => {
  it('applies equality filter from column filters', async () => {
    const coll = await seed()
    const q = buildQueryFromTableState(coll.query(), {
      columnFilters: [{ id: 'status', value: 'paid' }],
    })
    const rows = await q.toArray()
    expect(rows.map(r => r.id).sort()).toEqual(['i2', 'i3'])
  })

  it('applies sorting descending', async () => {
    const coll = await seed()
    const q = buildQueryFromTableState(coll.query(), {
      sorting: [{ id: 'amt', desc: true }],
    })
    const rows = await q.toArray()
    expect(rows.map(r => r.amt)).toEqual([500, 250, 100, 50])
  })

  it('applies pagination via offset + limit', async () => {
    const coll = await seed()
    const q = buildQueryFromTableState(coll.query(), {
      sorting: [{ id: 'amt', desc: false }],
      pagination: { pageIndex: 1, pageSize: 2 },
    })
    const rows = await q.toArray()
    expect(rows.map(r => r.amt)).toEqual([250, 500])
  })

  it('stacks filter + sort + pagination', async () => {
    const coll = await seed()
    const q = buildQueryFromTableState(coll.query(), {
      columnFilters: [{ id: 'status', value: 'paid' }],
      sorting: [{ id: 'amt', desc: true }],
      pagination: { pageIndex: 0, pageSize: 1 },
    })
    const rows = await q.toArray()
    expect(rows).toEqual([{ id: 'i3', amt: 500, status: 'paid' }])
  })

  it('skips filters with empty values', async () => {
    const coll = await seed()
    const q = buildQueryFromTableState(coll.query(), {
      columnFilters: [{ id: 'status', value: '' }, { id: 'amt', value: null }],
    })
    expect((await q.toArray()).length).toBe(4)
  })

  it('array filter value becomes an `in` clause', async () => {
    const coll = await seed()
    const q = buildQueryFromTableState(coll.query(), {
      columnFilters: [{ id: 'id', value: ['i1', 'i3'] }],
    })
    expect((await q.toArray()).map(r => r.id).sort()).toEqual(['i1', 'i3'])
  })
})

describe('resetTableState', () => {
  it('produces an empty, first-page state', () => {
    const s = resetTableState(10)
    expect(s.sorting).toEqual([])
    expect(s.columnFilters).toEqual([])
    expect(s.pagination).toEqual({ pageIndex: 0, pageSize: 10 })
  })
})
