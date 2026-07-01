/**
 * Bundle-includes-blobs round-trip tests.
 *
 * Regression guard for the consumer bug where `vault.dump()` / the
 * `.noydb` bundle excluded the `_blob_*` collections, so blob content
 * ("covers") never travelled inside the bundle — a restored vault had
 * dangling blob references (the bytes were gone).
 *
 * The fix is dump-side only: `dump()` now enumerates the blob
 * collections (the three global ones plus the per-user-collection
 * slots/versions) alongside the ledger/schema/sequence internals.
 * `load()` already restores `backup._internal` generically, and the
 * blob DEK already travels in `_keyring`, so restored covers decrypt.
 *
 * Before the fix, the assertions that the `_blob_*` collections are
 * present in the backup JSON, and that the restored cover reads back
 * byte-identical, both FAIL.
 *
 * Setup mirrors blob-set.test.ts / per-blob-cek.test.ts (blob API) and
 * verifiable-backup.test.ts (dump/load + history + fresh-vault restore).
 */

import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/noydb.js'
import { withBlobs } from '../src/with-shape/blobs/index.js'
import { withHistory } from '../src/with-commit/history/index.js'
import {
  BLOB_INDEX_COLLECTION,
  BLOB_CHUNKS_COLLECTION,
  BLOB_SLOTS_PREFIX,
} from '../src/with-shape/blobs/blob-set.js'
import { ConflictError } from '../src/errors.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'

// Realistic in-memory store: `loadAll` filters out underscore-prefixed
// (internal) collections, exactly like the real adapters — so dump()'s
// explicit enumeration of the blob collections is what makes them
// travel. `saveAll` preserves any existing internal collections.
function memory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function getCollection(c: string, col: string) {
    let comp = store.get(c)
    if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col)
    if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    name: 'memory',
    async get(c, col, id) { return store.get(c)?.get(col)?.get(id) ?? null },
    async put(c, col, id, env, ev) {
      const coll = getCollection(c, col)
      const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(c, col, id) { store.get(c)?.get(col)?.delete(id) },
    async list(c, col) { const coll = store.get(c)?.get(col); return coll ? [...coll.keys()] : [] },
    async loadAll(c) {
      const comp = store.get(c); const s: VaultSnapshot = {}
      if (comp) for (const [n, coll] of comp) {
        if (!n.startsWith('_')) {
          const r: Record<string, EncryptedEnvelope> = {}
          for (const [id, e] of coll) r[id] = e
          s[n] = r
        }
      }
      return s
    },
    async saveAll(c, data) {
      const comp = new Map<string, Map<string, EncryptedEnvelope>>()
      for (const [name, records] of Object.entries(data)) {
        const coll = new Map<string, EncryptedEnvelope>()
        for (const [id, env] of Object.entries(records)) coll.set(id, env)
        comp.set(name, coll)
      }
      const existing = store.get(c)
      if (existing) {
        for (const [name, coll] of existing) {
          if (name.startsWith('_')) comp.set(name, coll)
        }
      }
      store.set(c, comp)
    },
  }
}

const SECRET = 'correct-horse-battery-staple-long-enough'

function cover(n: number): Uint8Array {
  // Deterministic few-KB "cover" image stand-in.
  const buf = new Uint8Array(n)
  for (let i = 0; i < n; i++) buf[i] = (i * 31 + 7) & 0xff
  return buf
}

describe('bundle includes blobs (dump → load round-trip).', () => {
  it('blob covers travel inside the bundle and restore byte-identical', async () => {
    const sourceStore = memory()
    const sourceDb = await createNoydb({
      store: sourceStore,
      user: 'alice',
      secret: SECRET,
      blobStrategy: withBlobs(),
      historyStrategy: withHistory(),
    })
    const sourceVault = await sourceDb.openVault('demo-co')
    const books = sourceVault.collection<{ title: string }>('books')
    await books.put('book-1', { title: 'Moby Dick' })

    const coverBytes = cover(4096)
    await books.blob('book-1').put('cover.png', coverBytes, { mimeType: 'image/png' })

    // Sanity: the blob collections are populated in the source store.
    expect((await sourceStore.list('demo-co', BLOB_INDEX_COLLECTION)).length).toBeGreaterThan(0)
    expect((await sourceStore.list('demo-co', BLOB_CHUNKS_COLLECTION)).length).toBeGreaterThan(0)
    expect((await sourceStore.list('demo-co', `${BLOB_SLOTS_PREFIX}books`)).length).toBeGreaterThan(0)

    const backupJson = await sourceVault.dump()
    const backup = JSON.parse(backupJson)

    // The fix: the blob collections are now present in the bundle's
    // _internal section. Before the fix, _internal had only the
    // ledger/schema/sequence collections and these were ABSENT.
    expect(backup._internal).toBeDefined()
    expect(backup._internal[BLOB_INDEX_COLLECTION]).toBeDefined()
    expect(backup._internal[BLOB_CHUNKS_COLLECTION]).toBeDefined()
    expect(backup._internal[`${BLOB_SLOTS_PREFIX}books`]).toBeDefined()
    expect(Object.keys(backup._internal[BLOB_CHUNKS_COLLECTION]).length).toBeGreaterThan(0)

    // Restore into a FRESH vault (new store + new Noydb, same secret so
    // the dumped keyring DEKs — including the blob DEK — unwrap).
    const targetStore = memory()
    const targetDb = await createNoydb({
      store: targetStore,
      user: 'alice',
      secret: SECRET,
      blobStrategy: withBlobs(),
      historyStrategy: withHistory(),
    })
    const targetVault = await targetDb.openVault('demo-co')
    await targetVault.load(backupJson)

    // The record itself round-trips.
    const targetBooks = targetVault.collection<{ title: string }>('books')
    expect(await targetBooks.get('book-1')).toEqual({ title: 'Moby Dick' })

    // The cover reads back byte-identical and decrypts. Without the
    // fix this returns null / fails — the chunks never travelled.
    const restored = await targetBooks.blob('book-1').get('cover.png')
    expect(restored).not.toBeNull()
    expect(restored!.byteLength).toBe(coverBytes.byteLength)
    expect([...restored!]).toEqual([...coverBytes])

    const info = await targetBooks.blob('book-1').list()
    expect(info).toHaveLength(1)
    expect(info[0]!.name).toBe('cover.png')
    expect(info[0]!.mimeType).toBe('image/png')

    sourceDb.close()
    targetDb.close()
  })

  it('a vault with no blobs still dumps and loads cleanly', async () => {
    const sourceStore = memory()
    const sourceDb = await createNoydb({
      store: sourceStore,
      user: 'alice',
      secret: SECRET,
      blobStrategy: withBlobs(),
      historyStrategy: withHistory(),
    })
    const sourceVault = await sourceDb.openVault('demo-co')
    const notes = sourceVault.collection<{ body: string }>('notes')
    await notes.put('n-1', { body: 'hello' })

    const backupJson = await sourceVault.dump()
    const backup = JSON.parse(backupJson)

    // No blobs were written → no _blob_* collections in the bundle
    // (the dump loop skips empty ids).
    expect(backup._internal[BLOB_INDEX_COLLECTION]).toBeUndefined()
    expect(backup._internal[BLOB_CHUNKS_COLLECTION]).toBeUndefined()
    expect(backup._internal[`${BLOB_SLOTS_PREFIX}notes`]).toBeUndefined()

    const targetStore = memory()
    const targetDb = await createNoydb({
      store: targetStore,
      user: 'alice',
      secret: SECRET,
      blobStrategy: withBlobs(),
      historyStrategy: withHistory(),
    })
    const targetVault = await targetDb.openVault('demo-co')
    await targetVault.load(backupJson)

    const targetNotes = targetVault.collection<{ body: string }>('notes')
    expect(await targetNotes.get('n-1')).toEqual({ body: 'hello' })

    sourceDb.close()
    targetDb.close()
  })

  it('dump() works when the blobs subsystem is not opted in', async () => {
    const sourceStore = memory()
    const sourceDb = await createNoydb({
      store: sourceStore,
      user: 'alice',
      secret: SECRET,
      historyStrategy: withHistory(),
    })
    const sourceVault = await sourceDb.openVault('demo-co')
    const notes = sourceVault.collection<{ body: string }>('notes')
    await notes.put('n-1', { body: 'no blobs here' })

    // Should not throw — the blob-collection enumeration finds no ids.
    const backupJson = await sourceVault.dump()
    const backup = JSON.parse(backupJson)
    expect(backup.collections.notes['n-1']).toBeDefined()

    sourceDb.close()
  })
})
