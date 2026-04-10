import { describe, it, expect, beforeEach } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot, NoydbBundleStore } from '../src/types.js'
import { ConflictError, BundleVersionConflictError } from '../src/errors.js'
import { createNoydb } from '../src/noydb.js'
import {
  BLOB_INDEX_COLLECTION,
  BLOB_CHUNKS_COLLECTION,
  BLOB_SLOTS_PREFIX,
  BLOB_VERSIONS_PREFIX,
  DEFAULT_CHUNK_SIZE,
} from '../src/blob-set.js'

// ─── Minimal in-memory store (same shape used by other tests) ─────────

function makeStore(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function bucket(vault: string, coll: string) {
    let v = store.get(vault)
    if (!v) { v = new Map(); store.set(vault, v) }
    let c = v.get(coll)
    if (!c) { c = new Map(); v.set(coll, c) }
    return c
  }
  return {
    name: 'memory',
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
      const v = store.get(vault)
      const snap: VaultSnapshot = {}
      if (v) for (const [n, c] of v) { const r: Record<string, EncryptedEnvelope> = {}; for (const [id, e] of c) r[id] = e; snap[n] = r }
      return snap
    },
    async saveAll(vault, data) {
      for (const [n, recs] of Object.entries(data)) {
        const b = bucket(vault, n)
        for (const [id, e] of Object.entries(recs)) b.set(id, e)
      }
    },
  }
}

const VAULT = 'test-vault'
const SECRET = 'correct-horse-battery-staple-long-enough'

// ─── Helpers ──────────────────────────────────────────────────────────

function randomBytes(n: number): Uint8Array {
  const buf = new Uint8Array(n)
  for (let i = 0; i < n; i++) buf[i] = Math.floor(Math.random() * 256)
  return buf
}

function textBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

// ─── BlobSet Tests ───────────────────────────────────────────────────

describe('BlobSet', () => {
  let store: NoydbStore

  beforeEach(() => {
    store = makeStore()
  })

  it('put → list → get round-trip (encrypted)', async () => {
    const db = await createNoydb({ store, user: 'alice', secret: SECRET })
    const vault = await db.openVault(VAULT)
    const invoices = vault.collection<{ ref: string }>('invoices')

    await invoices.put('inv-001', { ref: 'INV-001' })

    const blobs = invoices.blob('inv-001')
    const bytes = textBytes('hello blob world')

    await blobs.put('readme.txt', bytes, { mimeType: 'text/plain' })

    const info = await blobs.list()
    expect(info).toHaveLength(1)
    expect(info[0]!.name).toBe('readme.txt')
    expect(info[0]!.size).toBe(bytes.byteLength)
    expect(info[0]!.mimeType).toBe('text/plain')
    expect(info[0]!.eTag).toMatch(/^[0-9a-f]{64}$/)

    const recovered = await blobs.get('readme.txt')
    expect(recovered).not.toBeNull()
    expect(new TextDecoder().decode(recovered!)).toBe('hello blob world')

    db.close()
  })

  it('deduplication: identical content shares chunks and increments refCount', async () => {
    const db = await createNoydb({ store, user: 'alice', secret: SECRET })
    const vault = await db.openVault(VAULT)
    const invoices = vault.collection<{ ref: string }>('invoices')

    await invoices.put('inv-001', { ref: 'A' })
    await invoices.put('inv-002', { ref: 'B' })

    const content = textBytes('shared PDF content')

    await invoices.blob('inv-001').put('doc.pdf', content)
    await invoices.blob('inv-002').put('doc.pdf', content)

    const infoA = await invoices.blob('inv-001').blobInfo('doc.pdf')
    const infoB = await invoices.blob('inv-002').blobInfo('doc.pdf')

    expect(infoA).not.toBeNull()
    expect(infoB).not.toBeNull()
    // Same content → same eTag → same chunks reused
    expect(infoA!.eTag).toBe(infoB!.eTag)
    // refCount should be 2 (one per slot)
    expect(infoA!.refCount).toBe(2)

    // Only one set of chunks in the store
    const blobIds = await store.list(VAULT, BLOB_CHUNKS_COLLECTION)
    const uniqueEtags = new Set(blobIds.map((id) => id.split('/')[0]))
    expect(uniqueEtags.size).toBe(1)

    db.close()
  })

  it('delete decrements refCount', async () => {
    const db = await createNoydb({ store, user: 'alice', secret: SECRET })
    const vault = await db.openVault(VAULT)
    const invoices = vault.collection<{ ref: string }>('invoices')
    await invoices.put('inv-001', { ref: 'A' })

    const blobs = invoices.blob('inv-001')
    await blobs.put('file.txt', textBytes('to be deleted'))

    let info = await blobs.blobInfo('file.txt')
    expect(info!.refCount).toBe(1)

    await blobs.delete('file.txt')

    const slotList = await blobs.list()
    expect(slotList).toHaveLength(0)

    // Blob still exists but refCount is 0 (eligible for GC)
    const indexIds = await store.list(VAULT, BLOB_INDEX_COLLECTION)
    expect(indexIds.length).toBe(1)

    db.close()
  })

  it('BlobObject stores chunkSize and chunkCount', async () => {
    const db = await createNoydb({ store, user: 'alice', secret: SECRET })
    const vault = await db.openVault(VAULT)
    const files = vault.collection<{ name: string }>('files')
    await files.put('f-001', { name: 'test' })

    const data = textBytes('small file')
    await files.blob('f-001').put('small.txt', data, { compress: false })

    const info = await files.blob('f-001').blobInfo('small.txt')
    expect(info).not.toBeNull()
    expect(info!.chunkSize).toBe(DEFAULT_CHUNK_SIZE)
    expect(info!.chunkCount).toBe(1)
    expect(info!.refCount).toBe(1)

    db.close()
  })

  it('large blob is split into multiple chunks with correct chunkCount', async () => {
    const db = await createNoydb({ store, user: 'alice', secret: SECRET })
    const vault = await db.openVault(VAULT)
    const files = vault.collection<{ name: string }>('files')
    await files.put('f-001', { name: 'big' })

    const big = randomBytes(DEFAULT_CHUNK_SIZE * 3 + 100) // 3 full chunks + remainder
    await files.blob('f-001').put('big.bin', big, { compress: false })

    const chunks = await store.list(VAULT, BLOB_CHUNKS_COLLECTION)
    expect(chunks.length).toBe(4) // 3 full + 1 partial

    const info = await files.blob('f-001').blobInfo('big.bin')
    expect(info!.chunkCount).toBe(4)
    expect(info!.chunkSize).toBe(DEFAULT_CHUNK_SIZE)

    const recovered = await files.blob('f-001').get('big.bin')
    expect(recovered).not.toBeNull()
    expect(recovered!.byteLength).toBe(big.byteLength)
    expect(recovered).toEqual(big)

    db.close()
  })

  it('custom chunkSize is stored and used on read', async () => {
    const db = await createNoydb({ store, user: 'alice', secret: SECRET })
    const vault = await db.openVault(VAULT)
    const files = vault.collection<{ name: string }>('files')
    await files.put('f-001', { name: 'custom-chunk' })

    const data = randomBytes(500)
    const customChunkSize = 128
    await files.blob('f-001').put('custom.bin', data, {
      compress: false,
      chunkSize: customChunkSize,
    })

    const info = await files.blob('f-001').blobInfo('custom.bin')
    expect(info!.chunkSize).toBe(customChunkSize)
    expect(info!.chunkCount).toBe(4) // ceil(500/128) = 4

    // Read back must work (uses stored chunkSize/chunkCount, not DEFAULT)
    const recovered = await files.blob('f-001').get('custom.bin')
    expect(recovered).toEqual(data)

    db.close()
  })

  it('overwrites an existing slot and adjusts refCounts', async () => {
    const db = await createNoydb({ store, user: 'alice', secret: SECRET })
    const vault = await db.openVault(VAULT)
    const docs = vault.collection<{ id: string }>('docs')
    await docs.put('d-001', { id: 'D1' })

    const blobs = docs.blob('d-001')
    await blobs.put('file.txt', textBytes('version one'))

    const info1 = await blobs.blobInfo('file.txt')
    expect(info1!.refCount).toBe(1)

    await blobs.put('file.txt', textBytes('version two'))

    const list = await blobs.list()
    expect(list).toHaveLength(1) // still one slot

    const bytes = await blobs.get('file.txt')
    expect(new TextDecoder().decode(bytes!)).toBe('version two')

    db.close()
  })

  it('blobInfo returns null for missing slot', async () => {
    const db = await createNoydb({ store, user: 'alice', secret: SECRET })
    const vault = await db.openVault(VAULT)
    const col = vault.collection<{ x: number }>('things')
    await col.put('t-001', { x: 1 })

    const info = await col.blob('t-001').blobInfo('nonexistent.pdf')
    expect(info).toBeNull()

    db.close()
  })

  it('metadata uses correct collection prefix', async () => {
    const db = await createNoydb({ store, user: 'alice', secret: SECRET })
    const vault = await db.openVault(VAULT)
    const invoices = vault.collection<{ ref: string }>('invoices')
    await invoices.put('inv-001', { ref: 'X' })

    await invoices.blob('inv-001').put('doc.txt', textBytes('data'))

    // Slots collection should be _blob_slots_invoices
    const slotIds = await store.list(VAULT, `${BLOB_SLOTS_PREFIX}invoices`)
    expect(slotIds).toContain('inv-001')

    // Blob index should exist
    const indexIds = await store.list(VAULT, BLOB_INDEX_COLLECTION)
    expect(indexIds.length).toBe(1)

    db.close()
  })

  it('response() returns a Response with correct headers', async () => {
    const db = await createNoydb({ store, user: 'alice', secret: SECRET })
    const vault = await db.openVault(VAULT)
    const col = vault.collection<{ x: number }>('things')
    await col.put('t-001', { x: 1 })

    const content = textBytes('response test content')
    await col.blob('t-001').put('data.txt', content, { mimeType: 'text/plain' })

    const res = await col.blob('t-001').response('data.txt', { inline: true })
    expect(res).not.toBeNull()
    expect(res!.headers.get('Content-Type')).toBe('text/plain')
    expect(res!.headers.get('Content-Length')).toBe(String(content.byteLength))
    expect(res!.headers.get('ETag')).toMatch(/^"[0-9a-f]{64}"$/)
    expect(res!.headers.get('Content-Disposition')).toContain('inline')

    const bodyBytes = new Uint8Array(await res!.arrayBuffer())
    expect(new TextDecoder().decode(bodyBytes)).toBe('response test content')

    db.close()
  })

  it('works in unencrypted mode', async () => {
    const db = await createNoydb({ store, user: 'alice', encrypt: false })
    const vault = await db.openVault(VAULT)
    const col = vault.collection<{ n: number }>('items')
    await col.put('i-001', { n: 42 })

    const blobs = col.blob('i-001')
    const bytes = textBytes('plaintext blob')
    await blobs.put('plain.txt', bytes)

    const recovered = await blobs.get('plain.txt')
    expect(new TextDecoder().decode(recovered!)).toBe('plaintext blob')

    db.close()
  })

  // ─── MIME auto-detection ──────────────────────────────────────────

  it('auto-detects PDF MIME type from magic bytes', async () => {
    const db = await createNoydb({ store, user: 'alice', secret: SECRET })
    const vault = await db.openVault(VAULT)
    const col = vault.collection<{ x: number }>('docs')
    await col.put('d-001', { x: 1 })

    // Fake PDF: starts with %PDF magic bytes
    const pdfHeader = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34])
    const pdfData = new Uint8Array(100)
    pdfData.set(pdfHeader)

    await col.blob('d-001').put('report.pdf', pdfData)

    const info = await col.blob('d-001').list()
    expect(info[0]!.mimeType).toBe('application/pdf')

    db.close()
  })

  // ─── Published versions (UC-3 amendment versioning) ───────────────

  it('publish → getVersion round-trip', async () => {
    const db = await createNoydb({ store, user: 'alice', secret: SECRET })
    const vault = await db.openVault(VAULT)
    const invoices = vault.collection<{ ref: string }>('invoices')
    await invoices.put('inv-001', { ref: 'INV-001' })

    const blobs = invoices.blob('inv-001')
    const v1Bytes = textBytes('original invoice PDF')
    await blobs.put('invoice_en', v1Bytes, { mimeType: 'application/pdf' })

    // Publish as 'issued-2025-01'
    await blobs.publish('invoice_en', 'issued-2025-01')

    // Check refCount increased
    const info = await blobs.blobInfo('invoice_en')
    expect(info!.refCount).toBe(2) // slot + published version

    // Overwrite slot with amended content
    const v2Bytes = textBytes('amended invoice PDF')
    await blobs.put('invoice_en', v2Bytes, { mimeType: 'application/pdf' })
    await blobs.publish('invoice_en', 'amendment-2025-02')

    // Current slot shows amended version
    const current = await blobs.get('invoice_en')
    expect(new TextDecoder().decode(current!)).toBe('amended invoice PDF')

    // Published version 'issued-2025-01' still returns original
    const v1 = await blobs.getVersion('invoice_en', 'issued-2025-01')
    expect(v1).not.toBeNull()
    expect(new TextDecoder().decode(v1!)).toBe('original invoice PDF')

    // Published version 'amendment-2025-02' returns amended
    const v2 = await blobs.getVersion('invoice_en', 'amendment-2025-02')
    expect(new TextDecoder().decode(v2!)).toBe('amended invoice PDF')

    db.close()
  })

  it('listVersions returns all published versions for a slot', async () => {
    const db = await createNoydb({ store, user: 'alice', secret: SECRET })
    const vault = await db.openVault(VAULT)
    const col = vault.collection<{ x: number }>('docs')
    await col.put('d-001', { x: 1 })

    const blobs = col.blob('d-001')
    await blobs.put('file.txt', textBytes('v1'))
    await blobs.publish('file.txt', 'release-1')
    await blobs.put('file.txt', textBytes('v2'))
    await blobs.publish('file.txt', 'release-2')

    const versions = await blobs.listVersions('file.txt')
    expect(versions).toHaveLength(2)
    const labels = versions.map((v) => v.label).sort()
    expect(labels).toEqual(['release-1', 'release-2'])

    db.close()
  })

  it('deleteVersion decrements refCount', async () => {
    const db = await createNoydb({ store, user: 'alice', secret: SECRET })
    const vault = await db.openVault(VAULT)
    const col = vault.collection<{ x: number }>('docs')
    await col.put('d-001', { x: 1 })

    const blobs = col.blob('d-001')
    await blobs.put('file.txt', textBytes('content'))
    await blobs.publish('file.txt', 'v1')

    let info = await blobs.blobInfo('file.txt')
    expect(info!.refCount).toBe(2) // slot + version

    await blobs.deleteVersion('file.txt', 'v1')

    info = await blobs.blobInfo('file.txt')
    expect(info!.refCount).toBe(1) // only slot remains

    const versions = await blobs.listVersions('file.txt')
    expect(versions).toHaveLength(0)

    db.close()
  })

  it('responseVersion returns correct headers and body', async () => {
    const db = await createNoydb({ store, user: 'alice', secret: SECRET })
    const vault = await db.openVault(VAULT)
    const col = vault.collection<{ x: number }>('docs')
    await col.put('d-001', { x: 1 })

    const blobs = col.blob('d-001')
    const content = textBytes('published content')
    await blobs.put('doc.txt', content, { mimeType: 'text/plain' })
    await blobs.publish('doc.txt', 'v1')

    const res = await blobs.responseVersion('doc.txt', 'v1', { inline: true })
    expect(res).not.toBeNull()
    expect(res!.headers.get('Content-Type')).toBe('text/plain')

    const body = new Uint8Array(await res!.arrayBuffer())
    expect(new TextDecoder().decode(body)).toBe('published content')

    db.close()
  })
})

// ─── wrapBundleStore Tests ───────────────────────────────────────────

describe('wrapBundleStore', () => {
  it('wraps a bundle into a full NoydbStore with OCC', async () => {
    // Inline bundle backend with version tracking
    const storage = new Map<string, { bytes: Uint8Array; version: string }>()
    let versionCounter = 0
    const { wrapBundleStore } = await import('../src/bundle-store.js')

    const bundleBackend: NoydbBundleStore = {
      kind: 'bundle',
      name: 'test-bundle',
      async readBundle(vault) {
        const entry = storage.get(vault)
        return entry ? { bytes: entry.bytes, version: entry.version } : null
      },
      async writeBundle(vault, bytes, expectedVersion) {
        const current = storage.get(vault)
        const currentVersion = current?.version ?? null
        if (expectedVersion !== currentVersion) {
          throw new BundleVersionConflictError(currentVersion ?? 'null')
        }
        const newVersion = `v${++versionCounter}`
        storage.set(vault, { bytes, version: newVersion })
        return { version: newVersion }
      },
      async deleteBundle(vault) { storage.delete(vault) },
      async listBundles() {
        return [...storage.entries()].map(([vaultId, entry]) => ({
          vaultId,
          version: entry.version,
          size: entry.bytes.byteLength,
        }))
      },
    }

    const bundleStore = wrapBundleStore(bundleBackend)

    const db = await createNoydb({ store: bundleStore, user: 'alice', secret: SECRET })
    const vault = await db.openVault(VAULT)
    const invoices = vault.collection<{ amount: number }>('invoices')

    await invoices.put('inv-001', { amount: 100 })
    await invoices.put('inv-002', { amount: 200 })

    // Bundle should have been flushed to storage
    expect(storage.has(VAULT)).toBe(true)
    const bundleSize = storage.get(VAULT)!.bytes.byteLength
    expect(bundleSize).toBeGreaterThan(0)

    db.close()

    // Re-open from the same storage — data must survive
    const db2 = await createNoydb({ store: bundleStore, user: 'alice', secret: SECRET })
    const vault2 = await db2.openVault(VAULT)
    const invoices2 = vault2.collection<{ amount: number }>('invoices')

    const inv = await invoices2.get('inv-001')
    expect(inv).not.toBeNull()
    expect(inv!.amount).toBe(100)

    db2.close()
  })

  it('batch mode defers flush until batch completes', async () => {
    let flushCount = 0
    const storage = new Map<string, { bytes: Uint8Array; version: string }>()
    let versionCounter = 0
    const { wrapBundleStore } = await import('../src/bundle-store.js')

    const bundleBackend: NoydbBundleStore = {
      kind: 'bundle',
      async readBundle(vault) {
        const entry = storage.get(vault)
        return entry ? { bytes: entry.bytes, version: entry.version } : null
      },
      async writeBundle(vault, bytes, expectedVersion) {
        flushCount++
        const current = storage.get(vault)
        const currentVersion = current?.version ?? null
        if (expectedVersion !== currentVersion) {
          throw new BundleVersionConflictError(currentVersion ?? 'null')
        }
        const newVersion = `v${++versionCounter}`
        storage.set(vault, { bytes, version: newVersion })
        return { version: newVersion }
      },
      async deleteBundle(vault) { storage.delete(vault) },
      async listBundles() { return [] },
    }

    const bundleStore = wrapBundleStore(bundleBackend)

    // Use batch mode
    await bundleStore.batch(VAULT, async () => {
      const countBefore = flushCount
      await bundleStore.put(VAULT, 'col', 'id1', {
        _noydb: 1, _v: 1, _ts: new Date().toISOString(), _iv: '', _data: '{}',
      })
      await bundleStore.put(VAULT, 'col', 'id2', {
        _noydb: 1, _v: 1, _ts: new Date().toISOString(), _iv: '', _data: '{}',
      })
      // No flushes should have happened during the batch
      expect(flushCount).toBe(countBefore)
    })

    // Exactly one flush after batch completes
    expect(flushCount).toBe(1)
  })

  it('autoFlush: false suppresses automatic flushes', async () => {
    let flushCount = 0
    const storage = new Map<string, { bytes: Uint8Array; version: string }>()
    let versionCounter = 0
    const { wrapBundleStore } = await import('../src/bundle-store.js')

    const bundleBackend: NoydbBundleStore = {
      kind: 'bundle',
      async readBundle(vault) {
        const entry = storage.get(vault)
        return entry ? { bytes: entry.bytes, version: entry.version } : null
      },
      async writeBundle(vault, bytes, expectedVersion) {
        flushCount++
        const current = storage.get(vault)
        const currentVersion = current?.version ?? null
        if (expectedVersion !== currentVersion) {
          throw new BundleVersionConflictError(currentVersion ?? 'null')
        }
        const newVersion = `v${++versionCounter}`
        storage.set(vault, { bytes, version: newVersion })
        return { version: newVersion }
      },
      async deleteBundle(vault) { storage.delete(vault) },
      async listBundles() { return [] },
    }

    const bundleStore = wrapBundleStore(bundleBackend, { autoFlush: false })

    await bundleStore.put(VAULT, 'col', 'id1', {
      _noydb: 1, _v: 1, _ts: new Date().toISOString(), _iv: '', _data: '{}',
    })
    expect(flushCount).toBe(0) // no auto-flush

    await bundleStore.flush(VAULT)
    expect(flushCount).toBe(1) // explicit flush
  })

  it('conflict check: expectedVersion throws ConflictError on mismatch', async () => {
    const storage = new Map<string, { bytes: Uint8Array; version: string }>()
    let versionCounter = 0
    const { wrapBundleStore } = await import('../src/bundle-store.js')

    const bundleBackend: NoydbBundleStore = {
      kind: 'bundle',
      async readBundle(vault) {
        const entry = storage.get(vault)
        return entry ? { bytes: entry.bytes, version: entry.version } : null
      },
      async writeBundle(vault, bytes, expectedVersion) {
        const current = storage.get(vault)
        const currentVersion = current?.version ?? null
        if (expectedVersion !== currentVersion) {
          throw new BundleVersionConflictError(currentVersion ?? 'null')
        }
        const newVersion = `v${++versionCounter}`
        storage.set(vault, { bytes, version: newVersion })
        return { version: newVersion }
      },
      async deleteBundle(vault) { storage.delete(vault) },
      async listBundles() { return [] },
    }

    const bundleStore = wrapBundleStore(bundleBackend)

    const db = await createNoydb({ store: bundleStore, user: 'alice', secret: SECRET })
    const vault = await db.openVault(VAULT)
    const col = vault.collection<{ x: number }>('things')
    await col.put('t-001', { x: 1 })

    // KV-level CAS: wrong expectedVersion should throw ConflictError
    const env = await bundleStore.get(VAULT, 'things', 't-001')
    expect(env).not.toBeNull()

    await expect(
      bundleStore.put(VAULT, 'things', 't-001', { ...env!, _v: env!._v + 1 }, 0),
    ).rejects.toThrow()

    db.close()
  })
})

// ─── MIME magic detection ───────────────────────────────────────────

describe('detectMimeType', () => {
  it('detects PDF from magic bytes', async () => {
    const { detectMimeType } = await import('../src/mime-magic.js')
    const header = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0, 0, 0, 0, 0, 0, 0, 0])
    expect(detectMimeType(header)).toBe('application/pdf')
  })

  it('detects PNG from magic bytes', async () => {
    const { detectMimeType } = await import('../src/mime-magic.js')
    const header = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0])
    expect(detectMimeType(header)).toBe('image/png')
  })

  it('detects JPEG from magic bytes', async () => {
    const { detectMimeType } = await import('../src/mime-magic.js')
    const header = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    expect(detectMimeType(header)).toBe('image/jpeg')
  })

  it('detects ZIP from magic bytes', async () => {
    const { detectMimeType } = await import('../src/mime-magic.js')
    const header = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    expect(detectMimeType(header)).toBe('application/zip')
  })

  it('detects GZIP from magic bytes', async () => {
    const { detectMimeType } = await import('../src/mime-magic.js')
    const header = new Uint8Array([0x1f, 0x8b, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    expect(detectMimeType(header)).toBe('application/gzip')
  })

  it('returns octet-stream for unknown', async () => {
    const { detectMimeType } = await import('../src/mime-magic.js')
    const header = new Uint8Array([0x00, 0x00, 0x00, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    expect(detectMimeType(header)).toBe('application/octet-stream')
  })

  it('marks compressed formats as pre-compressed', async () => {
    const { isPreCompressed } = await import('../src/mime-magic.js')
    expect(isPreCompressed('image/jpeg')).toBe(true)
    expect(isPreCompressed('image/png')).toBe(true)
    expect(isPreCompressed('application/zip')).toBe(true)
    expect(isPreCompressed('application/gzip')).toBe(true)
    expect(isPreCompressed('application/pdf')).toBe(false)
    expect(isPreCompressed('text/plain')).toBe(false)
  })
})
