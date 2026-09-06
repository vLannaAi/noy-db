/**
 * #1451 — `collection.delete(id)` releases the record's blob references.
 *
 * Measured: every release verb reclaimed correctly on an erasable collection
 * — overwrite, slot `delete()`, `forget()` — except the one a consumer means
 * by "delete". `workers.delete(id)` left the record's photographed national
 * ID card fully readable through `blob(id).get(slot)`, listed by `list()`,
 * with no error and nothing saying the delete was partial.
 *
 * The cascade is SAFE because refs are counted: releasing THIS record's slot
 * references drops content only when nothing else holds it. A blob shared by
 * two records (dedup by eTag) survives the deletion of one — pinned below,
 * because a cascade that destroyed shared content would be worse than the
 * leak it replaces.
 *
 * Legacy (non-`perRecordKeys`) blobs release their reference the same way and
 * keep the documented deferred-GC posture: refCount → 0, chunks retained until
 * a reclaim pass (#1453) — but the SLOT is gone, so nothing reads them through
 * the record any more.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { withBlobs } from '../src/via/blob/index.js'
import { BLOB_INDEX_COLLECTION, BLOB_CHUNKS_COLLECTION } from '../src/with-shape/blobs/blob-set.js'
import { makeStore, bytes } from './_blob-issues-store.js'

const SECRET = 'issue-1451-delete-releases-blobs'

async function vaultWith(perRecordKeys: boolean) {
  const store = makeStore()
  const db = await createNoydb({ store, user: 'a', secret: SECRET, blobsStrategy: withBlobs() })
  const vault = await db.openVault('V')
  const workers = vault.collection<{ id: string; name: string }>('workers', perRecordKeys ? { perRecordKeys: true } : {})
  return { store, vault, workers }
}

describe('#1451 — erasable collection (perRecordKeys)', () => {
  it('after the record is deleted, its blob is neither listed nor readable and the chunks are gone', async () => {
    const { store, workers } = await vaultWith(true)
    await workers.put('w1', { id: 'w1', name: 'A' })
    await workers.blob('w1').put('idCard', bytes(300_000))
    expect((await store.list('V', BLOB_CHUNKS_COLLECTION)).length).toBeGreaterThan(0)

    await workers.delete('w1')

    expect(await workers.blob('w1').list()).toEqual([])
    expect(await workers.blob('w1').get('idCard')).toBeNull()
    expect(await store.list('V', BLOB_CHUNKS_COLLECTION)).toEqual([])
    expect(await store.list('V', BLOB_INDEX_COLLECTION)).toEqual([])
  })

  it('shared content survives the deletion of ONE of its holders', async () => {
    const { workers } = await vaultWith(true)
    await workers.put('w1', { id: 'w1', name: 'A' })
    await workers.put('w2', { id: 'w2', name: 'B' })
    const same = bytes(50_000, 7)
    await workers.blob('w1').put('idCard', same)
    await workers.blob('w2').put('idCard', same) // dedup: one eTag, refCount 2

    await workers.delete('w1')

    expect(await workers.blob('w1').get('idCard')).toBeNull()
    expect(await workers.blob('w2').get('idCard')).toEqual(same)
  })

  it('a record with no blobs deletes exactly as before', async () => {
    const { workers } = await vaultWith(true)
    await workers.put('w1', { id: 'w1', name: 'A' })
    await expect(workers.delete('w1')).resolves.toBeUndefined()
    expect(await workers.get('w1')).toBeNull()
  })
})

describe('#1451 — legacy collection (no perRecordKeys)', () => {
  it('the slot is released — nothing reads the bytes through the record any more', async () => {
    const { workers } = await vaultWith(false)
    await workers.put('w1', { id: 'w1', name: 'A' })
    await workers.blob('w1').put('idCard', bytes(10_000))
    await workers.delete('w1')
    expect(await workers.blob('w1').list()).toEqual([])
    expect(await workers.blob('w1').get('idCard')).toBeNull()
  })
})
