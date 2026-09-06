/**
 * #1453 — legacy blobs have a reclaim path, `compact()` can see them, and no
 * docstring names a method that does not exist.
 *
 * A blob written without `perRecordKeys` carries no `_cek`, so at refCount 0
 * `releaseRef` leaves its chunks "for deferred GC". Measured: the deferred GC
 * had no verb — `reclaimLegacy` fired only through `forget()`, which needs
 * `withForget` — and `vault.compact()` reported `orphanBlobChunks: { chunks: 0 }`
 * over a vault whose blob storage grew on every overwrite, because its
 * definition of orphan is "a chunk with no index row" and these keep theirs.
 *
 * The decision here: a legacy index row with `refCount <= 0` is a fact the
 * hub established from AAD-bound content it decrypted itself — NOT from the
 * store's `list()` — so acting on it does not have the withholding hazard
 * that keeps `orphanBlobChunks` report-only. `compact()` now counts them
 * always and reclaims them on request.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createNoydb } from '../src/kernel/noydb.js'
import { withBlobs } from '../src/via/blob/index.js'
import { BLOB_INDEX_COLLECTION, BLOB_CHUNKS_COLLECTION } from '../src/with-shape/blobs/blob-set.js'
import { makeStore, bytes } from './_blob-issues-store.js'

const SECRET = 'issue-1453-legacy-blob-reclaim'

async function legacyVault() {
  const store = makeStore()
  const db = await createNoydb({ store, user: 'a', secret: SECRET, blobsStrategy: withBlobs() })
  const vault = await db.openVault('V')
  const docs = vault.collection<{ id: string }>('docs') // no perRecordKeys → legacy blobs
  await docs.put('d1', { id: 'd1' })
  return { store, vault, docs }
}

describe('#1453 — compact() sees unreferenced legacy blobs', () => {
  it('an overwritten legacy blob is reported, and orphanBlobChunks stays 0 (it is not that class)', async () => {
    const { store, vault, docs } = await legacyVault()
    await docs.blob('d1').put('f', bytes(300_000, 1))
    const chunksBefore = (await store.list('V', BLOB_CHUNKS_COLLECTION)).length
    await docs.blob('d1').put('f', bytes(10_000, 2)) // v1 → refCount 0, chunks retained
    expect((await store.list('V', BLOB_CHUNKS_COLLECTION)).length).toBe(chunksBefore + 1)

    const report = await vault.compact()
    expect(report.orphanBlobChunks.chunks).toBe(0)
    expect(report.unreferencedLegacyBlobs).toEqual({ blobs: 1, chunks: chunksBefore, reclaimed: 0 })
  })

  it('a clean vault reports zero', async () => {
    const { vault, docs } = await legacyVault()
    await docs.blob('d1').put('f', bytes(1_000))
    expect((await vault.compact()).unreferencedLegacyBlobs).toEqual({ blobs: 0, chunks: 0, reclaimed: 0 })
  })
})

describe('#1453 — the reclaim verb', () => {
  it('compact({ reclaimLegacyBlobs: true }) deletes chunks then index for refCount-0 legacy rows, and nothing else', async () => {
    const { store, vault, docs } = await legacyVault()
    await docs.blob('d1').put('f', bytes(300_000, 1))
    await docs.blob('d1').put('f', bytes(10_000, 2))   // v1 unreferenced
    await docs.blob('d1').put('g', bytes(20_000, 3))   // live

    const r = await vault.compact({ reclaimLegacyBlobs: true })
    expect(r.unreferencedLegacyBlobs.blobs).toBe(1)
    expect(r.unreferencedLegacyBlobs.reclaimed).toBe(1)

    expect((await store.list('V', BLOB_INDEX_COLLECTION)).length).toBe(2) // f(v2), g
    expect((await store.list('V', BLOB_CHUNKS_COLLECTION)).length).toBe(2) // one chunk each
    expect(await docs.blob('d1').get('f')).toEqual(bytes(10_000, 2))
    expect(await docs.blob('d1').get('g')).toEqual(bytes(20_000, 3))
    expect((await vault.compact()).unreferencedLegacyBlobs).toEqual({ blobs: 0, chunks: 0, reclaimed: 0 })
  })

  it('dryRun counts but reclaims nothing', async () => {
    const { store, vault, docs } = await legacyVault()
    await docs.blob('d1').put('f', bytes(1_000, 1))
    await docs.blob('d1').put('f', bytes(1_000, 2))
    const r = await vault.compact({ reclaimLegacyBlobs: true, dryRun: true })
    expect(r.unreferencedLegacyBlobs).toEqual({ blobs: 1, chunks: 1, reclaimed: 0 })
    expect((await store.list('V', BLOB_INDEX_COLLECTION)).length).toBe(2)
  })

  it('an erasable (perRecordKeys) vault has nothing for it to do — shred is eager there', async () => {
    const store = makeStore()
    const db = await createNoydb({ store, user: 'a', secret: SECRET, blobsStrategy: withBlobs() })
    const vault = await db.openVault('V')
    const docs = vault.collection<{ id: string }>('docs', { perRecordKeys: true })
    await docs.put('d1', { id: 'd1' })
    await docs.blob('d1').put('f', bytes(1_000, 1))
    await docs.blob('d1').put('f', bytes(1_000, 2))
    expect((await vault.compact({ reclaimLegacyBlobs: true })).unreferencedLegacyBlobs).toEqual({ blobs: 0, chunks: 0, reclaimed: 0 })
  })
})

describe('#1453 — the docstring names a real method', () => {
  it('nothing in the blob subsystem points at vault.blobGC()', () => {
    const src = readFileSync(fileURLToPath(new URL('../src/with-shape/blobs/blob-set.ts', import.meta.url)), 'utf8')
    expect(src).not.toMatch(/blobGC/)
  })
})
