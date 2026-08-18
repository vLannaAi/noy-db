/**
 * A rotation must not destroy the vault's blobs, and must not leave one
 * readable under the key it retired (#1122).
 *
 * ## The defect
 *
 * `rotateKeys` re-keyed `store.list(vault, <slot>)` plus the derived refs
 * `derivedRefsFor` declared — the same DEK-name-equals-collection-name
 * assumption #1108 fixed for `_history` and `_ledger_deltas`, one layer worse.
 * The `_blob` slot protects data filed under NO collection of its own: the
 * ciphertext lives in `_blob_index` and `_blob_chunks`. Rotating `_blob` minted
 * a fresh DEK, re-encrypted nothing, and made every blob in the vault
 * permanently unreadable.
 *
 * It was reachable through an ordinary `revoke`: a whole-vault grantee's DEK
 * map contains `_blob`, so revoking a viewer or an admin destroyed the owner's
 * blobs. Measured before the fix, against `src`:
 *
 * ```
 * read before:         hello blob
 * read after rotation: TamperedError
 * read after reopen:   TamperedError
 * ```
 *
 * The symptom is the worst part. `TamperedError` is the alarm #1103 spent a
 * release making trustworthy; a user hitting this was told their store may be
 * attacking them when their own revocation had deleted their data.
 *
 * ## Why both halves are asserted, and why the second is asked in the output
 * domain
 *
 * Row 1 is AVAILABILITY: the owner still reads every byte. Row 2 is
 * CONFIDENTIALITY: the revoked member's retained keys open nothing. A fix can
 * pass either one alone and be wrong — doing nothing passes row 2, and carrying
 * the old key forward passes row 1.
 *
 * Row 2 sweeps the collections the store was actually WRITTEN to, recorded by a
 * proxy, rather than a list of blob collection names. Like #1108's own
 * invariant it does not consult the fix's table, so a service that starts
 * sealing a fifth surface under a borrowed DEK fails here rather than passing
 * quietly.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { memoryStore } from '../src/index.js'
import { withTeam } from '../src/with-party/team/index.js'
import { withBlobs } from '../src/via/blob/index.js'
import { withTiers } from '../src/with-audit/tiers/index.js'
import {
  openEnvelopeJson,
  decryptBytesWithAAD,
  type EnclaveKey,
} from '../src/kernel/enclave/index.js'
import {
  BLOB_INDEX_COLLECTION,
  BLOB_CHUNKS_COLLECTION,
  DEFAULT_CHUNK_SIZE,
} from '../src/with-shape/blobs/blob-set.js'
import type { NoydbStore, EncryptedEnvelope } from '../src/kernel/types.js'

const VAULT = 'acme'
const SECRET = 'owner-pass-correct-horse-battery-staple'

/** Store wrapper that records every collection name written to. */
function recordingStore(): { store: NoydbStore; touched: Set<string> } {
  const inner = memoryStore()
  const touched = new Set<string>()
  const store: NoydbStore = {
    ...inner,
    name: 'memory-recording',
    async get(v, c, id) { return inner.get(v, c, id) },
    async put(v, c, id, env, ev) { touched.add(c); return inner.put(v, c, id, env, ev) },
    async delete(v, c, id) { return inner.delete(v, c, id) },
    async list(v, c) { return inner.list(v, c) },
    async loadAll(v) { return inner.loadAll(v) },
    async saveAll(v, d) { return inner.saveAll(v, d) },
  }
  return { store, touched }
}

/** Chunk integrity binding — owner: with-shape/blobs/blob-set.ts. */
function chunkAad(eTag: string, index: number, chunkCount: number): Uint8Array {
  return new TextEncoder().encode(`${eTag}:${index}:${chunkCount}`)
}

/**
 * Every `(collection, id)` any key in `keys` still opens.
 *
 * Two shapes are probed because the blob set uses two: a JSON body under the
 * record AAD, and raw chunk bytes under `{eTag}:{i}:{count}`. A sweep that only
 * knew the first would report a clean vault while every chunk sat readable.
 */
async function readableWith(
  store: NoydbStore,
  collections: Iterable<string>,
  keys: ReadonlyMap<string, EnclaveKey>,
  chunkCounts: ReadonlyMap<string, number>,
): Promise<string[]> {
  const hits: string[] = []
  for (const collection of collections) {
    let ids: string[] = []
    try { ids = await store.list(VAULT, collection) } catch { continue }
    for (const id of ids) {
      const env: EncryptedEnvelope | null = await store.get(VAULT, collection, id)
      if (!env || !env._iv) continue // no sealed body — nothing to open
      for (const [keyName, key] of keys) {
        let opened = false
        try {
          await openEnvelopeJson({ collection, id }, env, key)
          opened = true
        } catch { /* not a JSON body under this key */ }
        if (!opened && collection === BLOB_CHUNKS_COLLECTION) {
          const sep = id.lastIndexOf('_')
          const eTag = id.slice(0, sep)
          const index = Number(id.slice(sep + 1))
          const count = chunkCounts.get(eTag)
          if (count !== undefined) {
            try {
              await decryptBytesWithAAD(env._iv, env._data, key, chunkAad(eTag, index, count))
              opened = true
            } catch { /* not this key */ }
          }
        }
        if (opened) { hits.push(`${collection}/${id} (via '${keyName}')`); break }
      }
    }
  }
  return hits
}

/** One small blob, one multi-chunk blob, one erasable (per-blob-CEK) blob. */
async function seeded() {
  const { store, touched } = recordingStore()
  const db = await createNoydb({
    teamStrategy: withTeam(), blobsStrategy: withBlobs(),
    store, user: 'owner', secret: SECRET,
  })
  const vault = await db.openVault(VAULT)
  const invoices = vault.collection<{ ref: string }>('invoices')
  await invoices.put('inv-1', { ref: 'A' })
  await invoices.put('inv-2', { ref: 'B' })

  const small = new TextEncoder().encode('hello blob')
  // Deliberately incompressible so gzip cannot collapse it back to one chunk —
  // chunking happens AFTER compression, and a patterned filler produced a
  // single chunk, which would have let a chunk-blind fix pass row 1.
  const big = new Uint8Array(DEFAULT_CHUNK_SIZE * 2 + 1024)
  for (let off = 0; off < big.length; off += 65536) {
    globalThis.crypto.getRandomValues(big.subarray(off, Math.min(off + 65536, big.length)))
  }

  await invoices.blob('inv-1').put('readme.txt', small, { mimeType: 'text/plain' })
  await invoices.blob('inv-1').put('big.bin', big)
  await invoices.blob('inv-2').put('shared.txt', small)

  const expected = new Map<string, Uint8Array>([
    ['inv-1/readme.txt', small],
    ['inv-1/big.bin', big],
    ['inv-2/shared.txt', small],
  ])
  return { store, touched, db, vault, invoices, expected }
}

/** eTag → chunkCount, read from the live vault before anything is rotated. */
async function chunkCountsOf(store: NoydbStore): Promise<Map<string, number>> {
  const counts = new Map<string, number>()
  for (const id of await store.list(VAULT, BLOB_CHUNKS_COLLECTION)) {
    const eTag = id.slice(0, id.lastIndexOf('_'))
    counts.set(eTag, (counts.get(eTag) ?? 0) + 1)
  }
  return counts
}

/** Read every seeded blob back and compare bytes. */
async function readAll(
  vault: Awaited<ReturnType<Awaited<ReturnType<typeof createNoydb>>['openVault']>>,
  expected: ReadonlyMap<string, Uint8Array>,
): Promise<number> {
  const coll = vault.collection<{ ref: string }>('invoices')
  let read = 0
  for (const [path, bytes] of expected) {
    const [recordId, name] = path.split('/') as [string, string]
    const got = await coll.blob(recordId).get(name)
    expect(got, `blob ${path} came back null`).not.toBeNull()
    expect(Array.from(got!), `blob ${path} round-trip`).toEqual(Array.from(bytes))
    read++
  }
  return read
}

describe('#1122 — rotation must not destroy the blob set', () => {
  it('1. AVAILABILITY: after revoking a whole-vault grantee, the owner reads every blob', async () => {
    const { store, db, vault, expected } = await seeded()

    // Control: three blobs, and more than three chunks — so a fix that moved
    // only the index and not the chunks cannot pass by reading a one-chunk
    // vault. Counted, not assumed.
    expect(await readAll(vault, expected)).toBe(3)
    const counts = await chunkCountsOf(store)
    expect(counts.size).toBe(2) // dedup: inv-2/shared.txt shares inv-1/readme.txt's eTag
    expect([...counts.values()].reduce((a, b) => a + b, 0)).toBeGreaterThan(3)

    await db.grant(VAULT, { userId: 'bob', displayName: 'B', role: 'admin', secret: 'bob-pass-1' })
    await db.revoke(VAULT, { userId: 'bob' })

    // A fresh handle, so this cannot pass off an in-memory cache as durability.
    const db2 = await createNoydb({
      teamStrategy: withTeam(), blobsStrategy: withBlobs(),
      store, user: 'owner', secret: SECRET,
    })
    expect(await readAll(await db2.openVault(VAULT), expected)).toBe(3)
  })

  it('2. THE INVARIANT: after revoke, no retained key opens ANY envelope', async () => {
    const { store, touched, db, vault, expected } = await seeded()
    await readAll(vault, expected)
    const counts = await chunkCountsOf(store)

    await db.grant(VAULT, { userId: 'bob', displayName: 'B', role: 'admin', secret: 'bob-pass-1' })
    const bobDb = await createNoydb({
      teamStrategy: withTeam(), blobsStrategy: withBlobs(),
      store, user: 'bob', secret: 'bob-pass-1',
    })
    const bobVault = await bobDb.openVault(VAULT)
    // Captured BEFORE revocation — revocation cannot take back a key bob
    // already holds, only make it open nothing.
    const retained = new Map((bobVault as unknown as {
      _introspectState(): { keyring: { deks: Map<string, EnclaveKey> } }
    })._introspectState().keyring.deks)
    expect(retained.has('_blob')).toBe(true)

    // Control: those keys DO open things now, including blob surfaces —
    // otherwise row 2 asserts nothing.
    const before = await readableWith(store, touched, retained, counts)
    expect(before.length).toBeGreaterThan(0)
    expect(before.filter((h) => h.startsWith(`${BLOB_INDEX_COLLECTION}/`)).length).toBe(2)
    expect(before.filter((h) => h.startsWith(`${BLOB_CHUNKS_COLLECTION}/`)).length)
      .toBe([...counts.values()].reduce((a, b) => a + b, 0))

    await db.revoke(VAULT, { userId: 'bob' })

    const residue = await readableWith(store, touched, retained, counts)
    expect(residue, `retained keys still open:\n  ${residue.join('\n  ')}`).toEqual([])
  })

  it('3. an erasable (per-blob-CEK) blob survives a direct `_blob` rotation', async () => {
    const { store, db, vault, expected } = await seeded()
    // `migrate()` promotes every legacy blob to per-blob-CEK mode: the chunks
    // move under a content CEK and only the wrapped CEK sits under `_blob`.
    // That is the branch where re-encrypting chunks is WRONG and re-wrapping
    // the CEK is the whole job — the opposite of the legacy branch.
    const migrated = await vault.collection<{ ref: string }>('invoices').blob('inv-1').migrate()
    expect(migrated.migrated.length).toBeGreaterThan(0)

    await db.rotate(VAULT, ['_blob'])

    const db2 = await createNoydb({
      teamStrategy: withTeam(), blobsStrategy: withBlobs(),
      store, user: 'owner', secret: SECRET,
    })
    expect(await readAll(await db2.openVault(VAULT), expected)).toBe(3)
  })

  it('4. rotation is resumable: re-running it over an already-moved blob set is a no-op', async () => {
    const { store, db, vault, expected } = await seeded()
    await db.rotate(VAULT, ['_blob'])
    await db.rotate(VAULT, ['_blob'])
    const db2 = await createNoydb({
      teamStrategy: withTeam(), blobsStrategy: withBlobs(),
      store, user: 'owner', secret: SECRET,
    })
    expect(await readAll(await db2.openVault(VAULT), expected)).toBe(3)
    void vault
  })
})

/**
 * The `_blob#<tier>` slots are the same surface one address along: an elevated
 * record's blob metadata is sealed under `dekKey('_blob', tier)` and filed in
 * the SAME `_blob_index`. Membership there is by DEK, not by collection name,
 * which is why the rotation is told the other keys the caller holds — so an
 * entry belonging to another blob slot is left for that slot's own rotation
 * instead of being mistaken for a damaged record and throwing.
 */
describe('#1122 — the tier blob slots', () => {
  it('5. rotating `_blob` and `_blob#1` preserves a tier-0 blob and an elevated one', async () => {
    const { store } = recordingStore()
    const db = await createNoydb({
      teamStrategy: withTeam(), tiersStrategy: withTiers(), blobsStrategy: withBlobs(),
      store, user: 'owner', secret: SECRET,
    })
    const vault = await db.openVault(VAULT)
    const docs = vault.collection<{ n: number }>('docs', { tiers: [0, 1], perRecordKeys: true })
    await docs.put('d1', { n: 1 })
    await docs.put('d2', { n: 2 })
    const flat = new TextEncoder().encode('tier zero bytes')
    const secret = new TextEncoder().encode('tier one bytes')
    await docs.blob('d1').put('a.txt', flat)
    await docs.blob('d2').put('b.txt', secret)
    await docs.elevate('d2', 1)

    const deks = (vault as unknown as {
      _introspectState(): { keyring: { deks: Map<string, EnclaveKey> } }
    })._introspectState().keyring.deks
    expect([...deks.keys()]).toContain('_blob#1')

    // Control: both read BEFORE the rotation, so a null afterwards is the
    // rotation's doing and not a mis-addressed read.
    expect(Array.from((await docs.blob('d1').get('a.txt'))!)).toEqual(Array.from(flat))
    expect(Array.from((await (await docs.blob('d2').atTier()).get('b.txt'))!)).toEqual(Array.from(secret))

    await db.rotate(VAULT, ['_blob', '_blob#1'])

    const db2 = await createNoydb({
      teamStrategy: withTeam(), tiersStrategy: withTiers(), blobsStrategy: withBlobs(),
      store, user: 'owner', secret: SECRET,
    })
    const docs2 = (await db2.openVault(VAULT)).collection<{ n: number }>('docs', { tiers: [0, 1], perRecordKeys: true })
    expect(Array.from((await docs2.blob('d1').get('a.txt'))!)).toEqual(Array.from(flat))
    expect(Array.from((await (await docs2.blob('d2').atTier()).get('b.txt'))!)).toEqual(Array.from(secret))
  })
})
