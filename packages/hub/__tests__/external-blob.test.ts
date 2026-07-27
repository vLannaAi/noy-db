/**
 * #412 P3 — external blob fields. A blob field declared `external` routes its
 * RAW bytes to the vault's ObjectProjection (servable, unencrypted) instead of
 * the encrypted-chunk path. The encrypted slot record stays the catalog
 * (anchoring). Records themselves remain encrypted.
 */
import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { ConflictError } from '../src/kernel/errors.js'
import { createNoydb } from '../src/kernel/noydb.js'
import { withBlobs } from '../src/via/blob/index.js'
import { memoryObjectProjection } from '../src/with-shape/blobs/object-projection.js'
import { importExternalObjects } from '../src/with-shape/blobs/import-external.js'

function makeStore(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function bucket(v: string, c: string) {
    let m = store.get(v); if (!m) { m = new Map(); store.set(v, m) }
    let b = m.get(c); if (!b) { b = new Map(); m.set(c, b) }
    return b
  }
  return {
    name: 'memory',
    async get(v, c, id) { return bucket(v, c).get(id) ?? null },
    async put(v, c, id, env, ev) { const b = bucket(v, c); const ex = b.get(id); if (ev !== undefined && (ex?._v ?? 0) !== ev) throw new ConflictError(ex?._v ?? 0); b.set(id, env) },
    async delete(v, c, id) { bucket(v, c).delete(id) },
    async list(v, c) { return [...bucket(v, c).keys()] },
    async loadAll(v) { const m = store.get(v); const s: VaultSnapshot = {}; if (m) for (const [n, c] of m) { const r: Record<string, EncryptedEnvelope> = {}; for (const [id, e] of c) r[id] = e; s[n] = r } return s },
    async saveAll(v, data) { for (const [n, recs] of Object.entries(data)) { const b = bucket(v, n); for (const [id, e] of Object.entries(recs)) b.set(id, e) } },
  }
}

function payload(n: number): Uint8Array {
  const b = new Uint8Array(n)
  for (let i = 0; i < n; i++) b[i] = (i * 13) & 0xff
  return b
}

describe('#412 P3 — external blob fields route to the ObjectProjection', () => {
  it('stores bytes in the projection (not _blob_chunks); record/slot is the catalog', async () => {
    const store = makeStore()
    const objects = memoryObjectProjection({ baseUrl: 'https://cdn.example.com' })
    const db = await createNoydb({ store, user: 'op', secret: 'secret-1234-long-enough', objectStore: objects, blobStrategy: withBlobs() })
    const vault = await db.openVault('t')
    const docs = vault.collection<{ id: string }>('docs', {
      blobFields: { video: { external: true, public: true }, thumb: {} },
    })
    await docs.put('d1', { id: 'd1' })

    const video = payload(3000)
    await docs.blob('d1').put('video', video, { mimeType: 'video/mp4' })

    // bytes live in the projection at a deterministic key, NOT in _blob_chunks
    const key = 'docs/d1/video'
    expect(Buffer.from((await objects.getObject(key))!).equals(Buffer.from(video))).toBe(true)
    expect(await store.list('t', '_blob_chunks')).toEqual([])

    // round-trip through the API
    expect(Buffer.from((await docs.blob('d1').get('video'))!).equals(Buffer.from(video))).toBe(true)

    // public object → stable URL
    expect(await docs.blob('d1').url('video')).toBe('https://cdn.example.com/docs/d1/video')

    // the slot (in the encrypted collection) is the catalog entry — anchoring
    const slots = await docs.blob('d1').list()
    const v = slots.find((s) => s.name === 'video')!
    expect(v.external?.key).toBe(key)
    expect(v.external?.public).toBe(true)
    expect(v.eTag).toBe('')
  })

  it('non-external fields still use the encrypted-chunk path', async () => {
    const store = makeStore()
    const db = await createNoydb({ store, user: 'op', secret: 'secret-1234-long-enough', objectStore: memoryObjectProjection(), blobStrategy: withBlobs() })
    const vault = await db.openVault('t')
    const docs = vault.collection<{ id: string }>('docs', { blobFields: { video: { external: true } } })
    await docs.put('d1', { id: 'd1' })
    await docs.blob('d1').put('thumb', new Uint8Array([1, 2, 3, 4]))
    expect((await store.list('t', '_blob_chunks')).length).toBeGreaterThan(0)
  })

  it('delete hard-removes the external object', async () => {
    const store = makeStore()
    const objects = memoryObjectProjection()
    const db = await createNoydb({ store, user: 'op', secret: 'secret-1234-long-enough', objectStore: objects, blobStrategy: withBlobs() })
    const vault = await db.openVault('t')
    const docs = vault.collection<{ id: string }>('docs', { blobFields: { video: { external: true } } })
    await docs.put('d1', { id: 'd1' })
    await docs.blob('d1').put('video', payload(500))

    const key = 'docs/d1/video'
    expect(await objects.getObject(key)).not.toBeNull()
    await docs.blob('d1').delete('video')
    expect(await objects.getObject(key)).toBeNull()
    expect(await docs.blob('d1').get('video')).toBeNull()
  })

  it('stamps an opaque-token backlink (default) onto the object + records it on the slot', async () => {
    const objects = memoryObjectProjection()
    const db = await createNoydb({ store: makeStore(), user: 'op', secret: 'secret-1234-long-enough', objectStore: objects, blobStrategy: withBlobs() })
    const vault = await db.openVault('t')
    const docs = vault.collection<{ id: string }>('docs', { blobFields: { video: { external: true } } })
    await docs.put('d1', { id: 'd1' })
    await docs.blob('d1').put('video', payload(200))

    const meta = await objects.headObject('docs/d1/video')
    const token = meta?.userMeta?.['noydb-backlink']
    expect(typeof token).toBe('string')
    const slot = (await docs.blob('d1').list()).find((s) => s.name === 'video')!
    expect(slot.external?.backlink).toBe(token) // self-recorded for reconcile
    // opaque-token does not leak the record id
    expect(meta?.userMeta?.['noydb-record']).toBeUndefined()
  })

  it('plain backlink stamps the structure (leaky, opt-in)', async () => {
    const objects = memoryObjectProjection()
    const db = await createNoydb({ store: makeStore(), user: 'op', secret: 'secret-1234-long-enough', objectStore: objects, blobStrategy: withBlobs() })
    const vault = await db.openVault('t')
    const docs = vault.collection<{ id: string }>('docs', { blobFields: { video: { external: true, backlink: 'plain' } } })
    await docs.put('d1', { id: 'd1' })
    await docs.blob('d1').put('video', payload(200))
    const meta = await objects.headObject('docs/d1/video')
    expect(meta?.userMeta).toMatchObject({ 'noydb-collection': 'docs', 'noydb-record': 'd1', 'noydb-field': 'video' })
  })

  it('setExternalMeta / externalMeta round-trip the secondary metadata store', async () => {
    const db = await createNoydb({ store: makeStore(), user: 'op', secret: 'secret-1234-long-enough', objectStore: memoryObjectProjection(), blobStrategy: withBlobs() })
    const vault = await db.openVault('t')
    const docs = vault.collection<{ id: string }>('docs', { blobFields: { video: { external: true } } })
    await docs.put('d1', { id: 'd1' })
    await docs.blob('d1').put('video', payload(200))
    await docs.blob('d1').setExternalMeta('video', { durationSec: 12, width: 1920, height: 1080 })
    expect(await docs.blob('d1').externalMeta('video')).toEqual({ durationSec: 12, width: 1920, height: 1080 })
    // survives re-upload
    await docs.blob('d1').put('video', payload(300))
    expect(await docs.blob('d1').externalMeta('video')).toEqual({ durationSec: 12, width: 1920, height: 1080 })
  })

  it('importExternalObjects builds a collection from existing bucket objects (idempotent)', async () => {
    const objects = memoryObjectProjection()
    await objects.putObject('docs/r1/scan', payload(100), { contentType: 'image/png' })
    await objects.putObject('docs/r2/scan', payload(150), { contentType: 'image/png' })
    await objects.putObject('other/x', payload(10), { contentType: 'text/plain' }) // excluded by the 'docs/' prefix filter

    const db = await createNoydb({ store: makeStore(), user: 'op', secret: 'secret-1234-long-enough', objectStore: objects, blobStrategy: withBlobs() })
    const vault = await db.openVault('t')
    const docs = vault.collection<{ id: string }>('docs', { blobFields: { scan: { external: true } } })

    const res = await importExternalObjects({ collection: docs, objectStore: objects, field: 'scan', options: { prefix: 'docs/' } })
    expect(res.imported).toBe(2)
    expect(res.recordIds.sort()).toEqual(['r1', 'r2'])

    // records exist + the external blob is readable through the anchored slot
    expect(await docs.get('r1')).toEqual({ id: 'r1' })
    expect(Buffer.from((await docs.blob('r1').get('scan'))!).equals(Buffer.from(payload(100)))).toBe(true)

    // idempotent re-run
    const res2 = await importExternalObjects({ collection: docs, objectStore: objects, field: 'scan', options: { prefix: 'docs/' } })
    expect(res2.imported).toBe(2)
    expect(await docs.list()).toHaveLength(2)
  })

  it('url() throws for a non-external slot', async () => {
    const store = makeStore()
    const db = await createNoydb({ store, user: 'op', secret: 'secret-1234-long-enough', objectStore: memoryObjectProjection(), blobStrategy: withBlobs() })
    const vault = await db.openVault('t')
    const docs = vault.collection<{ id: string }>('docs', { blobFields: { thumb: {} } })
    await docs.put('d1', { id: 'd1' })
    await docs.blob('d1').put('thumb', new Uint8Array([1, 2, 3]))
    await expect(docs.blob('d1').url('thumb')).rejects.toThrow(/not external/)
  })
})

describe('#748 — adoptExternal()/setExternalMeta() require a declared external slot', () => {
  it('adoptExternal() throws when the slot is not declared blobFields[slot].external', async () => {
    const db = await createNoydb({ store: makeStore(), user: 'op', secret: 'secret-1234-long-enough', objectStore: memoryObjectProjection(), blobStrategy: withBlobs() })
    const vault = await db.openVault('t')
    // 'scan' is entirely undeclared — no blobFields at all.
    const docs = vault.collection<{ id: string }>('docs', {})
    await docs.put('d1', { id: 'd1' })
    await expect(
      docs.blob('d1').adoptExternal('scan', { key: 'docs/d1/scan' }),
    ).rejects.toThrow(/not declared external/)
  })

  it('adoptExternal() throws when the slot is declared but not external (internal blob field)', async () => {
    const db = await createNoydb({ store: makeStore(), user: 'op', secret: 'secret-1234-long-enough', objectStore: memoryObjectProjection(), blobStrategy: withBlobs() })
    const vault = await db.openVault('t')
    const docs = vault.collection<{ id: string }>('docs', { blobFields: { thumb: {} } })
    await docs.put('d1', { id: 'd1' })
    await expect(
      docs.blob('d1').adoptExternal('thumb', { key: 'docs/d1/thumb' }),
    ).rejects.toThrow(/not declared external/)
  })

  it('adoptExternal() succeeds when the slot IS declared external (positive lock)', async () => {
    const objects = memoryObjectProjection()
    await objects.putObject('docs/r1/scan', payload(100), { contentType: 'image/png' })
    const db = await createNoydb({ store: makeStore(), user: 'op', secret: 'secret-1234-long-enough', objectStore: objects, blobStrategy: withBlobs() })
    const vault = await db.openVault('t')
    const docs = vault.collection<{ id: string }>('docs', { blobFields: { scan: { external: true } } })
    await docs.put('r1', { id: 'r1' })
    await docs.blob('r1').adoptExternal('scan', { key: 'docs/r1/scan', size: 100, contentType: 'image/png' })
    expect(Buffer.from((await docs.blob('r1').get('scan'))!).equals(Buffer.from(payload(100)))).toBe(true)
  })

  it('setExternalMeta() throws when the slot is not declared blobFields[slot].external', async () => {
    const db = await createNoydb({ store: makeStore(), user: 'op', secret: 'secret-1234-long-enough', objectStore: memoryObjectProjection(), blobStrategy: withBlobs() })
    const vault = await db.openVault('t')
    const docs = vault.collection<{ id: string }>('docs', {})
    await docs.put('d1', { id: 'd1' })
    await expect(
      docs.blob('d1').setExternalMeta('scan', { width: 100 }),
    ).rejects.toThrow(/not declared external/)
  })

  it('setExternalMeta() succeeds when the slot IS declared external (positive lock)', async () => {
    const db = await createNoydb({ store: makeStore(), user: 'op', secret: 'secret-1234-long-enough', objectStore: memoryObjectProjection(), blobStrategy: withBlobs() })
    const vault = await db.openVault('t')
    const docs = vault.collection<{ id: string }>('docs', { blobFields: { video: { external: true } } })
    await docs.put('d1', { id: 'd1' })
    await docs.blob('d1').put('video', payload(200))
    await docs.blob('d1').setExternalMeta('video', { durationSec: 12 })
    expect(await docs.blob('d1').externalMeta('video')).toEqual({ durationSec: 12 })
  })
})
