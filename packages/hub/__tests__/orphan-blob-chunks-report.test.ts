/**
 * #1133 — reporting chunk rows that outlived their index row.
 *
 * #1127 stopped PRODUCING these by deleting chunks before the index. This is the
 * read-only report for the ones already in the wild, and the tests below pin the
 * two properties that matter: it finds real residue, and it never deletes.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { memoryStore } from '../src/index.js'
import { withBlobs } from '../src/via/blob/index.js'
import { reportOrphanBlobChunks } from '../src/with-shape/blobs/orphan-report.js'
import { BLOB_INDEX_COLLECTION, BLOB_CHUNKS_COLLECTION, DEFAULT_CHUNK_SIZE } from '../src/with-shape/blobs/blob-set.js'
import type { NoydbStore } from '../src/kernel/types.js'

const VAULT = 'acme'
const SECRET = 'owner-pass-correct-horse-battery-staple'

async function seeded(): Promise<{ store: NoydbStore; vault: Awaited<ReturnType<Awaited<ReturnType<typeof createNoydb>>['openVault']>> }> {
  const store = memoryStore()
  const db = await createNoydb({ blobsStrategy: withBlobs(), store, user: 'owner', secret: SECRET })
  const vault = await db.openVault(VAULT)
  const invoices = vault.collection<{ ref: string }>('invoices')
  await invoices.put('inv-1', { ref: 'A' })
  await invoices.put('inv-2', { ref: 'B' })
  // A multi-chunk blob, so an orphaned eTag contributes more than one row and
  // the chunk count and the eTag count are distinguishable.
  const big = new Uint8Array(DEFAULT_CHUNK_SIZE * 2 + 1024)
  for (let off = 0; off < big.length; off += 65536) {
    globalThis.crypto.getRandomValues(big.subarray(off, Math.min(off + 65536, big.length)))
  }
  await invoices.blob('inv-1').put('big.bin', big)
  await invoices.blob('inv-2').put('readme.txt', new TextEncoder().encode('hello blob'))
  return { store, vault }
}

describe('#1133 — orphan blob-chunk report', () => {
  it('reports nothing on a healthy vault', async () => {
    const { store } = await seeded()
    expect(await reportOrphanBlobChunks(store, VAULT))
      .toEqual({ chunks: 0, eTags: 0, sampleETags: [], unparseable: 0 })
  })

  it('counts the chunks and the eTags of an index row deleted out from under them', async () => {
    const { store } = await seeded()
    const eTags = await store.list(VAULT, BLOB_INDEX_COLLECTION)
    const allChunks = await store.list(VAULT, BLOB_CHUNKS_COLLECTION)
    // Pick the MULTI-chunk blob deliberately: with a single-chunk one, `chunks`
    // and `eTags` would both be 1 and a fix that conflated them would pass.
    const orphaned = eTags
      .map(t => ({ t, n: allChunks.filter(id => id.startsWith(`${t}_`)).length }))
      .sort((a, b) => b.n - a.n)[0]!
    expect(orphaned.n).toBeGreaterThan(1)
    const chunkIdsFor = allChunks.filter(id => id.startsWith(`${orphaned.t}_`))

    // Exactly the pre-#1127 crash window: index row gone, chunks still there.
    await store.delete(VAULT, BLOB_INDEX_COLLECTION, orphaned.t)

    const report = await reportOrphanBlobChunks(store, VAULT)
    expect(report.chunks).toBe(chunkIdsFor.length)
    expect(report.eTags).toBe(1)
    expect(report.sampleETags).toEqual([orphaned.t])
    expect(report.unparseable).toBe(0)
  })

  it('DELETES NOTHING — every chunk row survives the report', async () => {
    const { store } = await seeded()
    const eTags = await store.list(VAULT, BLOB_INDEX_COLLECTION)
    await store.delete(VAULT, BLOB_INDEX_COLLECTION, eTags[0]!)
    const before = (await store.list(VAULT, BLOB_CHUNKS_COLLECTION)).sort()

    await reportOrphanBlobChunks(store, VAULT)
    await reportOrphanBlobChunks(store, VAULT) // idempotent, and still non-destructive

    expect((await store.list(VAULT, BLOB_CHUNKS_COLLECTION)).sort()).toEqual(before)
  })

  it('a WITHHOLDING store inflates the count and destroys nothing — the reason this only reports', async () => {
    const { store } = await seeded()
    const liveETags = await store.list(VAULT, BLOB_INDEX_COLLECTION)
    const chunkIds = await store.list(VAULT, BLOB_CHUNKS_COLLECTION)
    // The store lies about the index — every blob is LIVE, nothing was deleted.
    const lying: NoydbStore = {
      ...store,
      async list(v, c) { return c === BLOB_INDEX_COLLECTION ? [] : store.list(v, c) },
    }
    const report = await reportOrphanBlobChunks(lying, VAULT)
    expect(report.chunks).toBe(chunkIds.length)
    expect(report.eTags).toBe(liveETags.length)
    // ...and the truth is unchanged, because a report cannot act on the lie.
    expect(await reportOrphanBlobChunks(store, VAULT)).toMatchObject({ chunks: 0, eTags: 0 })
    expect((await store.list(VAULT, BLOB_CHUNKS_COLLECTION)).length).toBe(chunkIds.length)
  })

  it('counts ids that do not fit the `{eTag}_{index}` grammar instead of ignoring them', async () => {
    const { store } = await seeded()
    const anyChunk = (await store.list(VAULT, BLOB_CHUNKS_COLLECTION))[0]!
    const env = await store.get(VAULT, BLOB_CHUNKS_COLLECTION, anyChunk)
    await store.put(VAULT, BLOB_CHUNKS_COLLECTION, 'no-index-suffix', env!)
    await store.put(VAULT, BLOB_CHUNKS_COLLECTION, 'trailing_', env!)
    await store.put(VAULT, BLOB_CHUNKS_COLLECTION, 'nondigit_x', env!)

    const report = await reportOrphanBlobChunks(store, VAULT)
    expect(report.unparseable).toBe(3)
    expect(report.chunks).toBe(0) // unparseable is NOT silently folded into "orphan"
  })

  it('rides along on vault.compact()', async () => {
    const { store, vault } = await seeded()
    expect((await vault.compact()).orphanBlobChunks).toMatchObject({ chunks: 0, eTags: 0 })

    const eTags = await store.list(VAULT, BLOB_INDEX_COLLECTION)
    await store.delete(VAULT, BLOB_INDEX_COLLECTION, eTags[0]!)

    const result = await vault.compact()
    expect(result.orphanBlobChunks.chunks).toBeGreaterThan(0)
    expect(result.orphanBlobChunks.sampleETags).toEqual([eTags[0]])
  })

  it('survives a store that cannot list at all — a diagnostic must not fail its host pass', async () => {
    const { store } = await seeded()
    const broken: NoydbStore = { ...store, async list() { throw new Error('store offline') } }
    expect(await reportOrphanBlobChunks(broken, VAULT))
      .toEqual({ chunks: 0, eTags: 0, sampleETags: [], unparseable: 0 })
  })
})
