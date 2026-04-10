/**
 * Legacy attachment test — validates backward compatibility of the
 * renamed BlobSet API (formerly AttachmentHandle).
 *
 * The comprehensive test suite is in blob-set.test.ts. This file exists
 * to verify that `collection.blob()` (formerly `collection.attachments()`)
 * still works end-to-end with the new naming and interfaces.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot, NoydbBundleStore } from '../src/types.js'
import { ConflictError, BundleVersionConflictError } from '../src/errors.js'
import { createNoydb } from '../src/noydb.js'
import {
  BLOB_INDEX_COLLECTION,
  BLOB_CHUNKS_COLLECTION,
  BLOB_SLOTS_PREFIX,
  DEFAULT_CHUNK_SIZE,
} from '../src/blob-set.js'

// ─── Minimal in-memory store ─────────────────────────────────────────

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

function textBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

function randomBytes(n: number): Uint8Array {
  const buf = new Uint8Array(n)
  for (let i = 0; i < n; i++) buf[i] = Math.floor(Math.random() * 256)
  return buf
}

// ─── Tests (updated to use new API names) ───────────────────────────

describe('BlobSet (legacy attachment compat)', () => {
  let store: NoydbStore

  beforeEach(() => {
    store = makeStore()
  })

  it('put → list → get round-trip (encrypted)', async () => {
    const db = await createNoydb({ store, user: 'alice', secret: SECRET })
    const vault = await db.openVault(VAULT)
    const invoices = vault.collection<{ ref: string }>('invoices')

    await invoices.put('inv-001', { ref: 'INV-001' })

    const handle = invoices.blob('inv-001')
    const bytes = textBytes('hello attachment world')

    await handle.put('readme.txt', bytes, { mimeType: 'text/plain' })

    const info = await handle.list()
    expect(info).toHaveLength(1)
    expect(info[0]!.name).toBe('readme.txt')
    expect(info[0]!.size).toBe(bytes.byteLength)
    expect(info[0]!.mimeType).toBe('text/plain')
    expect(info[0]!.eTag).toMatch(/^[0-9a-f]{64}$/)

    const recovered = await handle.get('readme.txt')
    expect(recovered).not.toBeNull()
    expect(new TextDecoder().decode(recovered!)).toBe('hello attachment world')

    db.close()
  })

  it('deduplication: identical content shares chunks', async () => {
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
    expect(infoA!.eTag).toBe(infoB!.eTag)

    const blobIds = await store.list(VAULT, BLOB_CHUNKS_COLLECTION)
    const uniqueEtags = new Set(blobIds.map((id) => id.split('/')[0]))
    expect(uniqueEtags.size).toBe(1)

    db.close()
  })

  it('delete removes metadata', async () => {
    const db = await createNoydb({ store, user: 'alice', secret: SECRET })
    const vault = await db.openVault(VAULT)
    const invoices = vault.collection<{ ref: string }>('invoices')
    await invoices.put('inv-001', { ref: 'A' })

    const handle = invoices.blob('inv-001')
    await handle.put('file.txt', textBytes('to be deleted'))

    const beforeChunks = await store.list(VAULT, BLOB_CHUNKS_COLLECTION)
    expect(beforeChunks.length).toBeGreaterThan(0)

    await handle.delete('file.txt')

    const info = await handle.list()
    expect(info).toHaveLength(0)

    // Chunks still present — orphan GC is deferred to vault.blobGC()
    const afterChunks = await store.list(VAULT, BLOB_CHUNKS_COLLECTION)
    expect(afterChunks.length).toBe(beforeChunks.length)

    db.close()
  })

  it('large blob is split into multiple chunks', async () => {
    const db = await createNoydb({ store, user: 'alice', secret: SECRET })
    const vault = await db.openVault(VAULT)
    const files = vault.collection<{ name: string }>('files')
    await files.put('f-001', { name: 'big' })

    const big = randomBytes(DEFAULT_CHUNK_SIZE * 3 + 100)
    await files.blob('f-001').put('big.bin', big, { compress: false })

    const chunks = await store.list(VAULT, BLOB_CHUNKS_COLLECTION)
    expect(chunks.length).toBe(4)

    const recovered = await files.blob('f-001').get('big.bin')
    expect(recovered).not.toBeNull()
    expect(recovered!.byteLength).toBe(big.byteLength)
    expect(recovered).toEqual(big)

    db.close()
  })

  it('overwrites an existing slot', async () => {
    const db = await createNoydb({ store, user: 'alice', secret: SECRET })
    const vault = await db.openVault(VAULT)
    const docs = vault.collection<{ id: string }>('docs')
    await docs.put('d-001', { id: 'D1' })

    const handle = docs.blob('d-001')
    await handle.put('file.txt', textBytes('version one'))
    await handle.put('file.txt', textBytes('version two'))

    const list = await handle.list()
    expect(list).toHaveLength(1)

    const bytes = await handle.get('file.txt')
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

  it('metadata uses parent collection name prefix', async () => {
    const db = await createNoydb({ store, user: 'alice', secret: SECRET })
    const vault = await db.openVault(VAULT)
    const invoices = vault.collection<{ ref: string }>('invoices')
    await invoices.put('inv-001', { ref: 'X' })

    await invoices.blob('inv-001').put('doc.txt', textBytes('data'))

    const metaIds = await store.list(VAULT, `${BLOB_SLOTS_PREFIX}invoices`)
    expect(metaIds).toContain('inv-001')

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

    const handle = col.blob('i-001')
    const bytes = textBytes('plaintext blob')
    await handle.put('plain.txt', bytes)

    const recovered = await handle.get('plain.txt')
    expect(new TextDecoder().decode(recovered!)).toBe('plaintext blob')

    db.close()
  })
})

describe('wrapBundleStore', () => {
  it('wraps a bundle into a full NoydbStore', async () => {
    const storage = new Map<string, { bytes: Uint8Array; version: string }>()
    let versionCounter = 0
    const { wrapBundleStore } = await import('../src/bundle-store.js')

    const bundleStore = wrapBundleStore({
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
      async listBundles() { return [] },
    })

    const db = await createNoydb({ store: bundleStore, user: 'alice', secret: SECRET })
    const vault = await db.openVault(VAULT)
    const invoices = vault.collection<{ amount: number }>('invoices')

    await invoices.put('inv-001', { amount: 100 })
    await invoices.put('inv-002', { amount: 200 })

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

  it('conflict check: expectedVersion throws ConflictError on mismatch', async () => {
    const storage = new Map<string, { bytes: Uint8Array; version: string }>()
    let versionCounter = 0
    const { wrapBundleStore } = await import('../src/bundle-store.js')

    const bundleStore = wrapBundleStore({
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
    })

    const db = await createNoydb({ store: bundleStore, user: 'alice', secret: SECRET })
    const vault = await db.openVault(VAULT)
    const col = vault.collection<{ x: number }>('things')
    await col.put('t-001', { x: 1 })

    const env = await bundleStore.get(VAULT, 'things', 't-001')
    expect(env).not.toBeNull()

    await expect(
      bundleStore.put(VAULT, 'things', 't-001', { ...env!, _v: env!._v + 1 }, 0)
    ).rejects.toThrow()

    db.close()
  })
})
