/**
 * Tests for `vault.compact()` + `blobFields` retention policy (v0.21 #263).
 */
import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/index.js'
import { ConflictError, createNoydb } from '../src/index.js'
import { withBlobs } from '../src/blobs/index.js'
import type { Noydb, Vault } from '../src/index.js'
import { BLOB_EVICTION_AUDIT_COLLECTION } from '../src/blobs/blob-compaction.js'

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

interface InvoiceScan { id: string; status: string }

async function setup(): Promise<{ db: Noydb; vault: Vault }> {
  const db = await createNoydb({ store: memory(), user: 'owner', secret: 'pw' , blobStrategy: withBlobs() })
  const vault = await db.openVault('acme')
  return { db, vault }
}

describe('vault.compact — predicate-based eviction', () => {
  it('evicts slots when evictWhen returns true', async () => {
    const { vault } = await setup()
    const scans = vault.collection<InvoiceScan>('invoiceScans', {
      blobFields: {
        image: {
          evictWhen: (rec) => rec.status === 'confirmed',
        },
      },
    })
    await scans.put('s1', { id: 's1', status: 'confirmed' })
    await scans.put('s2', { id: 's2', status: 'draft' })
    await scans.blob('s1').put('image', new TextEncoder().encode('x'))
    await scans.blob('s2').put('image', new TextEncoder().encode('y'))

    const result = await vault.compact()
    expect(result.evicted).toBe(1)
    expect(result.records).toBe(2)
    expect(result.collections).toBe(1)
    expect(result.byCollection.invoiceScans).toEqual({ records: 2, evicted: 1 })

    // s1 slot gone, s2 intact
    expect(await scans.blob('s1').list()).toHaveLength(0)
    expect(await scans.blob('s2').list()).toHaveLength(1)
  })

  it('leaves records without matching blobFields alone', async () => {
    const { vault } = await setup()
    const scans = vault.collection<InvoiceScan>('invoiceScans', {
      blobFields: { image: { evictWhen: () => true } },
    })
    vault.collection<{ id: string }>('untouched')
    await scans.put('s1', { id: 's1', status: 'x' })
    await scans.blob('s1').put('image', new TextEncoder().encode('b'))

    const result = await vault.compact()
    expect(result.collections).toBe(1)
    expect(result.evicted).toBe(1)
  })
})

describe('vault.compact — TTL-based eviction', () => {
  it('evicts slots older than retainDays', async () => {
    const { vault } = await setup()
    const scans = vault.collection<InvoiceScan>('invoiceScans', {
      blobFields: { image: { retainDays: 7 } },
    })
    await scans.put('s1', { id: 's1', status: 'any' })
    await scans.blob('s1').put('image', new TextEncoder().encode('x'))

    // Now + 8 days later → should evict
    const future = new Date(Date.now() + 8 * 86_400_000)
    const result = await vault.compact({ now: future })
    expect(result.evicted).toBe(1)
    expect(await scans.blob('s1').list()).toHaveLength(0)
  })

  it('leaves slots alone inside the retention window', async () => {
    const { vault } = await setup()
    const scans = vault.collection<InvoiceScan>('invoiceScans', {
      blobFields: { image: { retainDays: 30 } },
    })
    await scans.put('s1', { id: 's1', status: 'any' })
    await scans.blob('s1').put('image', new TextEncoder().encode('x'))

    const future = new Date(Date.now() + 20 * 86_400_000)
    const result = await vault.compact({ now: future })
    expect(result.evicted).toBe(0)
    expect(await scans.blob('s1').list()).toHaveLength(1)
  })
})

describe('vault.compact — combined + audit', () => {
  it('writes one audit entry per eviction', async () => {
    const { db, vault } = await setup()
    const scans = vault.collection<InvoiceScan>('invoiceScans', {
      blobFields: { image: { evictWhen: (rec) => rec.status === 'confirmed' } },
    })
    await scans.put('s1', { id: 's1', status: 'confirmed' })
    await scans.put('s2', { id: 's2', status: 'confirmed' })
    await scans.blob('s1').put('image', new TextEncoder().encode('a'))
    await scans.blob('s2').put('image', new TextEncoder().encode('b'))

    const result = await vault.compact()
    expect(result.auditEntries).toBe(2)

    const store = (db as unknown as { options: { store: NoydbStore } }).options.store
    const ids = await store.list('acme', BLOB_EVICTION_AUDIT_COLLECTION)
    expect(ids).toHaveLength(2)
  })

  it('dryRun previews without evicting or writing audit', async () => {
    const { db, vault } = await setup()
    const scans = vault.collection<InvoiceScan>('invoiceScans', {
      blobFields: { image: { evictWhen: () => true } },
    })
    await scans.put('s1', { id: 's1', status: 'x' })
    await scans.blob('s1').put('image', new TextEncoder().encode('a'))

    const result = await vault.compact({ dryRun: true })
    expect(result.evicted).toBe(1)
    expect(result.auditEntries).toBe(0)

    // slot still there
    expect(await scans.blob('s1').list()).toHaveLength(1)
    const store = (db as unknown as { options: { store: NoydbStore } }).options.store
    const ids = await store.list('acme', BLOB_EVICTION_AUDIT_COLLECTION)
    expect(ids).toHaveLength(0)
  })

  it('maxEvictions caps the batch size', async () => {
    const { vault } = await setup()
    const scans = vault.collection<InvoiceScan>('invoiceScans', {
      blobFields: { image: { evictWhen: () => true } },
    })
    for (let i = 0; i < 5; i++) {
      await scans.put(`s${i}`, { id: `s${i}`, status: 'x' })
      await scans.blob(`s${i}`).put('image', new TextEncoder().encode(String(i)))
    }
    const result = await vault.compact({ maxEvictions: 2 })
    expect(result.evicted).toBe(2)
  })

  it('skips collections with no blobFields config', async () => {
    const { vault } = await setup()
    const plain = vault.collection<{ id: string }>('plain')
    await plain.put('p1', { id: 'p1' })
    await plain.blob('p1').put('attachment', new TextEncoder().encode('z'))

    const result = await vault.compact()
    expect(result.collections).toBe(0)
    expect(result.evicted).toBe(0)
    expect(await plain.blob('p1').list()).toHaveLength(1)
  })

  it('predicate throwing does NOT evict (fail closed)', async () => {
    const { vault } = await setup()
    const scans = vault.collection<InvoiceScan>('invoiceScans', {
      blobFields: {
        image: {
          evictWhen: () => { throw new Error('boom') },
        },
      },
    })
    await scans.put('s1', { id: 's1', status: 'x' })
    await scans.blob('s1').put('image', new TextEncoder().encode('q'))

    const result = await vault.compact()
    expect(result.evicted).toBe(0)
    expect(await scans.blob('s1').list()).toHaveLength(1)
  })
})
