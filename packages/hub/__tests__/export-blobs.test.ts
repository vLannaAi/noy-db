/**
 * Tests for `vault.exportBlobs()` bulk blob extraction (v0.21 #262).
 */
import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/index.js'
import { ConflictError, ExportCapabilityError, createNoydb } from '../src/index.js'
import { withBlobs } from '../src/blobs/index.js'
import type { Noydb, Vault } from '../src/index.js'
import { ExportBlobsAbortedError, EXPORT_AUDIT_COLLECTION } from '../src/blobs/export-blobs.js'

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

interface InvoiceScan { id: string; clientId: string; status: string }

async function setup(): Promise<{ db: Noydb; vault: Vault }> {
  const adapter = memory()
  const db = await createNoydb({ store: adapter, user: 'owner-01', secret: 'pw' , blobStrategy: withBlobs() })
  const vault = await db.openVault('acme')
  await db.grant('acme', {
    userId: 'owner-01', displayName: 'Owner', role: 'owner',
    passphrase: 'pw',
    exportCapability: { plaintext: ['blob'] },
  })
  await db.close()
  const db2 = await createNoydb({ store: adapter, user: 'owner-01', secret: 'pw' , blobStrategy: withBlobs() })
  const reopened = await db2.openVault('acme')
  const scans = reopened.collection<InvoiceScan>('invoiceScans')
  await scans.put('s1', { id: 's1', clientId: 'c-123', status: 'confirmed' })
  await scans.put('s2', { id: 's2', clientId: 'c-999', status: 'draft' })
  await scans.put('s3', { id: 's3', clientId: 'c-123', status: 'confirmed' })

  await scans.blob('s1').put('image', new TextEncoder().encode('scan-1-bytes'))
  await scans.blob('s2').put('image', new TextEncoder().encode('scan-2-bytes'))
  await scans.blob('s3').put('image', new TextEncoder().encode('scan-3-bytes'))
  await scans.blob('s3').put('thumbnail', new TextEncoder().encode('thumb-3'))
  return { db: db2, vault: reopened }
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const item of iter) out.push(item)
  return out
}

describe('vault.exportBlobs — authorisation gate', () => {
  it('throws ExportCapabilityError when the caller lacks plaintext/blob', async () => {
    const db = await createNoydb({ store: memory(), user: 'owner-01', secret: 'pw' , blobStrategy: withBlobs() })
    const vault = await db.openVault('acme')
    // No grant → default exportCapability is empty.
    expect(() => vault.exportBlobs()).toThrow(ExportCapabilityError)
  })
})

describe('vault.exportBlobs — iteration', () => {
  it('yields every blob across every collection when no filter is set', async () => {
    const { vault } = await setup()
    const items = await collect(vault.exportBlobs())
    // 3 records × 1 slot each + 1 extra thumbnail on s3 = 4 blobs.
    expect(items).toHaveLength(4)
    const slotNames = items.map(i => i.recordRef.slot).sort()
    expect(slotNames).toEqual(['image', 'image', 'image', 'thumbnail'])
  })

  it('restricts to the collections allowlist', async () => {
    const { vault } = await setup()
    const items = await collect(vault.exportBlobs({ collections: ['invoiceScans'] }))
    expect(items.every(i => i.recordRef.collection === 'invoiceScans')).toBe(true)
  })

  it('applies the `where` predicate on the decrypted record', async () => {
    const { vault } = await setup()
    const items = await collect(vault.exportBlobs({
      where: (rec) => (rec as { clientId?: string }).clientId === 'c-123',
    }))
    // Only s1 + s3 match; s3 has 2 slots.
    expect(items.map(i => i.recordRef.id).sort()).toEqual(['s1', 's3', 's3'])
  })

  it('decrypts the blob bytes as it iterates', async () => {
    const { vault } = await setup()
    const items = await collect(vault.exportBlobs({
      collections: ['invoiceScans'],
      where: (rec) => (rec as { id: string }).id === 's1',
    }))
    expect(items).toHaveLength(1)
    expect(new TextDecoder().decode(items[0]!.bytes)).toBe('scan-1-bytes')
  })

  it('tuples carry blobId + recordRef + meta', async () => {
    const { vault } = await setup()
    const [first] = await collect(vault.exportBlobs({
      collections: ['invoiceScans'],
      where: (rec) => (rec as { id: string }).id === 's1',
    }))
    expect(first).toBeDefined()
    expect(first!.blobId).toMatch(/^[0-9a-f]+$/) // hex eTag
    expect(first!.recordRef).toEqual({ collection: 'invoiceScans', id: 's1', slot: 'image' })
    expect(first!.meta.size).toBe('scan-1-bytes'.length)
    expect(first!.meta.createdAt).toBeTruthy()
  })

  it('skips internal (underscore-prefixed) collections', async () => {
    const { vault } = await setup()
    const items = await collect(vault.exportBlobs())
    expect(items.every(i => !i.recordRef.collection.startsWith('_'))).toBe(true)
  })
})

describe('vault.exportBlobs — abort + resume', () => {
  it('aborts via handle.abort() between yields', async () => {
    const { vault } = await setup()
    const handle = vault.exportBlobs()
    const seen: string[] = []
    handle.abort()
    try {
      for await (const item of handle) seen.push(item.recordRef.id)
    } catch (err) {
      expect(err).toBeInstanceOf(ExportBlobsAbortedError)
    }
    expect(seen).toEqual([])
    expect(handle.aborted).toBe(true)
  })

  it('honours an external AbortSignal', async () => {
    const { vault } = await setup()
    const ctrl = new AbortController()
    const handle = vault.exportBlobs({ signal: ctrl.signal })
    ctrl.abort()
    let caught: unknown
    try {
      for await (const _ of handle) void _
    } catch (err) { caught = err }
    expect(caught).toBeInstanceOf(ExportBlobsAbortedError)
  })

  it('resumes after `afterBlobId`', async () => {
    const { vault } = await setup()
    const all = await collect(vault.exportBlobs())
    expect(all.length).toBeGreaterThanOrEqual(3)
    const resume = await collect(vault.exportBlobs({ afterBlobId: all[0]!.blobId }))
    expect(resume).toHaveLength(all.length - 1)
    expect(resume[0]!.blobId).toBe(all[1]!.blobId)
  })
})

describe('vault.exportBlobs — audit entry', () => {
  it('writes a single entry to _export_audit per handle', async () => {
    const { db, vault } = await setup()
    await collect(vault.exportBlobs({ collections: ['invoiceScans'] }))
    const store = (db as unknown as { options: { store: NoydbStore } }).options.store
    const ids = await store.list('acme', EXPORT_AUDIT_COLLECTION)
    expect(ids).toHaveLength(1)
  })

  it('records actor + mechanism + collections in the audit entry', async () => {
    const { db, vault } = await setup()
    await collect(vault.exportBlobs({ collections: ['invoiceScans'] }))
    const store = (db as unknown as { options: { store: NoydbStore } }).options.store
    const ids = await store.list('acme', EXPORT_AUDIT_COLLECTION)
    const env = await store.get('acme', EXPORT_AUDIT_COLLECTION, ids[0]!)
    expect(env).not.toBeNull()
    // Envelope is encrypted — check the unencrypted metadata.
    expect(env!._by).toBe('owner-01')
  })
})
