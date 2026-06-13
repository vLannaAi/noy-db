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
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/types.js'
import { ConflictError } from '../src/errors.js'
import { createNoydb } from '../src/noydb.js'
import { withBlobs } from '../src/blobs/index.js'
import { BLOB_INDEX_COLLECTION, BLOB_CHUNKS_COLLECTION } from '../src/blobs/blob-set.js'

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
