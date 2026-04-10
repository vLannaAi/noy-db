import { describe, it, expect, beforeEach } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/types.js'
import { routeStore } from '../src/route-store.js'
import { ConflictError } from '../src/errors.js'

// ─── Minimal in-memory store factory ────────────────────────────────

function makeStore(name: string): NoydbStore & { _data: Map<string, Map<string, Map<string, EncryptedEnvelope>>> } {
  const data = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function bucket(vault: string, coll: string) {
    let v = data.get(vault)
    if (!v) { v = new Map(); data.set(vault, v) }
    let c = v.get(coll)
    if (!c) { c = new Map(); v.set(coll, c) }
    return c
  }
  return {
    name,
    _data: data,
    async get(vault, coll, id) { return bucket(vault, coll).get(id) ?? null },
    async put(vault, coll, id, env, ev) {
      const b = bucket(vault, coll)
      const ex = b.get(id)
      if (ev !== undefined && (ex?._v ?? 0) !== ev) throw new ConflictError(ex?._v ?? 0)
      b.set(id, env)
    },
    async delete(vault, coll, id) { bucket(vault, coll).delete(id) },
    async list(vault, coll) { return [...bucket(vault, coll).keys()] },
    async loadAll(vault) {
      const v = data.get(vault)
      const snap: VaultSnapshot = {}
      if (v) for (const [n, c] of v) { const r: Record<string, EncryptedEnvelope> = {}; for (const [id, e] of c) r[id] = e; snap[n] = r }
      return snap
    },
    async saveAll(vault, d) {
      for (const [n, recs] of Object.entries(d)) {
        const b = bucket(vault, n)
        for (const [id, e] of Object.entries(recs)) b.set(id, e)
      }
    },
  }
}

function envelope(v: number, data = '{}'): EncryptedEnvelope {
  return { _noydb: 1, _v: v, _ts: new Date().toISOString(), _iv: '', _data: data }
}

function oldEnvelope(v: number, daysAgo: number): EncryptedEnvelope {
  const ts = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString()
  return { _noydb: 1, _v: v, _ts: ts, _iv: '', _data: '{}' }
}

const VAULT = 'test-vault'

// ─── Tests ──────────────────────────────────────────────────────────

describe('routeStore', () => {
  describe('basic prefix routing (blobs → separate store)', () => {
    it('routes _blob_chunks to blob store, everything else to default', async () => {
      const defaultStore = makeStore('dynamo')
      const blobStore = makeStore('s3')
      const routed = routeStore({ default: defaultStore, blobs: blobStore })

      // Record → default
      await routed.put(VAULT, 'invoices', 'inv-1', envelope(1))
      expect(await defaultStore.get(VAULT, 'invoices', 'inv-1')).not.toBeNull()
      expect(blobStore._data.get(VAULT)?.get('invoices')).toBeUndefined()

      // Blob chunk → blob store
      await routed.put(VAULT, '_blob_chunks', 'abc_0', envelope(1))
      expect(await blobStore.get(VAULT, '_blob_chunks', 'abc_0')).not.toBeNull()
      expect(defaultStore._data.get(VAULT)?.get('_blob_chunks')).toBeUndefined()

      // Blob index stays in default (routeBlobMeta: false)
      await routed.put(VAULT, '_blob_index', 'abc', envelope(1))
      expect(await defaultStore.get(VAULT, '_blob_index', 'abc')).not.toBeNull()
    })

    it('routeBlobMeta: true routes all blob collections to blob store', async () => {
      const defaultStore = makeStore('dynamo')
      const blobStore = makeStore('s3')
      const routed = routeStore({ default: defaultStore, blobs: blobStore, routeBlobMeta: true })

      await routed.put(VAULT, '_blob_index', 'abc', envelope(1))
      await routed.put(VAULT, '_blob_slots_invoices', 'inv-1', envelope(1))
      await routed.put(VAULT, '_blob_versions_invoices', 'inv-1::pdf::v1', envelope(1))

      expect(await blobStore.get(VAULT, '_blob_index', 'abc')).not.toBeNull()
      expect(await blobStore.get(VAULT, '_blob_slots_invoices', 'inv-1')).not.toBeNull()
      expect(await blobStore.get(VAULT, '_blob_versions_invoices', 'inv-1::pdf::v1')).not.toBeNull()
    })

    it('get reads from the correct store', async () => {
      const defaultStore = makeStore('dynamo')
      const blobStore = makeStore('s3')
      const routed = routeStore({ default: defaultStore, blobs: blobStore })

      await blobStore.put(VAULT, '_blob_chunks', 'abc_0', envelope(1, 'chunk-data'))
      const result = await routed.get(VAULT, '_blob_chunks', 'abc_0')
      expect(result).not.toBeNull()
      expect(result!._data).toBe('chunk-data')
    })

    it('list returns IDs from the correct store', async () => {
      const defaultStore = makeStore('dynamo')
      const blobStore = makeStore('s3')
      const routed = routeStore({ default: defaultStore, blobs: blobStore })

      await routed.put(VAULT, '_blob_chunks', 'a_0', envelope(1))
      await routed.put(VAULT, '_blob_chunks', 'b_0', envelope(1))
      await routed.put(VAULT, 'invoices', 'inv-1', envelope(1))

      const chunkIds = await routed.list(VAULT, '_blob_chunks')
      expect(chunkIds).toHaveLength(2)

      const invoiceIds = await routed.list(VAULT, 'invoices')
      expect(invoiceIds).toHaveLength(1)
    })

    it('delete removes from the correct store', async () => {
      const defaultStore = makeStore('dynamo')
      const blobStore = makeStore('s3')
      const routed = routeStore({ default: defaultStore, blobs: blobStore })

      await routed.put(VAULT, '_blob_chunks', 'abc_0', envelope(1))
      await routed.delete(VAULT, '_blob_chunks', 'abc_0')

      expect(await blobStore.get(VAULT, '_blob_chunks', 'abc_0')).toBeNull()
    })
  })

  describe('loadAll / saveAll composition', () => {
    it('loadAll merges snapshots from all stores', async () => {
      const defaultStore = makeStore('dynamo')
      const blobStore = makeStore('s3')
      const routed = routeStore({ default: defaultStore, blobs: blobStore })

      await defaultStore.put(VAULT, 'invoices', 'inv-1', envelope(1))
      await blobStore.put(VAULT, '_blob_chunks', 'abc_0', envelope(1))

      const snap = await routed.loadAll(VAULT)
      expect(snap['invoices']?.['inv-1']).not.toBeUndefined()
      expect(snap['_blob_chunks']?.['abc_0']).not.toBeUndefined()
    })

    it('saveAll partitions data to correct stores', async () => {
      const defaultStore = makeStore('dynamo')
      const blobStore = makeStore('s3')
      const routed = routeStore({ default: defaultStore, blobs: blobStore })

      const snap: VaultSnapshot = {
        invoices: { 'inv-1': envelope(1) },
        _blob_chunks: { 'abc_0': envelope(1) },
      }
      await routed.saveAll(VAULT, snap)

      expect(await defaultStore.get(VAULT, 'invoices', 'inv-1')).not.toBeNull()
      expect(await blobStore.get(VAULT, '_blob_chunks', 'abc_0')).not.toBeNull()
      // Verify they didn't end up in the wrong store
      expect(defaultStore._data.get(VAULT)?.get('_blob_chunks')).toBeUndefined()
      expect(blobStore._data.get(VAULT)?.get('invoices')).toBeUndefined()
    })

    it('loadAll deduplicates by _ts (latest wins)', async () => {
      const storeA = makeStore('a')
      const storeB = makeStore('b')
      const routed = routeStore({ default: storeA, blobs: storeB })

      const old = { _noydb: 1 as const, _v: 1, _ts: '2026-01-01T00:00:00Z', _iv: '', _data: 'old' }
      const newer = { _noydb: 1 as const, _v: 2, _ts: '2026-06-01T00:00:00Z', _iv: '', _data: 'new' }

      await storeA.put(VAULT, 'col', 'id1', old)
      await storeB.put(VAULT, 'col', 'id1', newer)

      const snap = await routed.loadAll(VAULT)
      expect(snap['col']?.['id1']?._data).toBe('new')
    })
  })

  describe('per-collection routing', () => {
    it('routes specific collections to dedicated stores', async () => {
      const defaultStore = makeStore('dynamo')
      const pgStore = makeStore('postgres')
      const routed = routeStore({
        default: defaultStore,
        routes: { invoices: pgStore, disbursements: pgStore },
      })

      await routed.put(VAULT, 'invoices', 'inv-1', envelope(1))
      await routed.put(VAULT, 'clients', 'cl-1', envelope(1))

      expect(await pgStore.get(VAULT, 'invoices', 'inv-1')).not.toBeNull()
      expect(await defaultStore.get(VAULT, 'clients', 'cl-1')).not.toBeNull()
      // Verify no cross-contamination
      expect(defaultStore._data.get(VAULT)?.get('invoices')).toBeUndefined()
      expect(pgStore._data.get(VAULT)?.get('clients')).toBeUndefined()
    })
  })

  describe('vault-based routing', () => {
    it('routes vaults by name prefix', async () => {
      const thStore = makeStore('ap-southeast-1')
      const euStore = makeStore('eu-west-1')
      const routed = routeStore({
        default: thStore,
        vaultRoutes: { 'EU-': euStore },
      })

      await routed.put('EU-C101', 'invoices', 'inv-1', envelope(1))
      await routed.put('TH-C201', 'invoices', 'inv-2', envelope(1))

      expect(await euStore.get('EU-C101', 'invoices', 'inv-1')).not.toBeNull()
      expect(await thStore.get('TH-C201', 'invoices', 'inv-2')).not.toBeNull()
    })
  })

  describe('size-tiered blob routing', () => {
    it('routes small blobs to small store, large to large store', async () => {
      const defaultStore = makeStore('dynamo')
      const s3Store = makeStore('s3')
      const routed = routeStore({
        default: defaultStore,
        blobs: {
          small: defaultStore, // DynamoDB inline
          large: s3Store,      // S3 overflow
          threshold: 100,      // 100 bytes for testing
        },
      })

      const smallData = 'x'.repeat(50) // 50 bytes
      const largeData = 'x'.repeat(200) // 200 bytes

      await routed.put(VAULT, '_blob_chunks', 'small_0', envelope(1, smallData))
      await routed.put(VAULT, '_blob_chunks', 'large_0', envelope(1, largeData))

      // Small blob → dynamo (small store)
      expect(await defaultStore.get(VAULT, '_blob_chunks', 'small_0')).not.toBeNull()
      // Large blob → s3 (large store)
      expect(await s3Store.get(VAULT, '_blob_chunks', 'large_0')).not.toBeNull()
    })
  })

  describe('age-tiered routing', () => {
    it('get falls back to cold store for missing records', async () => {
      const hotStore = makeStore('dynamo')
      const coldStore = makeStore('s3-archive')
      const routed = routeStore({
        default: hotStore,
        age: { cold: coldStore, coldAfterDays: 90, collections: ['invoices'] },
      })

      // Record only in cold store
      await coldStore.put(VAULT, 'invoices', 'old-inv', envelope(1, 'old-data'))

      const result = await routed.get(VAULT, 'invoices', 'old-inv')
      expect(result).not.toBeNull()
      expect(result!._data).toBe('old-data')
    })

    it('get does NOT fall back for non-age-tiered collections', async () => {
      const hotStore = makeStore('dynamo')
      const coldStore = makeStore('s3-archive')
      const routed = routeStore({
        default: hotStore,
        age: { cold: coldStore, coldAfterDays: 90, collections: ['invoices'] },
      })

      // Record only in cold store, but collection not in age tier
      await coldStore.put(VAULT, 'clients', 'cl-1', envelope(1))

      const result = await routed.get(VAULT, 'clients', 'cl-1')
      expect(result).toBeNull() // no fallback
    })

    it('list merges IDs from hot and cold stores', async () => {
      const hotStore = makeStore('dynamo')
      const coldStore = makeStore('s3-archive')
      const routed = routeStore({
        default: hotStore,
        age: { cold: coldStore, coldAfterDays: 90, collections: ['invoices'] },
      })

      await hotStore.put(VAULT, 'invoices', 'recent-1', envelope(1))
      await coldStore.put(VAULT, 'invoices', 'old-1', envelope(1))

      const ids = await routed.list(VAULT, 'invoices')
      expect(ids).toContain('recent-1')
      expect(ids).toContain('old-1')
      expect(ids).toHaveLength(2)
    })

    it('list deduplicates IDs present in both stores', async () => {
      const hotStore = makeStore('dynamo')
      const coldStore = makeStore('s3-archive')
      const routed = routeStore({
        default: hotStore,
        age: { cold: coldStore, coldAfterDays: 90, collections: ['invoices'] },
      })

      await hotStore.put(VAULT, 'invoices', 'both', envelope(1))
      await coldStore.put(VAULT, 'invoices', 'both', envelope(1))

      const ids = await routed.list(VAULT, 'invoices')
      expect(ids).toHaveLength(1)
    })

    it('compact migrates old records to cold store', async () => {
      const hotStore = makeStore('dynamo')
      const coldStore = makeStore('s3-archive')
      const routed = routeStore({
        default: hotStore,
        age: { cold: coldStore, coldAfterDays: 90, collections: ['invoices'] },
      })

      await hotStore.put(VAULT, 'invoices', 'old-inv', oldEnvelope(1, 120)) // 120 days old
      await hotStore.put(VAULT, 'invoices', 'new-inv', envelope(1)) // recent

      const migrated = await routed.compact(VAULT)
      expect(migrated).toBe(1)

      // Old record moved to cold
      expect(await coldStore.get(VAULT, 'invoices', 'old-inv')).not.toBeNull()
      expect(await hotStore.get(VAULT, 'invoices', 'old-inv')).toBeNull()

      // New record stays in hot
      expect(await hotStore.get(VAULT, 'invoices', 'new-inv')).not.toBeNull()
    })

    it('put promotes cold records back to hot', async () => {
      const hotStore = makeStore('dynamo')
      const coldStore = makeStore('s3-archive')
      const routed = routeStore({
        default: hotStore,
        age: { cold: coldStore, coldAfterDays: 90, collections: ['invoices'] },
      })

      // Record exists in cold
      await coldStore.put(VAULT, 'invoices', 'promoted', oldEnvelope(1, 120))

      // Update via routed store — goes to hot, cold copy deleted
      await routed.put(VAULT, 'invoices', 'promoted', envelope(2))

      expect(await hotStore.get(VAULT, 'invoices', 'promoted')).not.toBeNull()
      // Cold copy should be cleaned up (best-effort)
      // Give the async delete a tick to complete
      await new Promise(r => setTimeout(r, 10))
      expect(await coldStore.get(VAULT, 'invoices', 'promoted')).toBeNull()
    })
  })

  describe('store name', () => {
    it('builds a descriptive name from component stores', () => {
      const routed = routeStore({
        default: makeStore('dynamo'),
        blobs: makeStore('s3'),
      })
      expect(routed.name).toBe('route(dynamo+s3)')
    })
  })
})
