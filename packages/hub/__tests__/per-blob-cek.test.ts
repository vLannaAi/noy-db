/**
 * Per-blob content-encryption key (CEK) — slice 1: the content-CEK write/read
 * path on erasable (`perRecordKeys`) collections (#365).
 *
 * Pins the foundation contract before the forget()/refCount-0 shred wiring
 * (slice 2): erasable blobs encrypt chunks under a per-blob content CEK whose
 * only recoverable copy is the BlobObject's wrapped `_cek`; dedup is preserved;
 * legacy (non-erasable) blobs are byte-for-byte unchanged (no `_cek`); and
 * deleting the BlobObject (the refCount-0 shred primitive) renders the blob
 * unrecoverable. See docs/superpowers/specs/2026-06-13-per-blob-cek-design.md.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { ConflictError } from '../src/kernel/errors.js'
import { createNoydb } from '../src/noydb.js'
import { withBlobs } from '../src/with-shape/blobs/index.js'
import { withHistory } from '../src/with-commit/history/index.js'
import { withForgetCascade } from '../src/with-audit/forget/index.js'
import { BLOB_INDEX_COLLECTION, BLOB_CHUNKS_COLLECTION } from '../src/with-shape/blobs/blob-set.js'

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

const VAULT = 'v'
const SECRET = 'correct-horse-battery-staple-long-enough'
const bytes = (s: string) => new TextEncoder().encode(s)

describe('per-blob CEK (slice 1: content-CEK write/read path)', () => {
  let store: NoydbStore
  beforeEach(() => { store = makeStore() })

  it('erasable collection: blob round-trips and the BlobObject carries a wrapped _cek', async () => {
    const db = await createNoydb({ store, user: 'a', secret: SECRET, blobStrategy: withBlobs() })
    const vault = await db.openVault(VAULT)
    const invoices = vault.collection<{ ref: string }>('invoices', { perRecordKeys: true })
    await invoices.put('inv-1', { ref: 'A' })

    const slot = invoices.blob('inv-1')
    await slot.put('receipt.pdf', bytes('sensitive subject data'))

    expect(new TextDecoder().decode((await slot.get('receipt.pdf'))!)).toBe('sensitive subject data')
    const info = await slot.blobInfo('receipt.pdf')
    expect(info!._cek).toBeDefined() // chunks are under the per-blob content CEK
    db.close()
  })

  it('legacy (non-erasable) collection: blob round-trips with NO _cek (byte-for-byte unchanged)', async () => {
    const db = await createNoydb({ store, user: 'a', secret: SECRET, blobStrategy: withBlobs() })
    const vault = await db.openVault(VAULT)
    const invoices = vault.collection<{ ref: string }>('invoices')
    await invoices.put('inv-1', { ref: 'A' })

    const slot = invoices.blob('inv-1')
    await slot.put('receipt.pdf', bytes('ordinary attachment'))

    expect(new TextDecoder().decode((await slot.get('receipt.pdf'))!)).toBe('ordinary attachment')
    const info = await slot.blobInfo('receipt.pdf')
    expect(info!._cek).toBeUndefined()
    db.close()
  })

  it('dedup preserved on erasable: identical content shares one chunk set + one content CEK, refCount 2', async () => {
    const db = await createNoydb({ store, user: 'a', secret: SECRET, blobStrategy: withBlobs() })
    const vault = await db.openVault(VAULT)
    const docs = vault.collection<{ ref: string }>('docs', { perRecordKeys: true })
    await docs.put('d-1', { ref: 'A' })
    await docs.put('d-2', { ref: 'B' })

    const content = bytes('shared content across two subjects')
    await docs.blob('d-1').put('f.bin', content)
    await docs.blob('d-2').put('f.bin', content)

    const a = await docs.blob('d-1').blobInfo('f.bin')
    const b = await docs.blob('d-2').blobInfo('f.bin')
    expect(a!.eTag).toBe(b!.eTag)        // same content → same dedup address
    expect(a!._cek).toBe(b!._cek)        // same shared content CEK (one BlobObject)
    expect(a!.refCount).toBe(2)
    // one physical chunk set
    const chunkIds = await store.list(VAULT, BLOB_CHUNKS_COLLECTION)
    expect(new Set(chunkIds.map((id) => id.slice(0, 64))).size).toBe(1)
    // both decrypt the same plaintext
    expect(new TextDecoder().decode((await docs.blob('d-1').get('f.bin'))!)).toBe('shared content across two subjects')
    expect(new TextDecoder().decode((await docs.blob('d-2').get('f.bin'))!)).toBe('shared content across two subjects')
    db.close()
  })

  it('shred primitive: deleting the BlobObject renders an erasable blob unrecoverable', async () => {
    const db = await createNoydb({ store, user: 'a', secret: SECRET, blobStrategy: withBlobs() })
    const vault = await db.openVault(VAULT)
    const docs = vault.collection<{ ref: string }>('docs', { perRecordKeys: true })
    await docs.put('d-1', { ref: 'A' })

    const slot = docs.blob('d-1')
    await slot.put('f.bin', bytes('to be shredded'))
    const eTag = (await slot.blobInfo('f.bin'))!.eTag

    // Simulate the refCount-0 crypto-shred: drop the BlobObject (sole holder of
    // the wrapped content CEK). The chunk bytes may linger, but without the CEK
    // they are permanently undecryptable → get() yields null.
    await store.delete(VAULT, BLOB_INDEX_COLLECTION, eTag)

    expect(await slot.get('f.bin')).toBeNull()
    db.close()
  })
})

describe('per-blob CEK (slice 2: forget() crypto-shred)', () => {
  let store: NoydbStore
  beforeEach(() => { store = makeStore() })

  type Inv = { id: string; buyerId: string }
  const setup = () => createNoydb({
    store, user: 'a', secret: SECRET,
    blobStrategy: withBlobs(),
    historyStrategy: withHistory(),
    forgetStrategy: withForgetCascade({ subjects: { invoices: 'buyerId' } }),
  })

  it('forget() crypto-shreds a subject-exclusive blob (refCount 0) and reports it', async () => {
    const db = await setup()
    const vault = await db.openVault(VAULT)
    const invoices = vault.collection<Inv>('invoices') // forced perRecordKeys by cascade
    await invoices.put('i-1', { id: 'i-1', buyerId: 'buyer-1' })
    await invoices.blob('i-1').put('contract.pdf', bytes('buyer-1 personal data'))
    const eTag = (await invoices.blob('i-1').blobInfo('contract.pdf'))!.eTag

    const result = await vault.forget('buyer-1')

    expect(result.blobsShredded).toBe(1)
    expect(result.blobsRetainedShared).toBe(0)
    expect(result.blobResidueCollections).toEqual([]) // gap closed
    // BlobObject + chunks gone; slot map severed.
    expect(await store.get(VAULT, BLOB_INDEX_COLLECTION, eTag)).toBeNull()
    expect(await store.list(VAULT, BLOB_CHUNKS_COLLECTION)).toEqual([])
    db.close()
  })

  it('forget() retains a blob still shared by another subject, shreds it when the last owner is forgotten', async () => {
    const db = await setup()
    const vault = await db.openVault(VAULT)
    const invoices = vault.collection<Inv>('invoices')
    await invoices.put('i-1', { id: 'i-1', buyerId: 'buyer-1' })
    await invoices.put('i-2', { id: 'i-2', buyerId: 'buyer-2' })
    const shared = bytes('identical shared attachment')
    await invoices.blob('i-1').put('f.pdf', shared)
    await invoices.blob('i-2').put('f.pdf', shared)
    const eTag = (await invoices.blob('i-1').blobInfo('f.pdf'))!.eTag

    // Forget buyer-1: content is still buyer-2's → retained, not shredded.
    const r1 = await vault.forget('buyer-1')
    expect(r1.blobsRetainedShared).toBe(1)
    expect(r1.blobsShredded).toBe(0)
    expect(await store.get(VAULT, BLOB_INDEX_COLLECTION, eTag)).not.toBeNull()
    expect(new TextDecoder().decode((await invoices.blob('i-2').get('f.pdf'))!))
      .toBe('identical shared attachment') // buyer-2 still reads it

    // Forget buyer-2 (last owner) → crypto-shred.
    const r2 = await vault.forget('buyer-2')
    expect(r2.blobsShredded).toBe(1)
    expect(await store.get(VAULT, BLOB_INDEX_COLLECTION, eTag)).toBeNull()
    db.close()
  })
})

describe('per-blob CEK (slice 3: migration of legacy blobs)', () => {
  let store: NoydbStore
  beforeEach(() => { store = makeStore() })

  it('migrate() re-keys a legacy blob to a content CEK, preserving readability', async () => {
    const db = await createNoydb({ store, user: 'a', secret: SECRET, blobStrategy: withBlobs() })
    const vault = await db.openVault(VAULT)
    const docs = vault.collection<{ id: string }>('docs') // legacy: no perRecordKeys
    await docs.put('d-1', { id: 'd-1' })
    await docs.blob('d-1').put('f.bin', bytes('legacy attachment bytes'))
    expect((await docs.blob('d-1').blobInfo('f.bin'))!._cek).toBeUndefined()

    const r = await docs.blob('d-1').migrate()
    expect(r.migrated).toHaveLength(1)
    // Now erasable, and still decrypts to the same bytes.
    expect((await docs.blob('d-1').blobInfo('f.bin'))!._cek).toBeDefined()
    expect(new TextDecoder().decode((await docs.blob('d-1').get('f.bin'))!)).toBe('legacy attachment bytes')
    db.close()
  })

  it('migrate() is idempotent — a second pass reports already-erasable, no change', async () => {
    const db = await createNoydb({ store, user: 'a', secret: SECRET, blobStrategy: withBlobs() })
    const vault = await db.openVault(VAULT)
    const docs = vault.collection<{ id: string }>('docs')
    await docs.put('d-1', { id: 'd-1' })
    await docs.blob('d-1').put('f.bin', bytes('x'))

    await docs.blob('d-1').migrate()
    const cek1 = (await docs.blob('d-1').blobInfo('f.bin'))!._cek
    const r2 = await docs.blob('d-1').migrate()
    expect(r2.migrated).toEqual([])
    expect(r2.alreadyErasable).toHaveLength(1)
    expect((await docs.blob('d-1').blobInfo('f.bin'))!._cek).toBe(cek1) // unchanged
    db.close()
  })

  it('a migrated legacy blob becomes crypto-shreddable by forget() (cross-session adoption)', async () => {
    // Session 1: plain collection, legacy blob (no _cek).
    const db1 = await createNoydb({ store, user: 'a', secret: SECRET, blobStrategy: withBlobs() })
    const v1 = await db1.openVault(VAULT)
    const c1 = v1.collection<{ id: string; sub: string }>('docs')
    await c1.put('d-1', { id: 'd-1', sub: 'subj-1' })
    await c1.blob('d-1').put('f.bin', bytes('pre-adoption data'))
    db1.close()

    // Session 2: same store, now with forget cascade (forces perRecordKeys).
    const db2 = await createNoydb({
      store, user: 'a', secret: SECRET, blobStrategy: withBlobs(),
      historyStrategy: withHistory(),
      forgetStrategy: withForgetCascade({ subjects: { docs: 'sub' } }),
    })
    const v2 = await db2.openVault(VAULT)
    const c2 = v2.collection<{ id: string; sub: string }>('docs')
    const eTag = (await c2.blob('d-1').blobInfo('f.bin'))!.eTag

    // Adopting the cascade on existing data: rebuild the subject index so the
    // pre-adoption record is discoverable by forget().
    await v2.rebuildSubjectIndex()

    // After migration the legacy blob is crypto-shreddable (before, it would be
    // reported as residue).
    await c2.blob('d-1').migrate()
    const result = await v2.forget('subj-1')
    expect(result.blobsShredded).toBe(1)
    expect(result.blobResidueCollections).toEqual([])
    expect(await store.get(VAULT, BLOB_INDEX_COLLECTION, eTag)).toBeNull()
    db2.close()
  })
})

describe('per-blob CEK (slice 4: eager shred on delete / compaction path)', () => {
  let store: NoydbStore
  beforeEach(() => { store = makeStore() })

  it('delete() crypto-shreds an erasable blob at refCount 0 (covers compaction eviction)', async () => {
    const db = await createNoydb({ store, user: 'a', secret: SECRET, blobStrategy: withBlobs() })
    const vault = await db.openVault(VAULT)
    const docs = vault.collection<{ id: string }>('docs', { perRecordKeys: true })
    await docs.put('d-1', { id: 'd-1' })
    await docs.blob('d-1').put('f.bin', bytes('erasable, single ref'))
    const eTag = (await docs.blob('d-1').blobInfo('f.bin'))!.eTag

    await docs.blob('d-1').delete('f.bin')

    // BlobObject + chunks gone — the wrapped content CEK is unrecoverable.
    expect(await store.get(VAULT, BLOB_INDEX_COLLECTION, eTag)).toBeNull()
    expect(await store.list(VAULT, BLOB_CHUNKS_COLLECTION)).toEqual([])
    db.close()
  })

  it('delete() retains a shared erasable blob (refCount > 0) — other owner still reads it', async () => {
    const db = await createNoydb({ store, user: 'a', secret: SECRET, blobStrategy: withBlobs() })
    const vault = await db.openVault(VAULT)
    const docs = vault.collection<{ id: string }>('docs', { perRecordKeys: true })
    await docs.put('d-1', { id: 'd-1' })
    await docs.put('d-2', { id: 'd-2' })
    const shared = bytes('shared erasable content')
    await docs.blob('d-1').put('f.bin', shared)
    await docs.blob('d-2').put('f.bin', shared)
    const eTag = (await docs.blob('d-1').blobInfo('f.bin'))!.eTag

    await docs.blob('d-1').delete('f.bin')

    expect(await store.get(VAULT, BLOB_INDEX_COLLECTION, eTag)).not.toBeNull()
    expect(new TextDecoder().decode((await docs.blob('d-2').get('f.bin'))!)).toBe('shared erasable content')
    db.close()
  })

  it('delete() does NOT eager-delete a legacy blob — defers to GC / orphan retention', async () => {
    const db = await createNoydb({ store, user: 'a', secret: SECRET, blobStrategy: withBlobs() })
    const vault = await db.openVault(VAULT)
    const docs = vault.collection<{ id: string }>('docs') // legacy: no _cek
    await docs.put('d-1', { id: 'd-1' })
    await docs.blob('d-1').put('f.bin', bytes('legacy attachment'))
    const eTag = (await docs.blob('d-1').blobInfo('f.bin'))!.eTag

    await docs.blob('d-1').delete('f.bin')

    // refCount 0, but a legacy blob is left for deferred GC (retention preserved).
    const idx = await store.get(VAULT, BLOB_INDEX_COLLECTION, eTag)
    expect(idx).not.toBeNull()
    expect(await store.list(VAULT, BLOB_CHUNKS_COLLECTION)).not.toEqual([])
    db.close()
  })
})
