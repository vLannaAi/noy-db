/**
 * #808 — blob offline pinning + mobile cache budget.
 *
 * - `collection.blob(id).pin(slot)` / `unpin(slot)` / `isPinned(slot)`:
 *   device-local pin registry (never written to the vault store), eager
 *   download on pin, eviction exemption inside `vault.compact()`.
 * - `vault.compact({ cacheBudget: { maxBytes } })`: LRU budget pass over
 *   locally-cached UNPINNED blob bytes, routed through the existing
 *   compaction eviction writer.
 * - Offline read taxonomy: pinned → always readable; unpinned+cached →
 *   readable; unpinned+cold+offline → typed `BlobOfflineError`.
 * - External (`external: true`) pins hold a LOCAL ENCRYPTED copy in the
 *   device-local side-cache (ciphertext, never plaintext).
 */
import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { ConflictError, BlobOfflineError, NotFoundError, ValidationError } from '../src/kernel/errors.js'
import { createNoydb } from '../src/kernel/noydb.js'
import { withBlobs, memoryBlobPinStore } from '../src/via/blob/index.js'
import type { ObjectProjection } from '../src/with-shape/blobs/object-projection.js'
import { memoryObjectProjection } from '../src/with-shape/blobs/object-projection.js'

function makeStore(): NoydbStore & { raw: Map<string, Map<string, Map<string, EncryptedEnvelope>>> } {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function bucket(v: string, c: string) {
    let m = store.get(v); if (!m) { m = new Map(); store.set(v, m) }
    let b = m.get(c); if (!b) { b = new Map(); m.set(c, b) }
    return b
  }
  return {
    name: 'memory',
    raw: store,
    async get(v, c, id) { return bucket(v, c).get(id) ?? null },
    async put(v, c, id, env, ev) { const b = bucket(v, c); const ex = b.get(id); if (ev !== undefined && (ex?._v ?? 0) !== ev) throw new ConflictError(ex?._v ?? 0); b.set(id, env) },
    async delete(v, c, id) { bucket(v, c).delete(id) },
    async list(v, c) { return [...bucket(v, c).keys()] },
    async loadAll(v) { const m = store.get(v); const s: VaultSnapshot = {}; if (m) for (const [n, c] of m) { const r: Record<string, EncryptedEnvelope> = {}; for (const [id, e] of c) r[id] = e; s[n] = r } return s },
    async saveAll(v, data) { for (const [n, recs] of Object.entries(data)) { const b = bucket(v, n); for (const [id, e] of Object.entries(recs)) b.set(id, e) } },
  }
}

/** ObjectProjection wrapper with a switchable offline mode (network failure). */
function flakyProjection(): { projection: ObjectProjection; setOffline: (v: boolean) => void; inner: ObjectProjection } {
  const inner = memoryObjectProjection()
  let offline = false
  const fail = (): never => { throw new Error('network unreachable (simulated offline)') }
  const projection: ObjectProjection = {
    name: 'flaky',
    async putObject(k, b, o) { if (offline) fail(); return inner.putObject(k, b, o) },
    async getObject(k) { if (offline) fail(); return inner.getObject(k) },
    async deleteObject(k) { if (offline) fail(); return inner.deleteObject(k) },
    async headObject(k) { if (offline) fail(); return inner.headObject(k) },
    async objectUrl(k, o) { return inner.objectUrl(k, o) },
    async putUrl(k, o) { return inner.putUrl(k, o) },
    async listPrefix(p) { if (offline) fail(); return inner.listPrefix(p) },
  }
  return { projection, setOffline: (v) => { offline = v }, inner }
}

function payload(n: number, seed = 13): Uint8Array {
  const b = new Uint8Array(n)
  for (let i = 0; i < n; i++) b[i] = (i * seed) & 0xff
  return b
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const SECRET = 'secret-1234-long-enough'

describe('#808 — pin surface', () => {
  it('pin/unpin/isPinned round-trip on an internal slot', async () => {
    const store = makeStore()
    const db = await createNoydb({ store, user: 'op', secret: SECRET, blobsStrategy: withBlobs() })
    const vault = await db.openVault('t')
    const docs = vault.collection<{ id: string }>('docs')
    await docs.put('d1', { id: 'd1' })
    await docs.blob('d1').put('scan', payload(300))

    expect(await docs.blob('d1').isPinned('scan')).toBe(false)
    await docs.blob('d1').pin('scan')
    expect(await docs.blob('d1').isPinned('scan')).toBe(true)

    // list() surfaces the device-local pin flag
    const slot = (await docs.blob('d1').list()).find((s) => s.name === 'scan')!
    expect(slot.pinned).toBe(true)

    await docs.blob('d1').unpin('scan')
    expect(await docs.blob('d1').isPinned('scan')).toBe(false)
  })

  it('pin on a missing slot throws NotFoundError', async () => {
    const db = await createNoydb({ store: makeStore(), user: 'op', secret: SECRET, blobsStrategy: withBlobs() })
    const vault = await db.openVault('t')
    const docs = vault.collection<{ id: string }>('docs')
    await docs.put('d1', { id: 'd1' })
    await expect(docs.blob('d1').pin('nope')).rejects.toThrow(NotFoundError)
  })

  it('pin refuses a slot name containing the reserved separator', async () => {
    const db = await createNoydb({ store: makeStore(), user: 'op', secret: SECRET, blobsStrategy: withBlobs() })
    const vault = await db.openVault('t')
    const docs = vault.collection<{ id: string }>('docs')
    await docs.put('d1', { id: 'd1' })
    await expect(docs.blob('d1').pin('a::b')).rejects.toThrow(ValidationError)
  })

  it('unpin of a never-pinned slot is a no-op', async () => {
    const db = await createNoydb({ store: makeStore(), user: 'op', secret: SECRET, blobsStrategy: withBlobs() })
    const vault = await db.openVault('t')
    const docs = vault.collection<{ id: string }>('docs')
    await docs.put('d1', { id: 'd1' })
    await docs.blob('d1').put('scan', payload(10))
    await expect(docs.blob('d1').unpin('scan')).resolves.toBeUndefined()
  })
})

describe('#808 — pin state is device-local, never synced', () => {
  it('a fresh device (same store, new withBlobs()) sees no pins, and the vault store holds no pin state', async () => {
    const store = makeStore()
    const db1 = await createNoydb({ store, user: 'op', secret: SECRET, blobsStrategy: withBlobs() })
    const v1 = await db1.openVault('t')
    const docs1 = v1.collection<{ id: string }>('docs')
    await docs1.put('d1', { id: 'd1' })
    await docs1.blob('d1').put('scan', payload(64))
    await docs1.blob('d1').pin('scan')
    expect(await docs1.blob('d1').isPinned('scan')).toBe(true)

    // No collection in the shared vault store carries pin state.
    const collections = [...(store.raw.get('t')?.keys() ?? [])]
    expect(collections.some((c) => c.toLowerCase().includes('pin'))).toBe(false)

    // A second device over the SAME store sees the slot but not the pin.
    const db2 = await createNoydb({ store, user: 'op', secret: SECRET, blobsStrategy: withBlobs() })
    const v2 = await db2.openVault('t')
    const docs2 = v2.collection<{ id: string }>('docs')
    expect((await docs2.blob('d1').list()).find((s) => s.name === 'scan')).toBeDefined()
    expect(await docs2.blob('d1').isPinned('scan')).toBe(false)
  })
})

describe('#808 — pin survives compact, unpin restores lifecycle', () => {
  it('a pinned slot is exempt from policy eviction; unpin makes it evictable again', async () => {
    const store = makeStore()
    const db = await createNoydb({ store, user: 'op', secret: SECRET, blobsStrategy: withBlobs() })
    const vault = await db.openVault('t')
    const scans = vault.collection<{ id: string; status: string }>('scans', {
      blobFields: { image: { evictWhen: (r) => r.status === 'done' } },
    })
    await scans.put('s1', { id: 's1', status: 'done' })
    await scans.put('s2', { id: 's2', status: 'done' })
    await scans.blob('s1').put('image', payload(100, 3))
    await scans.blob('s2').put('image', payload(100, 5))
    await scans.blob('s1').pin('image')

    const r1 = await vault.compact()
    expect(r1.evicted).toBe(1) // s2 only
    expect(r1.pinned).toBe(1)  // s1 exempted
    expect(await scans.blob('s1').list()).toHaveLength(1)
    expect(await scans.blob('s2').list()).toHaveLength(0)
    expect(await scans.blob('s1').get('image')).not.toBeNull()

    await scans.blob('s1').unpin('image')
    const r2 = await vault.compact()
    expect(r2.evicted).toBe(1)
    expect(r2.pinned).toBe(0)
    expect(await scans.blob('s1').list()).toHaveLength(0)
  })
})

describe('#808 — cache budget (LRU) via vault.compact', () => {
  it('evicts oldest-accessed unpinned internal blobs until under budget', async () => {
    const db = await createNoydb({ store: makeStore(), user: 'op', secret: SECRET, blobsStrategy: withBlobs() })
    const vault = await db.openVault('t')
    const docs = vault.collection<{ id: string }>('docs')
    for (const id of ['r1', 'r2', 'r3']) {
      await docs.put(id, { id })
      await docs.blob(id).put('file', payload(1000, id.charCodeAt(1)))
      await sleep(5)
    }
    // Touch r1 so it is the most recently accessed; r2 becomes the LRU victim.
    await sleep(5)
    await docs.blob('r1').get('file')

    const result = await vault.compact({ cacheBudget: { maxBytes: 2000 } })
    expect(result.budgetEvicted).toBe(1)
    expect(result.budgetBytesFreed).toBe(1000)
    expect(await docs.blob('r2').list()).toHaveLength(0) // oldest access evicted
    expect(await docs.blob('r1').list()).toHaveLength(1)
    expect(await docs.blob('r3').list()).toHaveLength(1)
  })

  it('pinned slots are exempt from the budget (not counted, never evicted)', async () => {
    const db = await createNoydb({ store: makeStore(), user: 'op', secret: SECRET, blobsStrategy: withBlobs() })
    const vault = await db.openVault('t')
    const docs = vault.collection<{ id: string }>('docs')
    for (const id of ['r1', 'r2']) {
      await docs.put(id, { id })
      await docs.blob(id).put('file', payload(1000, id.charCodeAt(1)))
      await sleep(5)
    }
    await docs.blob('r1').pin('file') // r1 is oldest but pinned

    const result = await vault.compact({ cacheBudget: { maxBytes: 1000 } })
    // Unpinned bytes = 1000 (r2 only) → already at budget → nothing evicted.
    expect(result.budgetEvicted).toBe(0)
    expect(await docs.blob('r1').list()).toHaveLength(1)
    expect(await docs.blob('r2').list()).toHaveLength(1)

    // Shrink the budget: only the unpinned r2 may go.
    const result2 = await vault.compact({ cacheBudget: { maxBytes: 500 } })
    expect(result2.budgetEvicted).toBe(1)
    expect(await docs.blob('r1').list()).toHaveLength(1)
    expect(await docs.blob('r2').list()).toHaveLength(0)
  })

  it('budget evictions write audit entries with reason "budget"; dryRun only counts', async () => {
    const store = makeStore()
    const db = await createNoydb({ store, user: 'op', secret: SECRET, blobsStrategy: withBlobs() })
    const vault = await db.openVault('t')
    const docs = vault.collection<{ id: string }>('docs')
    await docs.put('r1', { id: 'r1' })
    await docs.blob('r1').put('file', payload(1000))

    const dry = await vault.compact({ cacheBudget: { maxBytes: 0 }, dryRun: true })
    expect(dry.budgetEvicted).toBe(1)
    expect(await docs.blob('r1').list()).toHaveLength(1) // untouched

    const wet = await vault.compact({ cacheBudget: { maxBytes: 0 } })
    expect(wet.budgetEvicted).toBe(1)
    expect(wet.auditEntries).toBe(1)
    expect(await docs.blob('r1').list()).toHaveLength(0)
    expect((await store.list('t', '_blob_eviction_audit')).length).toBe(1)
  })

  it('refuses a negative or non-finite maxBytes', async () => {
    const db = await createNoydb({ store: makeStore(), user: 'op', secret: SECRET, blobsStrategy: withBlobs() })
    const vault = await db.openVault('t')
    await expect(vault.compact({ cacheBudget: { maxBytes: -1 } })).rejects.toThrow(ValidationError)
    await expect(vault.compact({ cacheBudget: { maxBytes: Number.NaN } })).rejects.toThrow(ValidationError)
  })

  it('drops an unpinned external side-cache copy without touching the slot or the remote object', async () => {
    const { projection, setOffline } = flakyProjection()
    const db = await createNoydb({ store: makeStore(), user: 'op', secret: SECRET, objectStore: projection, blobsStrategy: withBlobs() })
    const vault = await db.openVault('t')
    const docs = vault.collection<{ id: string }>('docs', { blobFields: { video: { external: true } } })
    await docs.put('d1', { id: 'd1' })
    const bytes = payload(2048)
    await docs.blob('d1').put('video', bytes)

    await docs.blob('d1').pin('video')   // caches an encrypted local copy
    await docs.blob('d1').unpin('video') // copy stays, now budget-managed

    const result = await vault.compact({ cacheBudget: { maxBytes: 0 } })
    expect(result.budgetEvicted).toBe(1)
    expect(result.budgetBytesFreed).toBe(2048)

    // Slot + remote object survive — only the local cached copy was dropped.
    expect((await docs.blob('d1').list()).find((s) => s.name === 'video')).toBeDefined()
    setOffline(true)
    await expect(docs.blob('d1').get('video')).rejects.toThrow(BlobOfflineError)
    setOffline(false)
    expect(Buffer.from((await docs.blob('d1').get('video'))!).equals(Buffer.from(bytes))).toBe(true)
  })
})

describe('#808 — offline read taxonomy', () => {
  it('external: pinned → readable offline; cached → readable offline; cold → BlobOfflineError', async () => {
    const { projection, setOffline } = flakyProjection()
    const db = await createNoydb({ store: makeStore(), user: 'op', secret: SECRET, objectStore: projection, blobsStrategy: withBlobs() })
    const vault = await db.openVault('t')
    const docs = vault.collection<{ id: string }>('docs', {
      blobFields: { a: { external: true }, b: { external: true }, c: { external: true } },
    })
    await docs.put('d1', { id: 'd1' })
    const bytesA = payload(400, 3)
    const bytesB = payload(400, 5)
    await docs.blob('d1').put('a', bytesA)
    await docs.blob('d1').put('b', bytesB)
    await docs.blob('d1').put('c', payload(400, 7))

    await docs.blob('d1').pin('a')       // pinned
    await docs.blob('d1').get('b')       // unpinned but cached by the read

    setOffline(true)
    expect(Buffer.from((await docs.blob('d1').get('a'))!).equals(Buffer.from(bytesA))).toBe(true)
    expect(Buffer.from((await docs.blob('d1').get('b'))!).equals(Buffer.from(bytesB))).toBe(true)
    const err = await docs.blob('d1').get('c').then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(BlobOfflineError)
    expect((err as BlobOfflineError).code).toBe('BLOB_OFFLINE')
    expect((err as BlobOfflineError).collection).toBe('docs')
    expect((err as BlobOfflineError).recordId).toBe('d1')
    expect((err as BlobOfflineError).slotName).toBe('c')
  })

  it('external: a deleted remote object (online) is null, not BlobOfflineError', async () => {
    const { projection, inner } = flakyProjection()
    const db = await createNoydb({ store: makeStore(), user: 'op', secret: SECRET, objectStore: projection, blobsStrategy: withBlobs() })
    const vault = await db.openVault('t')
    const docs = vault.collection<{ id: string }>('docs', { blobFields: { a: { external: true } } })
    await docs.put('d1', { id: 'd1' })
    await docs.blob('d1').put('a', payload(64))
    await inner.deleteObject('docs/d1/a')
    expect(await docs.blob('d1').get('a')).toBeNull()
  })

  it('internal: locally-present chunks are readable; missing chunks surface BlobOfflineError', async () => {
    const store = makeStore()
    const db = await createNoydb({ store, user: 'op', secret: SECRET, blobsStrategy: withBlobs() })
    const vault = await db.openVault('t')
    const docs = vault.collection<{ id: string }>('docs')
    await docs.put('d1', { id: 'd1' })
    const bytes = payload(500)
    await docs.blob('d1').put('file', bytes)
    expect(Buffer.from((await docs.blob('d1').get('file'))!).equals(Buffer.from(bytes))).toBe(true)

    // Simulate a cold local store (chunk not yet synced to this device).
    for (const id of await store.list('t', '_blob_chunks')) {
      await store.delete('t', '_blob_chunks', id)
    }
    await expect(docs.blob('d1').get('file')).rejects.toThrow(BlobOfflineError)
  })
})

describe('#808 — external pin: local copy is encrypted', () => {
  it('the side-cache holds ciphertext under the vault keys, never plaintext', async () => {
    const pinStore = memoryBlobPinStore()
    const { projection } = flakyProjection()
    const db = await createNoydb({
      store: makeStore(), user: 'op', secret: SECRET,
      objectStore: projection, blobsStrategy: withBlobs({ pinStore }),
    })
    const vault = await db.openVault('t')
    const docs = vault.collection<{ id: string }>('docs', { blobFields: { doc: { external: true } } })
    await docs.put('d1', { id: 'd1' })
    const plaintext = new TextEncoder().encode('TOP-SECRET-PAYLOAD-'.repeat(40))
    await docs.blob('d1').put('doc', plaintext)
    await docs.blob('d1').pin('doc')

    const entries = await pinStore.entries('')
    expect(entries.length).toBe(1)
    const entry = entries[0]!.entry
    expect(entry.pinned).toBe(true)
    expect(entry.cachedBytes).toBe(plaintext.byteLength)
    expect(entry.cipher).toBeDefined()
    expect(entry.cipher!.iv).not.toBe('') // encrypted, not the plaintext-vault fallback

    // Neither the base64 blob nor its decoded bytes contain the plaintext.
    expect(entry.cipher!.data).not.toContain('TOP-SECRET-PAYLOAD-')
    const decoded = Buffer.from(entry.cipher!.data, 'base64').toString('latin1')
    expect(decoded).not.toContain('TOP-SECRET-PAYLOAD-')
    expect(JSON.stringify(entries)).not.toContain('TOP-SECRET-PAYLOAD-')
  })
})

describe('#808 — KPI counters', () => {
  it('counts external hits/misses and bytes downloaded', async () => {
    const strategy = withBlobs()
    const { projection, setOffline } = flakyProjection()
    const db = await createNoydb({ store: makeStore(), user: 'op', secret: SECRET, objectStore: projection, blobsStrategy: strategy })
    const vault = await db.openVault('t')
    const docs = vault.collection<{ id: string }>('docs', { blobFields: { a: { external: true } } })
    await docs.put('d1', { id: 'd1' })
    await docs.blob('d1').put('a', payload(700))

    expect(strategy.cacheStats()).toEqual({ hits: 0, misses: 0, bytesDownloaded: 0 })

    await docs.blob('d1').get('a') // cold → network fetch (miss) + auto-cache
    let stats = strategy.cacheStats()
    expect(stats.misses).toBe(1)
    expect(stats.hits).toBe(0)
    expect(stats.bytesDownloaded).toBe(700)

    setOffline(true)
    await docs.blob('d1').get('a') // cached → hit, no download
    stats = strategy.cacheStats()
    expect(stats.misses).toBe(1)
    expect(stats.hits).toBe(1)
    expect(stats.bytesDownloaded).toBe(700)
  })

  it('counts internal local reads as hits; pin() of an external slot counts its eager download', async () => {
    const strategy = withBlobs()
    const { projection } = flakyProjection()
    const db = await createNoydb({ store: makeStore(), user: 'op', secret: SECRET, objectStore: projection, blobsStrategy: strategy })
    const vault = await db.openVault('t')
    const docs = vault.collection<{ id: string }>('docs', { blobFields: { ext: { external: true } } })
    await docs.put('d1', { id: 'd1' })
    await docs.blob('d1').put('file', payload(100))
    await docs.blob('d1').put('ext', payload(900))

    await docs.blob('d1').get('file')
    expect(strategy.cacheStats().hits).toBe(1)

    await docs.blob('d1').pin('ext') // eager download
    const stats = strategy.cacheStats()
    expect(stats.bytesDownloaded).toBe(900)
    expect(stats.misses).toBe(1)
  })
})
