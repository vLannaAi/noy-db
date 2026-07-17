/**
 * #724 — an elevated record's blob content must be invisible to a tier-0
 * caller. Task 1: the runtime read gate. collection.blob(id) consults the
 * owning record's _tier before returning bytes, exactly as get() does.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, ConflictError, dekKey } from '../src/index.js'
import { withTiers } from '../src/with-audit/tiers/index.js'
import { withBlobs } from '../src/via/blob/index.js'
import { openEnvelopeJson, unwrapCek, type EnclaveKey } from '../src/kernel/enclave/index.js'
import { BLOB_INDEX_COLLECTION, BLOB_CHUNKS_COLLECTION } from '../src/with-shape/blobs/blob-set.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'

interface Doc {
  id: string
  title: string
  body: string
}

function memoryStore(): NoydbStore {
  const data = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const getColl = (v: string, c: string): Map<string, EncryptedEnvelope> => {
    let vm = data.get(v); if (!vm) { vm = new Map(); data.set(v, vm) }
    let cm = vm.get(c); if (!cm) { cm = new Map(); vm.set(c, cm) }
    return cm
  }
  return {
    name: 'memory',
    async get(v, c, id) { return data.get(v)?.get(c)?.get(id) ?? null },
    async put(v, c, id, env, ev) {
      const coll = getColl(v, c); const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(v, c, id) { data.get(v)?.get(c)?.delete(id) },
    async list(v, c) { return [...(data.get(v)?.get(c)?.keys() ?? [])] },
    async loadAll(v) {
      const vm = data.get(v); const snap: VaultSnapshot = {}
      if (vm) for (const [cn, cm] of vm) {
        const r: Record<string, EncryptedEnvelope> = {}
        for (const [id, e] of cm) r[id] = e
        snap[cn] = r
      }
      return snap
    },
    async saveAll(v, snap) {
      const vm = new Map<string, Map<string, EncryptedEnvelope>>()
      for (const [cn, recs] of Object.entries(snap)) {
        const cm = new Map<string, EncryptedEnvelope>()
        for (const [id, e] of Object.entries(recs)) cm.set(id, e)
        vm.set(cn, cm)
      }
      data.set(v, vm)
    },
  }
}

describe('#724 blob read gate', () => {
  it('a tiered collection with blobFields constructs (Arc-7 refusal removed)', async () => {
    const db = await createNoydb({
      store: memoryStore(), secret: 'pw', user: 'owner',
      tiersStrategy: withTiers(), blobStrategy: withBlobs(),
    })
    const vault = await db.openVault('v1')
    expect(() => vault.collection<Doc>('docs', {
      tiers: [0, 1], perRecordKeys: true, blobFields: { attachment: {} },
    })).not.toThrow()
  })

  it('elevating a blob-owning record hides its blob from a tier-0 caller', async () => {
    const db = await createNoydb({
      store: memoryStore(), secret: 'pw', user: 'owner',
      tiersStrategy: withTiers(), blobStrategy: withBlobs(),
    })
    const vault = await db.openVault('v1')
    const docs = vault.collection<Doc>('docs', {
      tiers: [0, 1], perRecordKeys: true, blobFields: { attachment: {} },
    })

    await docs.putAtTier('d1', { id: 'd1', title: 'Invoice', body: 'x' }, 0)
    await docs.blob('d1').put('attachment', new TextEncoder().encode('sensitive attachment bytes'))

    await docs.putAtTier('d2', { id: 'd2', title: 'Memo', body: 'y' }, 0)
    await docs.blob('d2').put('attachment', new TextEncoder().encode('sibling attachment bytes'))

    // Both readable before elevation.
    expect(await docs.blob('d1').get('attachment')).not.toBeNull()
    expect(await docs.blob('d2').get('attachment')).not.toBeNull()

    await docs.elevate('d1', 1)

    // The tier-0 read surface correctly treats the elevated record as invisible.
    await expect(docs.get('d1')).resolves.toBeNull()

    // The blob surface now mirrors that gate.
    expect(await docs.blob('d1').get('attachment')).toBeNull()

    // A sibling tier-0 record's blob is unaffected.
    const stillThere = await docs.blob('d2').get('attachment')
    expect(stillThere).not.toBeNull()
    expect(new TextDecoder().decode(stillThere!)).toBe('sibling attachment bytes')
  })
})

describe('#724 blob metadata gate', () => {
  it('list/blobInfo/listVersions on an elevated record are invisible to a tier-0 caller', async () => {
    const db = await createNoydb({
      store: memoryStore(), secret: 'pw', user: 'owner',
      tiersStrategy: withTiers(), blobStrategy: withBlobs(),
    })
    const vault = await db.openVault('v1')
    const docs = vault.collection<Doc>('docs', {
      tiers: [0, 1], perRecordKeys: true, blobFields: { attachment: {} },
    })

    await docs.putAtTier('d1', { id: 'd1', title: 'Invoice', body: 'x' }, 0)
    await docs.blob('d1').put('attachment', new TextEncoder().encode('sensitive attachment bytes'))

    await docs.putAtTier('d2', { id: 'd2', title: 'Memo', body: 'y' }, 0)
    await docs.blob('d2').put('attachment', new TextEncoder().encode('sibling attachment bytes'))

    // Metadata visible before elevation.
    expect(await docs.blob('d1').list()).not.toHaveLength(0)
    expect(await docs.blob('d1').blobInfo('attachment')).not.toBeNull()

    await docs.elevate('d1', 1)

    // The metadata accessors now mirror the content gate: invisible.
    expect(await docs.blob('d1').list()).toEqual([])
    expect(await docs.blob('d1').blobInfo('attachment')).toBeNull()
    expect(await docs.blob('d1').listVersions('attachment')).toEqual([])

    // A sibling tier-0 record's metadata is unaffected — the gate is
    // targeted, not global.
    expect(await docs.blob('d2').list()).not.toHaveLength(0)
    expect(await docs.blob('d2').blobInfo('attachment')).not.toBeNull()
  })
})

describe('#724 solo blob at-rest isolation', () => {
  it('elevate rewraps a solo blob’s CEK under the tier _blob DEK — undecryptable at tier 0', async () => {
    const store = memoryStore()
    const db = await createNoydb({
      store, secret: 'pw', user: 'owner',
      tiersStrategy: withTiers(), blobStrategy: withBlobs(),
    })
    const vault = await db.openVault('v1')
    const docs = vault.collection<Doc>('docs', {
      tiers: [0, 1], perRecordKeys: true, blobFields: { attachment: {} },
    })
    const getDEK = (vault as unknown as { getDEK(name: string): Promise<EnclaveKey> }).getDEK
    const tier0BlobDEK = await getDEK(dekKey('_blob', 0))
    const tier1BlobDEK = await getDEK(dekKey('_blob', 1))

    await docs.putAtTier('d1', { id: 'd1', title: 'Invoice', body: 'x' }, 0)
    await docs.blob('d1').put('attachment', new TextEncoder().encode('sensitive attachment bytes'))
    const info = await docs.blob('d1').blobInfo('attachment')
    expect(info!.refCount).toBe(1) // solo — exclusively owned by d1
    const eTag = info!.eTag

    // Sibling tier-0 solo blob — must be untouched by d1's elevation.
    await docs.putAtTier('d2', { id: 'd2', title: 'Memo', body: 'y' }, 0)
    await docs.blob('d2').put('attachment', new TextEncoder().encode('sibling attachment bytes'))
    const siblingETag = (await docs.blob('d2').blobInfo('attachment'))!.eTag

    const chunkBefore = await store.get('v1', BLOB_CHUNKS_COLLECTION, `${eTag}_0`)

    await docs.elevate('d1', 1)

    // Raw at-rest inspection: the BlobObject index envelope's own wrapper
    // key is untouched (still the flat tier-0 `_blob` DEK) — only the
    // wrapped content CEK carried inside it moved.
    const env = await store.get('v1', BLOB_INDEX_COLLECTION, eTag)
    expect(env).not.toBeNull()
    const blob = JSON.parse(await openEnvelopeJson(env!, tier0BlobDEK)) as { _cek?: string; refCount: number }
    expect(blob._cek).toBeDefined()

    // AT-REST GUARANTEE: no longer unwrappable under tier-0…
    await expect(unwrapCek(blob._cek!, tier0BlobDEK)).rejects.toThrow()
    // …but is under tier-1.
    await expect(unwrapCek(blob._cek!, tier1BlobDEK)).resolves.toBeDefined()

    // Chunks are byte-identical — the content CEK itself is unchanged, only
    // its wrapper moved. No chunk re-encryption.
    const chunkAfter = await store.get('v1', BLOB_CHUNKS_COLLECTION, `${eTag}_0`)
    expect(chunkAfter).toEqual(chunkBefore)

    // Sibling tier-0 blob is unaffected.
    const siblingEnv = await store.get('v1', BLOB_INDEX_COLLECTION, siblingETag)
    const siblingBlob = JSON.parse(await openEnvelopeJson(siblingEnv!, tier0BlobDEK)) as { _cek?: string }
    await expect(unwrapCek(siblingBlob._cek!, tier0BlobDEK)).resolves.toBeDefined()
  })

  it('putAtTier(>0) over a blob-owning record rewraps its solo blob CEK', async () => {
    const store = memoryStore()
    const db = await createNoydb({
      store, secret: 'pw', user: 'owner',
      tiersStrategy: withTiers(), blobStrategy: withBlobs(),
    })
    const vault = await db.openVault('v1')
    const docs = vault.collection<Doc>('docs', {
      tiers: [0, 1], perRecordKeys: true, blobFields: { attachment: {} },
    })
    const getDEK = (vault as unknown as { getDEK(name: string): Promise<EnclaveKey> }).getDEK
    const tier0BlobDEK = await getDEK(dekKey('_blob', 0))
    const tier1BlobDEK = await getDEK(dekKey('_blob', 1))

    await docs.putAtTier('d1', { id: 'd1', title: 'Invoice', body: 'x' }, 0)
    await docs.blob('d1').put('attachment', new TextEncoder().encode('sensitive bytes'))
    const eTag = (await docs.blob('d1').blobInfo('attachment'))!.eTag

    await docs.putAtTier('d1', { id: 'd1', title: 'Invoice', body: 'x2' }, 1)

    const env = await store.get('v1', BLOB_INDEX_COLLECTION, eTag)
    const blob = JSON.parse(await openEnvelopeJson(env!, tier0BlobDEK)) as { _cek?: string }
    await expect(unwrapCek(blob._cek!, tier0BlobDEK)).rejects.toThrow()
    await expect(unwrapCek(blob._cek!, tier1BlobDEK)).resolves.toBeDefined()
  })

  it('a tiered collection with NO blobFields — syncBlobs is a fast no-op', async () => {
    // No blobStrategy passed — the default NO_BLOBS stub throws if
    // `.blob(id)` is ever reached. hasBlobFields being false must keep
    // syncBlobs from calling it at all.
    const db = await createNoydb({
      store: memoryStore(), secret: 'pw', user: 'owner',
      tiersStrategy: withTiers(),
    })
    const vault = await db.openVault('v1')
    const docs = vault.collection<Doc>('docs', { tiers: [0, 1] })

    await docs.putAtTier('d1', { id: 'd1', title: 'Invoice', body: 'x' }, 0)
    await expect(docs.elevate('d1', 1)).resolves.toBeUndefined()
    // Ordinary elevated-record behavior, unaffected by the no-op.
    await expect(docs.get('d1')).resolves.toBeNull()
  })
})

describe('#724 shared blob — blobTierPolicy', () => {
  it('isolate (default): elevating one co-owner forks a private tier-scoped copy; the tier-0 co-owner is untouched', async () => {
    const store = memoryStore()
    const db = await createNoydb({
      store, secret: 'pw', user: 'owner',
      tiersStrategy: withTiers(), blobStrategy: withBlobs(),
    })
    const vault = await db.openVault('v1')
    const docs = vault.collection<Doc>('docs', {
      tiers: [0, 1], perRecordKeys: true, blobFields: { attachment: {} },
    })
    const getDEK = (vault as unknown as { getDEK(name: string): Promise<EnclaveKey> }).getDEK
    const tier0BlobDEK = await getDEK(dekKey('_blob', 0))
    const tier1BlobDEK = await getDEK(dekKey('_blob', 1))
    const collDEK1 = await getDEK(dekKey('docs', 1))

    const bytes = new TextEncoder().encode('identical shared bytes')
    await docs.putAtTier('a', { id: 'a', title: 'A', body: 'x' }, 0)
    await docs.blob('a').put('attachment', bytes)
    await docs.putAtTier('b', { id: 'b', title: 'B', body: 'y' }, 0)
    await docs.blob('b').put('attachment', bytes)

    const sharedETag = (await docs.blob('a').blobInfo('attachment'))!.eTag
    expect((await docs.blob('b').blobInfo('attachment'))!.eTag).toBe(sharedETag)
    expect((await docs.blob('a').blobInfo('attachment'))!.refCount).toBe(2)

    await docs.elevate('b', 1)

    // b's blob API is gated post-elevation (mirrors get()) — inspect the
    // slot map at rest instead, same as the solo-blob tests above. #724
    // Task 4: the slot map itself moved to the tier-1 collection DEK.
    const slotsEnv = await store.get('v1', '_blob_slots_docs', 'b')
    expect(slotsEnv).not.toBeNull()
    const slots = JSON.parse(await openEnvelopeJson(slotsEnv!, collDEK1)) as Record<string, { eTag: string }>
    const newETag = slots.attachment!.eTag
    expect(newETag).not.toBe(sharedETag)

    // The new object's `_cek` unwraps under the tier-1 `_blob` DEK, not tier-0.
    const newEnv = await store.get('v1', BLOB_INDEX_COLLECTION, newETag)
    expect(newEnv).not.toBeNull()
    const newBlob = JSON.parse(await openEnvelopeJson(newEnv!, tier0BlobDEK)) as { _cek?: string; refCount: number }
    expect(newBlob.refCount).toBe(1)
    expect(newBlob._cek).toBeDefined()
    await expect(unwrapCek(newBlob._cek!, tier0BlobDEK)).rejects.toThrow()
    await expect(unwrapCek(newBlob._cek!, tier1BlobDEK)).resolves.toBeDefined()

    // The OLD shared object survives — refCount decremented to 1 (a's hold).
    const oldEnv = await store.get('v1', BLOB_INDEX_COLLECTION, sharedETag)
    const oldBlob = JSON.parse(await openEnvelopeJson(oldEnv!, tier0BlobDEK)) as { refCount: number }
    expect(oldBlob.refCount).toBe(1)

    // 'a' (tier0) still reads its blob bytes intact — byte-for-byte untouched.
    const aBytes = await docs.blob('a').get('attachment')
    expect(aBytes).not.toBeNull()
    expect(new TextDecoder().decode(aBytes!)).toBe('identical shared bytes')
  })

  it('dedup (#741): the shared object is left in place; a tier-0 caller is refused by the read gate; at-rest residue asserted', async () => {
    const store = memoryStore()
    const db = await createNoydb({
      store, secret: 'pw', user: 'owner',
      tiersStrategy: withTiers(), blobStrategy: withBlobs(),
    })
    const vault = await db.openVault('v1')
    const docs = vault.collection<Doc>('docs', {
      tiers: [0, 1], perRecordKeys: true, blobFields: { attachment: {} },
      blobTierPolicy: 'dedup',
    })
    const getDEK = (vault as unknown as { getDEK(name: string): Promise<EnclaveKey> }).getDEK
    const tier0BlobDEK = await getDEK(dekKey('_blob', 0))
    const collDEK1 = await getDEK(dekKey('docs', 1))

    const bytes = new TextEncoder().encode('identical shared bytes (dedup mode)')
    await docs.putAtTier('a', { id: 'a', title: 'A', body: 'x' }, 0)
    await docs.blob('a').put('attachment', bytes)
    await docs.putAtTier('b', { id: 'b', title: 'B', body: 'y' }, 0)
    await docs.blob('b').put('attachment', bytes)

    const sharedETag = (await docs.blob('a').blobInfo('attachment'))!.eTag
    expect((await docs.blob('a').blobInfo('attachment'))!.refCount).toBe(2)

    await docs.elevate('b', 1)

    // b's slot STILL points at the shared eTag — no fork in dedup mode.
    // #724 Task 4: the slot map (metadata) still moves to the tier-1
    // collection DEK even under 'dedup' policy — only the SHARED BLOB
    // OBJECT'S residue is the documented exception, not the per-record slot
    // map.
    const slotsEnv = await store.get('v1', '_blob_slots_docs', 'b')
    const slots = JSON.parse(await openEnvelopeJson(slotsEnv!, collDEK1)) as Record<string, { eTag: string }>
    expect(slots.attachment!.eTag).toBe(sharedETag)

    // The shared object is untouched — refCount still 2, no release.
    const env = await store.get('v1', BLOB_INDEX_COLLECTION, sharedETag)
    const blob = JSON.parse(await openEnvelopeJson(env!, tier0BlobDEK)) as { _cek?: string; refCount: number }
    expect(blob.refCount).toBe(2)

    // Documented residue: the wrapped content CEK is STILL openable under
    // the flat tier-0 `_blob` DEK — the chunks stay decryptable at rest.
    await expect(unwrapCek(blob._cek!, tier0BlobDEK)).resolves.toBeDefined()

    // A tier-0 caller is nonetheless refused at runtime by the Task-1 read gate.
    expect(await docs.blob('b').get('attachment')).toBeNull()

    // 'a' (tier0) is unaffected.
    const aBytes = await docs.blob('a').get('attachment')
    expect(aBytes).not.toBeNull()
    expect(new TextDecoder().decode(aBytes!)).toBe('identical shared bytes (dedup mode)')
  })
})

describe('#724 slot-map metadata + reversibility (Arc 10 Task 4)', () => {
  it('after elevate the slot map (filenames/eTags) is not readable under the parent-collection tier-0 DEK — and is again after demote', async () => {
    const store = memoryStore()
    const db = await createNoydb({
      store, secret: 'pw', user: 'owner',
      tiersStrategy: withTiers(), blobStrategy: withBlobs(),
    })
    const vault = await db.openVault('v1')
    const docs = vault.collection<Doc>('docs', {
      tiers: [0, 1], perRecordKeys: true, blobFields: { attachment: {} },
    })
    const getDEK = (vault as unknown as { getDEK(name: string): Promise<EnclaveKey> }).getDEK
    const collDEK0 = await getDEK('docs')
    const collDEK1 = await getDEK(dekKey('docs', 1))

    await docs.putAtTier('d1', { id: 'd1', title: 'Invoice', body: 'x' }, 0)
    await docs.blob('d1').put(
      'attachment',
      new TextEncoder().encode('slot map secret filename bytes'),
      { filename: 'invoice.pdf' },
    )

    // Before elevation: the slot map decrypts under the tier-0 collection DEK.
    const slotsEnvBefore = await store.get('v1', '_blob_slots_docs', 'd1')
    expect(slotsEnvBefore).not.toBeNull()
    await expect(openEnvelopeJson(slotsEnvBefore!, collDEK0)).resolves.toBeDefined()

    await docs.elevate('d1', 1)

    const slotsEnvElevated = await store.get('v1', '_blob_slots_docs', 'd1')
    expect(slotsEnvElevated).not.toBeNull()
    // AT-REST GUARANTEE: no longer openable under the parent-collection
    // tier-0 DEK…
    await expect(openEnvelopeJson(slotsEnvElevated!, collDEK0)).rejects.toThrow()
    // …but is under the tier-1 collection DEK, and the metadata is intact.
    const slots = JSON.parse(await openEnvelopeJson(slotsEnvElevated!, collDEK1)) as Record<string, { filename: string }>
    expect(slots.attachment!.filename).toBe('invoice.pdf')

    await docs.demote('d1', 0)

    const slotsEnvDemoted = await store.get('v1', '_blob_slots_docs', 'd1')
    expect(slotsEnvDemoted).not.toBeNull()
    const restoredSlots = JSON.parse(await openEnvelopeJson(slotsEnvDemoted!, collDEK0)) as Record<string, { filename: string }>
    expect(restoredSlots.attachment!.filename).toBe('invoice.pdf')
  })

  it('demote restores tier-0 readability for a solo blob — CEK unwraps under the tier-0 _blob DEK again', async () => {
    const store = memoryStore()
    const db = await createNoydb({
      store, secret: 'pw', user: 'owner',
      tiersStrategy: withTiers(), blobStrategy: withBlobs(),
    })
    const vault = await db.openVault('v1')
    const docs = vault.collection<Doc>('docs', {
      tiers: [0, 1], perRecordKeys: true, blobFields: { attachment: {} },
    })
    const getDEK = (vault as unknown as { getDEK(name: string): Promise<EnclaveKey> }).getDEK
    const tier0BlobDEK = await getDEK(dekKey('_blob', 0))

    await docs.putAtTier('d1', { id: 'd1', title: 'Invoice', body: 'x' }, 0)
    await docs.blob('d1').put('attachment', new TextEncoder().encode('solo reversible bytes'))
    const eTag = (await docs.blob('d1').blobInfo('attachment'))!.eTag

    await docs.elevate('d1', 1)
    expect(await docs.blob('d1').get('attachment')).toBeNull() // gated while elevated

    await docs.demote('d1', 0)

    const bytes = await docs.blob('d1').get('attachment')
    expect(bytes).not.toBeNull()
    expect(new TextDecoder().decode(bytes!)).toBe('solo reversible bytes')

    // Same eTag throughout — solo blobs never mint a new address.
    expect((await docs.blob('d1').blobInfo('attachment'))!.eTag).toBe(eTag)

    const env = await store.get('v1', BLOB_INDEX_COLLECTION, eTag)
    const blob = JSON.parse(await openEnvelopeJson(env!, tier0BlobDEK)) as { _cek?: string }
    await expect(unwrapCek(blob._cek!, tier0BlobDEK)).resolves.toBeDefined()
  })

  it('demote of an isolate-forked shared blob re-joins the tier-0 dedup pool if the eTag already exists there', async () => {
    const store = memoryStore()
    const db = await createNoydb({
      store, secret: 'pw', user: 'owner',
      tiersStrategy: withTiers(), blobStrategy: withBlobs(),
    })
    const vault = await db.openVault('v1')
    const docs = vault.collection<Doc>('docs', {
      tiers: [0, 1], perRecordKeys: true, blobFields: { attachment: {} },
    })
    const getDEK = (vault as unknown as { getDEK(name: string): Promise<EnclaveKey> }).getDEK
    const tier0BlobDEK = await getDEK(dekKey('_blob', 0))
    const collDEK1 = await getDEK(dekKey('docs', 1))

    const bytes = new TextEncoder().encode('identical shared bytes for reversibility')
    await docs.putAtTier('a', { id: 'a', title: 'A', body: 'x' }, 0)
    await docs.blob('a').put('attachment', bytes)
    await docs.putAtTier('b', { id: 'b', title: 'B', body: 'y' }, 0)
    await docs.blob('b').put('attachment', bytes)

    const sharedETag = (await docs.blob('a').blobInfo('attachment'))!.eTag
    expect((await docs.blob('a').blobInfo('attachment'))!.refCount).toBe(2)

    await docs.elevate('b', 1) // forks a private tier-1-scoped copy for b

    // Capture the forked eTag via a raw slot-map read (b's blob API is
    // gated post-elevation).
    const slotsEnv = await store.get('v1', '_blob_slots_docs', 'b')
    const slots = JSON.parse(await openEnvelopeJson(slotsEnv!, collDEK1)) as Record<string, { eTag: string }>
    const forkedETag = slots.attachment!.eTag
    expect(forkedETag).not.toBe(sharedETag)

    await docs.demote('b', 0)

    // b reads intact again, as a tier-0 caller.
    const bBytes = await docs.blob('b').get('attachment')
    expect(bBytes).not.toBeNull()
    expect(new TextDecoder().decode(bBytes!)).toBe('identical shared bytes for reversibility')

    // b's eTag is back to the ORIGINAL shared tier-0 address — rejoined the pool.
    const bInfo = await docs.blob('b').blobInfo('attachment')
    expect(bInfo!.eTag).toBe(sharedETag)

    // The shared object's refCount is back to 2 (a + b), same object.
    const rejoinedInfo = await docs.blob('a').blobInfo('attachment')
    expect(rejoinedInfo!.refCount).toBe(2)

    const env = await store.get('v1', BLOB_INDEX_COLLECTION, sharedETag)
    const blob = JSON.parse(await openEnvelopeJson(env!, tier0BlobDEK)) as { _cek?: string; refCount: number }
    await expect(unwrapCek(blob._cek!, tier0BlobDEK)).resolves.toBeDefined()
    expect(blob.refCount).toBe(2)

    // The orphaned fork object (b's private tier-1 copy, refCount 1 →
    // released on reconcile) is gone — no leftover private duplicate.
    const forkedEnv = await store.get('v1', BLOB_INDEX_COLLECTION, forkedETag)
    expect(forkedEnv).toBeNull()

    // 'a' still reads its blob bytes intact.
    const aBytes = await docs.blob('a').get('attachment')
    expect(new TextDecoder().decode(aBytes!)).toBe('identical shared bytes for reversibility')
  })

  it('elevate → demote → elevate round-trips cleanly (blob readable at the current tier each time)', async () => {
    const store = memoryStore()
    const db = await createNoydb({
      store, secret: 'pw', user: 'owner',
      tiersStrategy: withTiers(), blobStrategy: withBlobs(),
    })
    const vault = await db.openVault('v1')
    const docs = vault.collection<Doc>('docs', {
      tiers: [0, 1], perRecordKeys: true, blobFields: { attachment: {} },
    })
    const getDEK = (vault as unknown as { getDEK(name: string): Promise<EnclaveKey> }).getDEK
    const tier0BlobDEK = await getDEK(dekKey('_blob', 0))
    const tier1BlobDEK = await getDEK(dekKey('_blob', 1))

    await docs.putAtTier('d1', { id: 'd1', title: 'Invoice', body: 'x' }, 0)
    await docs.blob('d1').put('attachment', new TextEncoder().encode('round trip bytes'))
    const originalETag = (await docs.blob('d1').blobInfo('attachment'))!.eTag

    await docs.elevate('d1', 1)
    let env = await store.get('v1', BLOB_INDEX_COLLECTION, originalETag)
    let blob = JSON.parse(await openEnvelopeJson(env!, tier0BlobDEK)) as { _cek?: string }
    await expect(unwrapCek(blob._cek!, tier1BlobDEK)).resolves.toBeDefined()
    await expect(unwrapCek(blob._cek!, tier0BlobDEK)).rejects.toThrow()
    expect(await docs.blob('d1').get('attachment')).toBeNull() // gated while elevated

    await docs.demote('d1', 0)
    const bytesAfterFirstRoundtrip = await docs.blob('d1').get('attachment')
    expect(new TextDecoder().decode(bytesAfterFirstRoundtrip!)).toBe('round trip bytes')

    await docs.elevate('d1', 1)
    env = await store.get('v1', BLOB_INDEX_COLLECTION, originalETag)
    blob = JSON.parse(await openEnvelopeJson(env!, tier0BlobDEK)) as { _cek?: string }
    await expect(unwrapCek(blob._cek!, tier1BlobDEK)).resolves.toBeDefined()
    await expect(unwrapCek(blob._cek!, tier0BlobDEK)).rejects.toThrow()
    expect(await docs.blob('d1').get('attachment')).toBeNull() // gated again while elevated

    // eTag stable across the whole round-trip — no orphan minted.
    expect((await store.list('v1', BLOB_INDEX_COLLECTION)).length).toBe(1)
  })

  it('multi-slot fork: a record holding the same eTag under two slots forks both to one new tier-scoped object; refCounts reconcile', async () => {
    const store = memoryStore()
    const db = await createNoydb({
      store, secret: 'pw', user: 'owner',
      tiersStrategy: withTiers(), blobStrategy: withBlobs(),
    })
    const vault = await db.openVault('v1')
    const docs = vault.collection<Doc>('docs', {
      tiers: [0, 1], perRecordKeys: true, blobFields: { slotA: {}, slotB: {} },
    })
    const getDEK = (vault as unknown as { getDEK(name: string): Promise<EnclaveKey> }).getDEK
    const tier0BlobDEK = await getDEK(dekKey('_blob', 0))
    const tier1BlobDEK = await getDEK(dekKey('_blob', 1))
    const collDEK1 = await getDEK(dekKey('docs', 1))

    const bytes = new TextEncoder().encode('multi-slot shared bytes')
    await docs.putAtTier('a', { id: 'a', title: 'A', body: 'x' }, 0)
    await docs.blob('a').put('slotA', bytes)

    await docs.putAtTier('b', { id: 'b', title: 'B', body: 'y' }, 0)
    await docs.blob('b').put('slotA', bytes)
    await docs.blob('b').put('slotB', bytes)

    const sharedETag = (await docs.blob('a').blobInfo('slotA'))!.eTag
    expect((await docs.blob('b').blobInfo('slotA'))!.eTag).toBe(sharedETag)
    expect((await docs.blob('b').blobInfo('slotB'))!.eTag).toBe(sharedETag)
    // 3 holds total: a's slotA + b's slotA + b's slotB.
    expect((await docs.blob('a').blobInfo('slotA'))!.refCount).toBe(3)

    await docs.elevate('b', 1)

    // Inspect b's slot map at rest (its blob API is gated post-elevation).
    const slotsEnv = await store.get('v1', '_blob_slots_docs', 'b')
    const slots = JSON.parse(await openEnvelopeJson(slotsEnv!, collDEK1)) as Record<string, { eTag: string }>
    const newETag = slots.slotA!.eTag
    expect(slots.slotB!.eTag).toBe(newETag) // BOTH slots repoint to the SAME new eTag
    expect(newETag).not.toBe(sharedETag)

    // The new object holds BOTH of b's references — refCount 2.
    const newEnv = await store.get('v1', BLOB_INDEX_COLLECTION, newETag)
    const newBlob = JSON.parse(await openEnvelopeJson(newEnv!, tier0BlobDEK)) as { refCount: number; _cek?: string }
    expect(newBlob.refCount).toBe(2)
    await expect(unwrapCek(newBlob._cek!, tier1BlobDEK)).resolves.toBeDefined()
    await expect(unwrapCek(newBlob._cek!, tier0BlobDEK)).rejects.toThrow()

    // The OLD shared object's refCount dropped from 3 to 1 (a's remaining hold).
    const oldEnv = await store.get('v1', BLOB_INDEX_COLLECTION, sharedETag)
    const oldBlob = JSON.parse(await openEnvelopeJson(oldEnv!, tier0BlobDEK)) as { refCount: number }
    expect(oldBlob.refCount).toBe(1)

    // 'a' still reads its blob bytes intact.
    const aBytes = await docs.blob('a').get('slotA')
    expect(aBytes).not.toBeNull()
    expect(new TextDecoder().decode(aBytes!)).toBe('multi-slot shared bytes')
  })
})
