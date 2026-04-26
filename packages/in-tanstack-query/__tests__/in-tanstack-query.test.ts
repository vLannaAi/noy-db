import { describe, it, expect, beforeEach } from 'vitest'
import { QueryClient } from '@tanstack/query-core'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '@noy-db/hub'
import { ConflictError, createNoydb } from '@noy-db/hub'
import type { Noydb, Vault, Collection } from '@noy-db/hub'
import {
  collectionQueryKey,
  collectionListOptions,
  collectionGetOptions,
  collectionQueryOptions,
  collectionPutOptions,
  collectionDeleteOptions,
  bindInvalidation,
} from '../src/index.js'

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

interface Invoice { id: string; amt: number }

async function seed(): Promise<{ db: Noydb; vault: Vault; coll: Collection<Invoice> }> {
  const db = await createNoydb({ store: memory(), user: 'owner', secret: 'pw' })
  const vault = await db.openVault('acme')
  const coll = vault.collection<Invoice>('invoices')
  await coll.put('i1', { id: 'i1', amt: 100 })
  await coll.put('i2', { id: 'i2', amt: 250 })
  return { db, vault, coll }
}

describe('collectionQueryKey', () => {
  it('builds a canonical tuple', () => {
    expect(collectionQueryKey('acme', 'invoices')).toEqual(['noy-db', 'acme', 'invoices'])
    expect(collectionQueryKey('acme', 'invoices', 'list')).toEqual(['noy-db', 'acme', 'invoices', 'list'])
    expect(collectionQueryKey('acme', 'invoices', 'get', 'i1')).toEqual(['noy-db', 'acme', 'invoices', 'get', 'i1'])
  })
})

describe('collectionListOptions', () => {
  it('produces a queryFn that returns the record list', async () => {
    const { coll } = await seed()
    const { queryKey, queryFn } = collectionListOptions<Invoice>('acme', 'invoices', () => coll)
    expect(queryKey).toEqual(['noy-db', 'acme', 'invoices', 'list'])
    const records = await queryFn()
    expect(records.map(r => r.id).sort()).toEqual(['i1', 'i2'])
  })
})

describe('collectionGetOptions', () => {
  it('returns the record for a known id', async () => {
    const { coll } = await seed()
    const { queryFn } = collectionGetOptions<Invoice>('acme', 'invoices', 'i1', () => coll)
    const rec = await queryFn()
    expect(rec).toEqual({ id: 'i1', amt: 100 })
  })

  it('returns null for a missing id', async () => {
    const { coll } = await seed()
    const { queryFn } = collectionGetOptions<Invoice>('acme', 'invoices', 'nope', () => coll)
    expect(await queryFn()).toBeNull()
  })
})

describe('collectionQueryOptions', () => {
  it('runs a query-builder predicate', async () => {
    const { coll } = await seed()
    const { queryFn } = collectionQueryOptions<Invoice, Invoice[]>(
      'acme', 'invoices', () => coll,
      async q => q.where('amt', '>', 150).toArray(),
      'big-invoices',
    )
    const result = await queryFn()
    expect(result.map(r => r.id)).toEqual(['i2'])
  })
})

describe('collectionPutOptions / collectionDeleteOptions', () => {
  it('put + delete go through the collection', async () => {
    const { coll } = await seed()
    const put = collectionPutOptions<Invoice>(() => coll)
    await put.mutationFn({ id: 'i3', record: { id: 'i3', amt: 500 } })
    expect(await coll.get('i3')).toEqual({ id: 'i3', amt: 500 })

    const del = collectionDeleteOptions<Invoice>(() => coll)
    await del.mutationFn({ id: 'i3' })
    expect(await coll.get('i3')).toBeNull()
  })
})

describe('bindInvalidation', () => {
  it('invalidates the collection scope on every change event', async () => {
    const { coll } = await seed()
    const client = new QueryClient()
    const stop = bindInvalidation(client, 'acme', 'invoices', coll)

    let invalidateCount = 0
    const originalInvalidate = client.invalidateQueries.bind(client)
    client.invalidateQueries = ((...args) => {
      invalidateCount += 1
      return originalInvalidate(...args)
    }) as typeof client.invalidateQueries

    await coll.put('i3', { id: 'i3', amt: 999 })
    // Wait a microtask for the subscribe chain to flush.
    await new Promise(resolve => setImmediate(resolve))
    expect(invalidateCount).toBeGreaterThan(0)

    stop()
    const prev = invalidateCount
    await coll.put('i4', { id: 'i4', amt: 100 })
    await new Promise(resolve => setImmediate(resolve))
    expect(invalidateCount).toBe(prev) // stopped listener no-ops
  })
})
