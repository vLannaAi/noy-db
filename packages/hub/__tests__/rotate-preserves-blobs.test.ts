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
  rekeyBlobSet,
  generateDEK,
  base64ToBuffer,
  bufferToBase64,
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

/**
 * A small blob, a multi-chunk blob, and a second record sharing the small one's
 * eTag (dedup).
 *
 * `mixed: true` additionally migrates the first record's blobs to per-blob-CEK
 * mode and THEN adds a third, still-legacy blob — so the vault holds both
 * branches at once. That matters for the confidentiality sweep specifically:
 * the erasable branch is the one where chunks are deliberately left under an
 * unchanged content CEK, i.e. exactly where a botched re-wrap would show up,
 * and a fixture that never migrates leaves it covered only by an availability
 * assertion.
 */
async function seeded(opts: { mixed?: boolean } = {}) {
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

  if (opts.mixed) {
    // Migrate first, then seed the legacy blob — `migrate()` only reaches what
    // exists when it runs, so this ordering is what produces a genuinely mixed
    // vault rather than a wholly-erasable one.
    const migrated = await invoices.blob('inv-1').migrate()
    expect(migrated.migrated.length).toBeGreaterThan(0)
    const legacy = new TextEncoder().encode('still legacy bytes')
    await invoices.put('inv-3', { ref: 'C' })
    await invoices.blob('inv-3').put('plain.txt', legacy)
    expected.set('inv-3/plain.txt', legacy)
  }

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
    // MIXED on purpose: two erasable blobs and one legacy one, so the sweep
    // covers the branch where chunks are left under an unchanged content CEK
    // as well as the branch where they move.
    const { store, touched, db, vault, expected } = await seeded({ mixed: true })
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
    // otherwise row 2 asserts nothing. Counted per surface, because "some hits"
    // would pass while a whole surface sat unswept.
    const before = await readableWith(store, touched, retained, counts)
    expect(before.length).toBeGreaterThan(0)
    // Every index entry — erasable and legacy alike — is sealed under `_blob`.
    expect(before.filter((h) => h.startsWith(`${BLOB_INDEX_COLLECTION}/`)).length).toBe(3)
    // Only the LEGACY blob's chunk bodies are; the two erasable blobs' bytes
    // sit under their content CEKs, which is why the wrapped CEK inside the
    // index entry is the thing that has to move for them.
    const legacyChunkHits = before.filter((h) => h.startsWith(`${BLOB_CHUNKS_COLLECTION}/`)).length
    expect(legacyChunkHits).toBeGreaterThan(0)
    expect(legacyChunkHits).toBeLessThan([...counts.values()].reduce((a, b) => a + b, 0))

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


/**
 * The report `rekeyBlobSet` returns is the only thing that separates "left this
 * alone, correctly" from "left EVERYTHING alone, because the caller passed a
 * wrong `otherDeks` set". Both re-key nothing; both return successfully; and
 * the end-to-end rows above would still pass the second one if the vault it ran
 * against happened to be empty of the surface in question.
 *
 * So the counts are asserted directly. An all-`foreign` classification fails
 * here loudly instead of reading as a clean rotation.
 */
describe('#1122 — the rotation reports what it did', () => {
  /** The vault's live DEK for `name`. */
  function dekOf(vault: unknown, name: string): Promise<EnclaveKey> {
    return (vault as { getDEK(n: string): Promise<EnclaveKey> }).getDEK(name)
  }

  it('6. counts every blob it moved, and re-running reports them already moved', async () => {
    const { store, vault, expected } = await seeded({ mixed: true })
    await readAll(vault, expected)

    const counts = await chunkCountsOf(store)
    expect(counts.size).toBe(3) // two erasable eTags + one legacy
    const oldDek = await dekOf(vault, '_blob')
    const newDek = await generateDEK()

    const report = await rekeyBlobSet(store, VAULT, oldDek, newDek, [])
    // Every index entry moved — this is the assertion that fails if a wrong
    // `otherDeks` set ever makes the routine classify its own work as foreign.
    expect(report.blobs).toBe(3)
    expect(report.foreign).toBe(0)
    expect(report.alreadyMoved).toBe(0)
    // Only the legacy blob's chunk bodies move; the erasable ones stay under
    // their content CEKs. Both bounds asserted, so neither "moved nothing" nor
    // "moved everything, including bytes it had no business touching" passes.
    expect(report.chunks).toBeGreaterThan(0)
    expect(report.chunks).toBeLessThan([...counts.values()].reduce((a, b) => a + b, 0))

    // Idempotent: the resume path recognises its own work rather than redoing it.
    const again = await rekeyBlobSet(store, VAULT, oldDek, newDek, [])
    expect(again).toEqual({ blobs: 0, chunks: 0, foreign: 0, alreadyMoved: 3 })
  })

  it('7. an entry belonging to another blob slot is reported foreign, not moved', async () => {
    const { store } = recordingStore()
    const db = await createNoydb({
      teamStrategy: withTeam(), tiersStrategy: withTiers(), blobsStrategy: withBlobs(),
      store, user: 'owner', secret: SECRET,
    })
    const vault = await db.openVault(VAULT)
    const docs = vault.collection<{ n: number }>('docs', { tiers: [0, 1], perRecordKeys: true })
    await docs.put('d1', { n: 1 })
    await docs.put('d2', { n: 2 })
    await docs.blob('d1').put('a.txt', new TextEncoder().encode('tier zero bytes'))
    await docs.blob('d2').put('b.txt', new TextEncoder().encode('tier one bytes'))
    await docs.elevate('d2', 1)

    const tier0 = await dekOf(vault, '_blob')
    const tier1 = await dekOf(vault, '_blob#1')
    const newTier0 = await generateDEK()

    // Rotating the tier-0 slot: the elevated blob's index entry lives in the
    // same `_blob_index` and must be recognised as tier-1's business.
    const report = await rekeyBlobSet(store, VAULT, tier0, newTier0, [tier1])
    expect(report.blobs).toBe(1)
    expect(report.foreign).toBe(1)

    // And WITHOUT being told about the tier-1 key it is genuinely damaged as
    // far as this rotation can tell — so it throws rather than reporting a
    // clean run over data it could not read.
    const newTier0b = await generateDEK()
    await expect(rekeyBlobSet(store, VAULT, newTier0, newTier0b, []))
      .rejects.toThrow(/opens under neither/)
  })
})

/**
 * The chunk loop's two hard cases, both reachable only by construction.
 *
 * A chunk that refuses the retiring DEK used to be skipped, on the reasoning
 * that the index entry above would be the loud report. That reasoning was
 * wrong: the index entry opened fine under the retiring DEK and says nothing
 * about its chunks, so a damaged chunk was walked silently past and the
 * rotation returned success — the exact "permanent quiet loss" this module's
 * own doc block refuses.
 */
describe('#1122 — a chunk that opens under neither key', () => {
  async function legacyVault() {
    const { store } = recordingStore()
    const db = await createNoydb({
      teamStrategy: withTeam(), blobsStrategy: withBlobs(),
      store, user: 'owner', secret: SECRET,
    })
    const vault = await db.openVault(VAULT)
    const invoices = vault.collection<{ ref: string }>('invoices')
    await invoices.put('inv-1', { ref: 'A' })
    const bytes = new TextEncoder().encode('legacy bytes under the _blob DEK')
    await invoices.blob('inv-1').put('a.txt', bytes)
    const eTag = (await store.list(VAULT, BLOB_INDEX_COLLECTION))[0]!
    const dek = await (vault as unknown as {
      getDEK(n: string): Promise<EnclaveKey>
    }).getDEK('_blob')
    return { store, db, vault, invoices, eTag, dek, bytes }
  }

  it('8. THROWS rather than reporting a clean rotation over a damaged chunk', async () => {
    const { store, eTag, dek } = await legacyVault()
    // Corrupt the chunk body only — the index entry stays perfectly readable
    // under the retiring DEK, which is what made the old skip look safe.
    const id = `${eTag}_0`
    const chunk = (await store.get(VAULT, BLOB_CHUNKS_COLLECTION, id))!
    const flipped = base64ToBuffer(chunk._data)
    flipped.set([(flipped[0] ?? 0) ^ 0xff], 0)
    await store.put(VAULT, BLOB_CHUNKS_COLLECTION, id, {
      ...chunk, _data: bufferToBase64(flipped),
    })

    await expect(rekeyBlobSet(store, VAULT, dek, await generateDEK(), []))
      .rejects.toThrow(/blob chunk .* opens under neither/)
  })

  it('9. RESUMES an interruption between the chunks and their index entry', async () => {
    const { store, db, eTag, dek, bytes } = await legacyVault()
    const newDek = await generateDEK()
    const before = (await store.get(VAULT, BLOB_INDEX_COLLECTION, eTag))!

    // A full pass, then put the index entry back the way it was: chunks under
    // the new DEK, metadata still under the old one. That is precisely the
    // state a crash between the two writes leaves behind, and the state the
    // `newDek` probe exists for.
    expect(await rekeyBlobSet(store, VAULT, dek, newDek, []))
      .toEqual({ blobs: 1, chunks: 1, foreign: 0, alreadyMoved: 0 })
    await store.put(VAULT, BLOB_INDEX_COLLECTION, eTag, before)

    // The re-run moves the index and recognises the chunk as already done —
    // `chunks: 0` is the assertion, since re-encrypting it under `newDek` a
    // second time would need it to open under `newDek` first, and counting it
    // again would mean the probe had not run.
    expect(await rekeyBlobSet(store, VAULT, dek, newDek, []))
      .toEqual({ blobs: 1, chunks: 0, foreign: 0, alreadyMoved: 0 })

    // And the bytes are genuinely there under the new key, not merely tidy.
    // Checked at rest rather than through the API: these two calls moved the
    // data out from under the vault's own keyring on purpose, so the vault can
    // no longer read it and a `get()` here would be testing the fixture.
    const chunk = (await store.get(VAULT, BLOB_CHUNKS_COLLECTION, `${eTag}_0`))!
    // The chunk body is post-compression, so this asserts that it OPENS under
    // the new key and its eTag-bound AAD still holds — not that it equals the
    // caller's bytes, which it never did at this layer.
    const plain = await decryptBytesWithAAD(
      chunk._iv, chunk._data, newDek, chunkAad(eTag, 0, 1),
    )
    expect(plain.byteLength).toBeGreaterThan(0)
    void db, bytes
  })
})

/**
 * #1127 — a crash mid-delete must not strand chunks that nothing can reach.
 *
 * `releaseRef` used to delete the index row BEFORE the chunks. A crash in
 * between left chunk bodies with no index entry, and nothing ever visits those
 * again: `loadBlobObject` returns null so no reader addresses them, and
 * `rekeyBlobSet` derives chunk ids from each index entry's `chunkCount` so a
 * rotation walks straight past. For a legacy blob that means the bytes stay
 * openable under the retired `_blob` DEK — the key a revoked member kept.
 *
 * The fix reverses the order, and these rows assert the ORDERING PROPERTY
 * rather than the symptom: whatever the crash point, every surviving chunk
 * still has an index row. That is what makes it reachable by the rotation, and
 * therefore what makes row 2's invariant hold after an interrupted delete.
 *
 * The injection point matters. Throwing on the first CHUNK delete is the one
 * that separates the two orderings: under the old code the index row is already
 * gone at that moment and every chunk is stranded; under the new one the index
 * row is still there and the chunks that remain are all covered by it. Throwing
 * on the index delete instead would pass under both.
 */
function crashOnFirstChunkDelete(inner: NoydbStore): { store: NoydbStore; crashed: () => boolean } {
  let fired = false
  const store: NoydbStore = {
    ...inner,
    name: 'memory-crash-mid-delete',
    async get(v, c, id) { return inner.get(v, c, id) },
    async put(v, c, id, env, ev) { return inner.put(v, c, id, env, ev) },
    async delete(v, c, id) {
      if (c === BLOB_CHUNKS_COLLECTION && !fired) {
        fired = true
        throw new Error('simulated crash mid-delete')
      }
      return inner.delete(v, c, id)
    },
    async list(v, c) { return inner.list(v, c) },
    async loadAll(v) { return inner.loadAll(v) },
    async saveAll(v, d) { return inner.saveAll(v, d) },
  }
  return { store, crashed: () => fired }
}

/** Chunk ids whose eTag has no `_blob_index` row — unreachable by construction. */
async function orphanChunks(store: NoydbStore): Promise<string[]> {
  const indexed = new Set(await store.list(VAULT, BLOB_INDEX_COLLECTION))
  const chunkIds = await store.list(VAULT, BLOB_CHUNKS_COLLECTION)
  return chunkIds.filter((id) => !indexed.has(id.slice(0, id.lastIndexOf('_'))))
}

describe('#1127 — a crash mid-delete must not strand unreachable chunks', () => {
  it('10. every chunk surviving an interrupted shred still has its index row', async () => {
    const { store: inner } = await seeded()
    // Control: the seeded vault is coherent to begin with, so a passing
    // assertion below means the crash left it coherent, not that the helper
    // never finds anything.
    expect(await orphanChunks(inner)).toEqual([])

    const { store, crashed } = crashOnFirstChunkDelete(inner)
    const db = await createNoydb({
      teamStrategy: withTeam(), blobsStrategy: withBlobs(),
      store, user: 'owner', secret: SECRET,
    })
    const vault = await db.openVault(VAULT)

    // A crash mid-delete does NOT surface as a rejection: the marked shred
    // path catches per-hold and files the eTag under `residue`
    // (`blob-set.ts:1290`). That silence is part of what made #1127 hard to
    // notice, and asserting on it here keeps the fixture honest about the
    // state a real crash leaves behind.
    const outcome = await vault
      .collection<{ ref: string }>('invoices').blob('inv-1').shredAllForRecord()
    expect(crashed(), 'the crash never fired — the fixture asserts nothing').toBe(true)
    expect(outcome.residue.length, 'the interrupted eTag should be reported as residue')
      .toBeGreaterThan(0)

    // THE PROPERTY. Under the old index-first order this is non-empty: the
    // index row is deleted before the throwing chunk delete, so every chunk of
    // that eTag is left unreachable.
    const orphans = await orphanChunks(inner)
    expect(orphans, `unreachable chunk bodies survived:\n  ${orphans.join('\n  ')}`).toEqual([])
  })

  it('11. after an interrupted shred, a revoked member still opens nothing', async () => {
    // Row 10 asserts the structural property; this asserts the consequence the
    // issue was actually filed about — that the interrupted state does not
    // defeat row 2's confidentiality invariant.
    const { store: inner, touched } = await seeded()
    const counts = await chunkCountsOf(inner)
    const { store } = crashOnFirstChunkDelete(inner)

    const db = await createNoydb({
      teamStrategy: withTeam(), blobsStrategy: withBlobs(),
      store, user: 'owner', secret: SECRET,
    })
    const vault = await db.openVault(VAULT)
    await vault.collection<{ ref: string }>('invoices').blob('inv-1').shredAllForRecord()

    await db.grant(VAULT, { userId: 'bob', displayName: 'B', role: 'admin', secret: 'bob-pass-1' })
    const bobDb = await createNoydb({
      teamStrategy: withTeam(), blobsStrategy: withBlobs(),
      store: inner, user: 'bob', secret: 'bob-pass-1',
    })
    const bobVault = await bobDb.openVault(VAULT)
    const retained = new Map((bobVault as unknown as {
      _introspectState(): { keyring: { deks: Map<string, EnclaveKey> } }
    })._introspectState().keyring.deks)
    expect(retained.has('_blob')).toBe(true)

    const before = await readableWith(inner, touched, retained, counts)
    expect(before.length, 'control: bob must open something before revoke').toBeGreaterThan(0)

    await db.revoke(VAULT, { userId: 'bob' })

    const residue = await readableWith(inner, touched, retained, counts)
    expect(residue, `retained keys still open after an interrupted shred:\n  ${residue.join('\n  ')}`)
      .toEqual([])
  })
})
