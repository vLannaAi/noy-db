/**
 * #724 — an elevated record's blob content must be invisible to a tier-0
 * caller. Task 1: the runtime read gate. collection.blob(id) consults the
 * owning record's _tier before returning bytes, exactly as get() does.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, ConflictError, dekKey, UnsupportedTierCompositionError } from '../src/index.js'
import { withTiers } from '../src/with-audit/tiers/index.js'
import { withBlobs } from '../src/via/blob/index.js'
import { withForgetCascade } from '../src/with-audit/forget/index.js'
import { withHistory } from '../src/with-commit/history/index.js'
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
  it('elevate RE-PUTS a solo blob under a tier-scoped eTag — the old tier-0 address is crypto-shredded, undecryptable at tier 0', async () => {
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

    await docs.putAtTier('d1', { id: 'd1', title: 'Invoice', body: 'x' }, 0)
    await docs.blob('d1').put('attachment', new TextEncoder().encode('sensitive attachment bytes'))
    const info = await docs.blob('d1').blobInfo('attachment')
    expect(info!.refCount).toBe(1) // solo — exclusively owned by d1
    const oldETag = info!.eTag

    // Sibling tier-0 solo blob — must be untouched by d1's elevation.
    await docs.putAtTier('d2', { id: 'd2', title: 'Memo', body: 'y' }, 0)
    await docs.blob('d2').put('attachment', new TextEncoder().encode('sibling attachment bytes'))
    const siblingETag = (await docs.blob('d2').blobInfo('attachment'))!.eTag

    await docs.elevate('d1', 1)

    // #724 correction: solo re-PUTS instead of rewrapping in place — the
    // OLD tier-0 address drops to refCount 0 and is crypto-shredded (both
    // the index entry and its chunk are gone), closing C1 (a same-bytes
    // tier-0 put could otherwise dedup-hit this address).
    expect(await store.get('v1', BLOB_INDEX_COLLECTION, oldETag)).toBeNull()
    expect(await store.get('v1', BLOB_CHUNKS_COLLECTION, `${oldETag}_0`)).toBeNull()

    // The NEW tier-scoped eTag lives in the slot map (Task 4: moved to the
    // tier-1 collection DEK).
    const slotsEnv = await store.get('v1', '_blob_slots_docs', 'd1')
    const slots = JSON.parse(await openEnvelopeJson(slotsEnv!, collDEK1)) as Record<string, { eTag: string }>
    const newETag = slots.attachment!.eTag
    expect(newETag).not.toBe(oldETag)

    const env = await store.get('v1', BLOB_INDEX_COLLECTION, newETag)
    expect(env).not.toBeNull()
    // Raw at-rest inspection: the BlobObject index envelope's own wrapper
    // key is untouched (still the flat tier-0 `_blob` DEK) — only the
    // wrapped content CEK carried inside it is tier-scoped.
    const blob = JSON.parse(await openEnvelopeJson(env!, tier0BlobDEK)) as { _cek?: string; refCount: number }
    expect(blob._cek).toBeDefined()

    // AT-REST GUARANTEE: no longer unwrappable under tier-0…
    await expect(unwrapCek(blob._cek!, tier0BlobDEK)).rejects.toThrow()
    // …but is under tier-1.
    await expect(unwrapCek(blob._cek!, tier1BlobDEK)).resolves.toBeDefined()

    // Sibling tier-0 blob is unaffected.
    const siblingEnv = await store.get('v1', BLOB_INDEX_COLLECTION, siblingETag)
    const siblingBlob = JSON.parse(await openEnvelopeJson(siblingEnv!, tier0BlobDEK)) as { _cek?: string }
    await expect(unwrapCek(siblingBlob._cek!, tier0BlobDEK)).resolves.toBeDefined()
  })

  it('putAtTier(>0) over a blob-owning record RE-PUTS its solo blob under a tier-scoped eTag', async () => {
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

    await docs.putAtTier('d1', { id: 'd1', title: 'Invoice', body: 'x' }, 0)
    await docs.blob('d1').put('attachment', new TextEncoder().encode('sensitive bytes'))
    const oldETag = (await docs.blob('d1').blobInfo('attachment'))!.eTag

    await docs.putAtTier('d1', { id: 'd1', title: 'Invoice', body: 'x2' }, 1)

    // The old tier-0 address is crypto-shredded (solo, refCount → 0).
    expect(await store.get('v1', BLOB_INDEX_COLLECTION, oldETag)).toBeNull()

    const slotsEnv = await store.get('v1', '_blob_slots_docs', 'd1')
    const slots = JSON.parse(await openEnvelopeJson(slotsEnv!, collDEK1)) as Record<string, { eTag: string }>
    const newETag = slots.attachment!.eTag
    expect(newETag).not.toBe(oldETag)

    const env = await store.get('v1', BLOB_INDEX_COLLECTION, newETag)
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

    // #724 correction: elevate/demote each RE-PUT (mint a fresh tier-scoped
    // eTag, crypto-shredding the old address) rather than rewrap in place —
    // but the eTag is a deterministic HMAC(blobDEK, plaintext), so demoting
    // back to tier 0 with the same plaintext naturally reproduces the
    // ORIGINAL tier-0 eTag (a fresh BlobObject minted at that same address).
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

  it('elevate → demote → elevate round-trips cleanly (blob readable at the current tier each time, exactly one live object at all times)', async () => {
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

    await docs.putAtTier('d1', { id: 'd1', title: 'Invoice', body: 'x' }, 0)
    await docs.blob('d1').put('attachment', new TextEncoder().encode('round trip bytes'))
    const originalETag = (await docs.blob('d1').blobInfo('attachment'))!.eTag

    // #724 correction: elevate RE-PUTS (solo→re-put unification), so the
    // live address is now the tier-scoped one, not `originalETag` — read it
    // via the (tier-1-keyed) slot map, mirroring the other rest-of-suite
    // post-elevation inspections.
    await docs.elevate('d1', 1)
    const slotsAfterFirstElevate = JSON.parse(
      await openEnvelopeJson((await store.get('v1', '_blob_slots_docs', 'd1'))!, collDEK1),
    ) as Record<string, { eTag: string }>
    const elevatedETag = slotsAfterFirstElevate.attachment!.eTag
    expect(elevatedETag).not.toBe(originalETag)
    expect(await store.get('v1', BLOB_INDEX_COLLECTION, originalETag)).toBeNull() // old address crypto-shredded
    let env = await store.get('v1', BLOB_INDEX_COLLECTION, elevatedETag)
    let blob = JSON.parse(await openEnvelopeJson(env!, tier0BlobDEK)) as { _cek?: string }
    await expect(unwrapCek(blob._cek!, tier1BlobDEK)).resolves.toBeDefined()
    await expect(unwrapCek(blob._cek!, tier0BlobDEK)).rejects.toThrow()
    expect(await docs.blob('d1').get('attachment')).toBeNull() // gated while elevated

    await docs.demote('d1', 0)
    const bytesAfterFirstRoundtrip = await docs.blob('d1').get('attachment')
    expect(new TextDecoder().decode(bytesAfterFirstRoundtrip!)).toBe('round trip bytes')
    // Demote re-derives the eTag under the SAME tier-0 DEK + plaintext —
    // content-addressing is deterministic, so it naturally lands back on
    // `originalETag` (a fresh BlobObject minted at that address; the
    // elevated copy was released and crypto-shredded).
    expect((await docs.blob('d1').blobInfo('attachment'))!.eTag).toBe(originalETag)
    expect(await store.get('v1', BLOB_INDEX_COLLECTION, elevatedETag)).toBeNull()

    await docs.elevate('d1', 1)
    const slotsAfterSecondElevate = JSON.parse(
      await openEnvelopeJson((await store.get('v1', '_blob_slots_docs', 'd1'))!, collDEK1),
    ) as Record<string, { eTag: string }>
    // Deterministic HMAC under the same tier-1 DEK + plaintext reproduces
    // the SAME tier-scoped eTag as the first elevation.
    expect(slotsAfterSecondElevate.attachment!.eTag).toBe(elevatedETag)
    env = await store.get('v1', BLOB_INDEX_COLLECTION, elevatedETag)
    blob = JSON.parse(await openEnvelopeJson(env!, tier0BlobDEK)) as { _cek?: string }
    await expect(unwrapCek(blob._cek!, tier1BlobDEK)).resolves.toBeDefined()
    await expect(unwrapCek(blob._cek!, tier0BlobDEK)).rejects.toThrow()
    expect(await docs.blob('d1').get('attachment')).toBeNull() // gated again while elevated

    // Exactly one live object at all times — the old address is always
    // crypto-shredded before/at the point the new one is minted, no orphan.
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

describe('#724 tier-scoped eTag (C1/C2)', () => {
  it('C1a: a tier-0 record writing the SAME bytes as an elevated record reads its own blob intact — no cross-tier dedup collision', async () => {
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
    const collDEK1 = await getDEK(dekKey('docs', 1))
    const X = new TextEncoder().encode('identical bytes across tiers')

    await docs.putAtTier('d1', { id: 'd1', title: 'A', body: 'x' }, 0)
    await docs.blob('d1').put('attachment', X)
    await docs.elevate('d1', 1)

    await docs.putAtTier('d2', { id: 'd2', title: 'B', body: 'y' }, 0)
    await docs.blob('d2').put('attachment', X) // same bytes → must NOT collide with d1's tier-1 address

    // d2 is a plain tier-0 record; its own blob must be readable intact.
    const got = await docs.blob('d2').get('attachment')
    expect(got).not.toBeNull()
    expect(new TextDecoder().decode(got!)).toBe('identical bytes across tiers')

    // d1's (tier-scoped) eTag and d2's (tier-0-native) eTag are DIFFERENT.
    const d2ETag = (await docs.blob('d2').blobInfo('attachment'))!.eTag
    const slotsEnv = await store.get('v1', '_blob_slots_docs', 'd1')
    const slots = JSON.parse(await openEnvelopeJson(slotsEnv!, collDEK1)) as Record<string, { eTag: string }>
    const d1ETag = slots.attachment!.eTag
    expect(d1ETag).not.toBe(d2ETag)
  })

  it('C1b: demoting the elevated record back to tier 0 restores its own blob readability', async () => {
    const store = memoryStore()
    const db = await createNoydb({
      store, secret: 'pw', user: 'owner',
      tiersStrategy: withTiers(), blobStrategy: withBlobs(),
    })
    const vault = await db.openVault('v1')
    const docs = vault.collection<Doc>('docs', {
      tiers: [0, 1], perRecordKeys: true, blobFields: { attachment: {} },
    })
    const X = new TextEncoder().encode('identical bytes across tiers 2')

    await docs.putAtTier('d1', { id: 'd1', title: 'A', body: 'x' }, 0)
    await docs.blob('d1').put('attachment', X)
    await docs.elevate('d1', 1)

    await docs.putAtTier('d2', { id: 'd2', title: 'B', body: 'y' }, 0)
    await docs.blob('d2').put('attachment', X)

    await docs.demote('d1', 0)
    const got = await docs.blob('d1').get('attachment')
    expect(got).not.toBeNull()
    expect(new TextDecoder().decode(got!)).toBe('identical bytes across tiers 2')
  })

  it('C2: a blob written to an ALREADY-elevated record is tier-scoped from birth — the raw _cek does not unwrap under the tier-0 _blob DEK', async () => {
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

    await docs.putAtTier('d1', { id: 'd1', title: 'A', body: 'x' }, 0)
    await docs.elevate('d1', 1)

    // Owner (fully cleared) attaches a blob to the already-elevated record.
    await docs.blob('d1').put('attachment', new TextEncoder().encode('post-elevation secret'))

    // Find the eTag via the (tier-1-keyed) slot map.
    const slotsEnv = await store.get('v1', '_blob_slots_docs', 'd1')
    expect(slotsEnv).not.toBeNull()
    const slots = JSON.parse(await openEnvelopeJson(slotsEnv!, collDEK1)) as Record<string, { eTag: string }>
    const eTag = slots.attachment!.eTag

    const env = await store.get('v1', BLOB_INDEX_COLLECTION, eTag)
    expect(env).not.toBeNull()
    const blob = JSON.parse(await openEnvelopeJson(env!, tier0BlobDEK)) as { _cek?: string }
    expect(blob._cek).toBeDefined()

    await expect(unwrapCek(blob._cek!, tier0BlobDEK)).rejects.toThrow()
    await expect(unwrapCek(blob._cek!, tier1BlobDEK)).resolves.toBeDefined()
  })
})

describe('#724 versions follow tier (C4)', () => {
  it('elevate moves a published version off tier 0 — content _cek AND the version record itself', async () => {
    const store = memoryStore()
    const db = await createNoydb({
      store, secret: 'pw', user: 'owner',
      tiersStrategy: withTiers(), blobStrategy: withBlobs(),
    })
    const vault = await db.openVault('v1')
    const docs = vault.collection<Doc>('docs', {
      tiers: [0, 1], perRecordKeys: true, blobFields: { slot: {} },
    })
    const getDEK = (vault as unknown as { getDEK(name: string): Promise<EnclaveKey> }).getDEK
    const tier0BlobDEK = await getDEK(dekKey('_blob', 0))
    const tier1BlobDEK = await getDEK(dekKey('_blob', 1))
    const collDEK0 = await getDEK('docs')
    const collDEK1 = await getDEK(dekKey('docs', 1))

    await docs.putAtTier('d1', { id: 'd1', title: 'A', body: 'x' }, 0)
    await docs.blob('d1').put('slot', new TextEncoder().encode('versioned secret v1'))
    await docs.blob('d1').publish('slot', 'v1')

    // Before elevation: the version record decrypts under the tier-0 collection DEK.
    const versionEnvBefore = await store.get('v1', '_blob_versions_docs', 'd1::slot::v1')
    expect(versionEnvBefore).not.toBeNull()
    await expect(openEnvelopeJson(versionEnvBefore!, collDEK0)).resolves.toBeDefined()

    await docs.elevate('d1', 1)

    // AT-REST GUARANTEE 1: the version RECORD (label/eTag/timestamps) is no
    // longer openable under the parent-collection tier-0 DEK...
    const versionEnvAfter = await store.get('v1', '_blob_versions_docs', 'd1::slot::v1')
    expect(versionEnvAfter).not.toBeNull()
    await expect(openEnvelopeJson(versionEnvAfter!, collDEK0)).rejects.toThrow()
    // ...but is under the tier-1 collection DEK, and the metadata is intact.
    const record = JSON.parse(await openEnvelopeJson(versionEnvAfter!, collDEK1)) as { label: string; eTag: string }
    expect(record.label).toBe('v1')

    // AT-REST GUARANTEE 2: the version-HELD blob content's _cek must NOT
    // unwrap under the tier-0 `_blob` DEK, only under the tier-1 one.
    const blobEnv = await store.get('v1', BLOB_INDEX_COLLECTION, record.eTag)
    expect(blobEnv).not.toBeNull()
    const blob = JSON.parse(await openEnvelopeJson(blobEnv!, tier0BlobDEK)) as { _cek?: string }
    expect(blob._cek).toBeDefined()
    await expect(unwrapCek(blob._cek!, tier0BlobDEK)).rejects.toThrow()
    await expect(unwrapCek(blob._cek!, tier1BlobDEK)).resolves.toBeDefined()
  })

  it('a version whose eTag left the slot map (slot overwritten after publish) is STILL rehomed on elevate', async () => {
    const store = memoryStore()
    const db = await createNoydb({
      store, secret: 'pw', user: 'owner',
      tiersStrategy: withTiers(), blobStrategy: withBlobs(),
    })
    const vault = await db.openVault('v1')
    const docs = vault.collection<Doc>('docs', {
      tiers: [0, 1], perRecordKeys: true, blobFields: { slot: {} },
    })
    const getDEK = (vault as unknown as { getDEK(name: string): Promise<EnclaveKey> }).getDEK
    const tier0BlobDEK = await getDEK(dekKey('_blob', 0))
    const tier1BlobDEK = await getDEK(dekKey('_blob', 1))
    const collDEK1 = await getDEK(dekKey('docs', 1))

    await docs.putAtTier('d1', { id: 'd1', title: 'A', body: 'x' }, 0)
    await docs.blob('d1').put('slot', new TextEncoder().encode('v1 content'))
    await docs.blob('d1').publish('slot', 'v1')
    // Overwrite the slot — v1's eTag is no longer reachable via the slot map,
    // only via the version record's independent refCount hold.
    await docs.blob('d1').put('slot', new TextEncoder().encode('v2 content, supersedes v1 in the slot'))

    await docs.elevate('d1', 1)

    const versionEnv = await store.get('v1', '_blob_versions_docs', 'd1::slot::v1')
    expect(versionEnv).not.toBeNull()
    const record = JSON.parse(await openEnvelopeJson(versionEnv!, collDEK1)) as { eTag: string }

    const blobEnv = await store.get('v1', BLOB_INDEX_COLLECTION, record.eTag)
    expect(blobEnv).not.toBeNull()
    const blob = JSON.parse(await openEnvelopeJson(blobEnv!, tier0BlobDEK)) as { _cek?: string }
    await expect(unwrapCek(blob._cek!, tier0BlobDEK)).rejects.toThrow()
    await expect(unwrapCek(blob._cek!, tier1BlobDEK)).resolves.toBeDefined()

    // The version content is still the ORIGINAL v1 bytes, not v2's.
    await docs.demote('d1', 0)
    const versionBytes = await docs.blob('d1').getVersion('slot', 'v1')
    expect(versionBytes).not.toBeNull()
    expect(new TextDecoder().decode(versionBytes!)).toBe('v1 content')
  })

  it('demote restores tier-0 readability for both the version content and the version record', async () => {
    const store = memoryStore()
    const db = await createNoydb({
      store, secret: 'pw', user: 'owner',
      tiersStrategy: withTiers(), blobStrategy: withBlobs(),
    })
    const vault = await db.openVault('v1')
    const docs = vault.collection<Doc>('docs', {
      tiers: [0, 1], perRecordKeys: true, blobFields: { slot: {} },
    })
    const getDEK = (vault as unknown as { getDEK(name: string): Promise<EnclaveKey> }).getDEK
    const tier0BlobDEK = await getDEK(dekKey('_blob', 0))
    const collDEK0 = await getDEK('docs')

    await docs.putAtTier('d1', { id: 'd1', title: 'A', body: 'x' }, 0)
    await docs.blob('d1').put('slot', new TextEncoder().encode('reversible version bytes'))
    await docs.blob('d1').publish('slot', 'v1')

    await docs.elevate('d1', 1)
    expect(await docs.blob('d1').getVersion('slot', 'v1')).toBeNull() // gated while elevated

    await docs.demote('d1', 0)

    // The version record is readable under the tier-0 collection DEK again.
    const versionEnv = await store.get('v1', '_blob_versions_docs', 'd1::slot::v1')
    expect(versionEnv).not.toBeNull()
    const record = JSON.parse(await openEnvelopeJson(versionEnv!, collDEK0)) as { eTag: string }

    // Its content unwraps under the tier-0 `_blob` DEK again.
    const blobEnv = await store.get('v1', BLOB_INDEX_COLLECTION, record.eTag)
    expect(blobEnv).not.toBeNull()
    const blob = JSON.parse(await openEnvelopeJson(blobEnv!, tier0BlobDEK)) as { _cek?: string }
    await expect(unwrapCek(blob._cek!, tier0BlobDEK)).resolves.toBeDefined()

    // And the public API round-trips the original bytes.
    const versionBytes = await docs.blob('d1').getVersion('slot', 'v1')
    expect(versionBytes).not.toBeNull()
    expect(new TextDecoder().decode(versionBytes!)).toBe('reversible version bytes')
  })
})

describe('#724 forget of elevated blob-owner (C3)', () => {
  it('vault.forget() of an elevated blob-owning record does not throw and crypto-shreds the blob', async () => {
    const store = memoryStore()
    const db = await createNoydb({
      store, secret: 'pw', user: 'owner',
      tiersStrategy: withTiers(), blobStrategy: withBlobs(),
      historyStrategy: withHistory(),
      forgetStrategy: withForgetCascade({ subjects: { docs: 'id' } }),
    })
    const vault = await db.openVault('v1')
    const docs = vault.collection<Doc>('docs', {
      tiers: [0, 1], perRecordKeys: true, blobFields: { attachment: {} },
    })
    await docs.put('d1', { id: 'd1', title: 'Invoice', body: 'x' })
    await docs.blob('d1').put('attachment', new TextEncoder().encode('elevated owner data'))
    const eTag = (await docs.blob('d1').blobInfo('attachment'))!.eTag
    await docs.elevate('d1', 1)

    const result = await vault.forget('d1')

    expect(result.blobsShredded).toBe(1)
    expect(result.blobResidueCollections).toEqual([])
    // Crypto-shredded: BlobObject + chunks gone.
    expect(await store.get('v1', BLOB_INDEX_COLLECTION, eTag)).toBeNull()
    expect(await store.list('v1', BLOB_CHUNKS_COLLECTION)).toEqual([])
    // Record tombstoned (not left half-erased).
    const env = await store.get('v1', 'docs', 'd1')
    expect(env).not.toBeNull()
    expect(env!._data).toBe('')
  })

  it('a tier-0 control record forget still works (unchanged)', async () => {
    const store = memoryStore()
    const db = await createNoydb({
      store, secret: 'pw', user: 'owner',
      tiersStrategy: withTiers(), blobStrategy: withBlobs(),
      historyStrategy: withHistory(),
      forgetStrategy: withForgetCascade({ subjects: { docs: 'id' } }),
    })
    const vault = await db.openVault('v1')
    const docs = vault.collection<Doc>('docs', {
      tiers: [0, 1], perRecordKeys: true, blobFields: { attachment: {} },
    })
    await docs.put('d2', { id: 'd2', title: 'Memo', body: 'y' })
    await docs.blob('d2').put('attachment', new TextEncoder().encode('tier-0 owner data'))
    const eTag = (await docs.blob('d2').blobInfo('attachment'))!.eTag

    const result = await vault.forget('d2')

    expect(result.blobsShredded).toBe(1)
    expect(await store.get('v1', BLOB_INDEX_COLLECTION, eTag)).toBeNull()
    expect(await store.list('v1', BLOB_CHUNKS_COLLECTION)).toEqual([])
  })
})

describe('#724 composition enforcement (I1)', () => {
  it('a tiered collection declaring blobFields WITHOUT perRecordKeys throws at construction — legacy blobs cannot be tier-isolated', async () => {
    const db = await createNoydb({
      store: memoryStore(), secret: 'pw', user: 'owner',
      tiersStrategy: withTiers(), blobStrategy: withBlobs(),
    })
    const vault = await db.openVault('v1')
    expect(() => vault.collection<Doc>('docs', {
      tiers: [0, 1], blobFields: { attachment: {} },
    })).toThrow(UnsupportedTierCompositionError)
    expect(() => vault.collection<Doc>('docs2', {
      tiers: [0, 1], blobFields: { attachment: {} },
    })).toThrow(/perRecordKeys/)
  })

  it('a tiered collection with NO declared blobFields still constructs fine (do not over-refuse)', async () => {
    const db = await createNoydb({ store: memoryStore(), secret: 'pw', user: 'owner', tiersStrategy: withTiers() })
    const vault = await db.openVault('v1')
    expect(() => vault.collection<Doc>('docs', { tiers: [0, 1] })).not.toThrow()
  })

  it('a tiered collection with blobFields AND perRecordKeys constructs fine', async () => {
    const db = await createNoydb({
      store: memoryStore(), secret: 'pw', user: 'owner',
      tiersStrategy: withTiers(), blobStrategy: withBlobs(),
    })
    const vault = await db.openVault('v1')
    expect(() => vault.collection<Doc>('docs', {
      tiers: [0, 1], perRecordKeys: true, blobFields: { attachment: {} },
    })).not.toThrow()
  })

  it('a blob written without a declared blobFields still rehomes to the tier DEK on elevate (hasBlobFields gate dropped)', async () => {
    const store = memoryStore()
    const db = await createNoydb({
      store, secret: 'pw', user: 'owner',
      tiersStrategy: withTiers(), blobStrategy: withBlobs(),
    })
    const vault = await db.openVault('v1')
    // No `blobFields` declared — the original #724 repro shape (blobs written
    // via blob(id).put() without declaring the field).
    const docs = vault.collection<Doc>('docs', { tiers: [0, 1], perRecordKeys: true })
    const getDEK = (vault as unknown as { getDEK(name: string): Promise<EnclaveKey> }).getDEK
    const tier0BlobDEK = await getDEK(dekKey('_blob', 0))
    const tier1BlobDEK = await getDEK(dekKey('_blob', 1))
    const collDEK1 = await getDEK(dekKey('docs', 1))

    await docs.putAtTier('d1', { id: 'd1', title: 'Invoice', body: 'x' }, 0)
    await docs.blob('d1').put('slot', new TextEncoder().encode('undeclared-field attachment bytes'))

    await docs.elevate('d1', 1)

    const slotsEnv = await store.get('v1', '_blob_slots_docs', 'd1')
    const slots = JSON.parse(await openEnvelopeJson(slotsEnv!, collDEK1)) as Record<string, { eTag: string }>
    const newETag = slots.slot!.eTag

    const env = await store.get('v1', BLOB_INDEX_COLLECTION, newETag)
    expect(env).not.toBeNull()
    const blob = JSON.parse(await openEnvelopeJson(env!, tier0BlobDEK)) as { _cek?: string }
    expect(blob._cek).toBeDefined()

    // AT-REST GUARANTEE: not unwrappable under tier-0 anymore, only tier-1.
    await expect(unwrapCek(blob._cek!, tier0BlobDEK)).rejects.toThrow()
    await expect(unwrapCek(blob._cek!, tier1BlobDEK)).resolves.toBeDefined()
  })

  it('a tiered collection with NO blobFields and NO perRecordKeys constructs fine, but writing a legacy blob to it is refused at write time (undeclared-blobFields I1 leak)', async () => {
    const db = await createNoydb({
      store: memoryStore(), secret: 'pw', user: 'owner',
      tiersStrategy: withTiers(), blobStrategy: withBlobs(),
    })
    const vault = await db.openVault('v1')
    // Construction mandate only fires on DECLARED blobFields — this
    // undeclared-field, non-perRecordKeys, tiered shape constructs fine.
    expect(() => vault.collection<Doc>('docs', { tiers: [0, 1] })).not.toThrow()
    const docs = vault.collection<Doc>('docs', { tiers: [0, 1] })

    await docs.putAtTier('d1', { id: 'd1', title: 'Invoice', body: 'x' }, 0)
    // A legacy blob write on a tiered collection can never be tier-isolated
    // on elevate (rehomeForTier no-ops on it — no `_cek` to rewrap) — the
    // write itself must be refused.
    await expect(
      docs.blob('d1').put('attachment', new TextEncoder().encode('leaks at rest')),
    ).rejects.toThrow(UnsupportedTierCompositionError)
  })

  it('control: the SAME tiered collection WITH perRecordKeys accepts the blob write, and it is at-rest tier-isolated after elevate', async () => {
    const store = memoryStore()
    const db = await createNoydb({
      store, secret: 'pw', user: 'owner',
      tiersStrategy: withTiers(), blobStrategy: withBlobs(),
    })
    const vault = await db.openVault('v1')
    const docs = vault.collection<Doc>('docs', { tiers: [0, 1], perRecordKeys: true })
    const getDEK = (vault as unknown as { getDEK(name: string): Promise<EnclaveKey> }).getDEK
    const tier0BlobDEK = await getDEK(dekKey('_blob', 0))
    const tier1BlobDEK = await getDEK(dekKey('_blob', 1))
    const collDEK1 = await getDEK(dekKey('docs', 1))

    await docs.putAtTier('d1', { id: 'd1', title: 'Invoice', body: 'x' }, 0)
    await expect(
      docs.blob('d1').put('attachment', new TextEncoder().encode('tier-isolated bytes')),
    ).resolves.toBeUndefined()

    await docs.elevate('d1', 1)

    const slotsEnv = await store.get('v1', '_blob_slots_docs', 'd1')
    const slots = JSON.parse(await openEnvelopeJson(slotsEnv!, collDEK1)) as Record<string, { eTag: string }>
    const eTag = slots.attachment!.eTag
    const env = await store.get('v1', BLOB_INDEX_COLLECTION, eTag)
    const blob = JSON.parse(await openEnvelopeJson(env!, tier0BlobDEK)) as { _cek?: string }
    expect(blob._cek).toBeDefined()
    await expect(unwrapCek(blob._cek!, tier0BlobDEK)).rejects.toThrow()
    await expect(unwrapCek(blob._cek!, tier1BlobDEK)).resolves.toBeDefined()
  })

  it('control: a NON-tiered collection without perRecordKeys still accepts a legacy blob write (back-compat, not refused)', async () => {
    const db = await createNoydb({
      store: memoryStore(), secret: 'pw', user: 'owner',
      blobStrategy: withBlobs(),
    })
    const vault = await db.openVault('v1')
    const docs = vault.collection<Doc>('docs', {})

    await docs.put('d1', { id: 'd1', title: 'Invoice', body: 'x' })
    await expect(
      docs.blob('d1').put('attachment', new TextEncoder().encode('legacy, untiered, fine')),
    ).resolves.toBeUndefined()
  })
})
