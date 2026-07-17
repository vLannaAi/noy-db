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
    const collDEK = await getDEK('docs')

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
    // slot map at rest instead, same as the solo-blob tests above.
    const slotsEnv = await store.get('v1', '_blob_slots_docs', 'b')
    expect(slotsEnv).not.toBeNull()
    const slots = JSON.parse(await openEnvelopeJson(slotsEnv!, collDEK)) as Record<string, { eTag: string }>
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
    const collDEK = await getDEK('docs')

    const bytes = new TextEncoder().encode('identical shared bytes (dedup mode)')
    await docs.putAtTier('a', { id: 'a', title: 'A', body: 'x' }, 0)
    await docs.blob('a').put('attachment', bytes)
    await docs.putAtTier('b', { id: 'b', title: 'B', body: 'y' }, 0)
    await docs.blob('b').put('attachment', bytes)

    const sharedETag = (await docs.blob('a').blobInfo('attachment'))!.eTag
    expect((await docs.blob('a').blobInfo('attachment'))!.refCount).toBe(2)

    await docs.elevate('b', 1)

    // b's slot STILL points at the shared eTag — no fork in dedup mode.
    const slotsEnv = await store.get('v1', '_blob_slots_docs', 'b')
    const slots = JSON.parse(await openEnvelopeJson(slotsEnv!, collDEK)) as Record<string, { eTag: string }>
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
