/**
 * extractPartition carries the slice's blobs — HARDENED key handling (#519).
 *
 * The crux is the HARDENED isolation property: the partition mints a FRESH
 * transfer `_blob` DEK and re-wraps ONLY the carried slice's blob content CEKs
 * under it. The recipient therefore gets keys for ONLY their slice's blobs —
 * the transfer DEK can decrypt the carried cover but NOT a source-vault blob
 * outside the slice (this is what distinguishes hardened from v1, which sealed
 * the source's shared `_blob` DEK and would leak a key to every source blob).
 *
 * Mirrors setup from decrypt-partition.test.ts (extract/adopt) + per-blob-cek.test.ts (blobs).
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { withCargo } from '../src/index.js'
import { ref } from '../src/kernel/refs.js'
import { ConflictError } from '../src/kernel/errors.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot, KeyringFile } from '../src/kernel/types.js'
import { decrypt, encrypt, unwrapCek, openEnvelopeJson } from '../src/kernel/enclave/index.js'
import { withBlobs } from '../src/via/blob/index.js'
import { BLOB_INDEX_COLLECTION, BLOB_CHUNKS_COLLECTION, BLOB_SLOTS_PREFIX } from '../src/with-shape/blobs/blob-set.js'
import { BLOB_INTENT_COLLECTION, createIntent, getIntent, type BlobIntent } from '../src/with-shape/blobs/blob-intent.js'
import { extractPartition } from '../src/with-cargo/extract-partition.js'
import {
  adoptPartition,
  createOwnerOnAdoptedPartition,
  unsealDeks,
} from '../src/with-cargo/adopt-partition.js'
import { readNoydbBundle, parseExtractedPartitionBody } from '../src/with-pod/bundle.js'

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
const bytes = (s: string) => new TextEncoder().encode(s)
const decode = (u: Uint8Array) => new TextDecoder().decode(u)

interface Doc { id: string; title: string }
interface Line { id: string; docId: string }

/** Recover the sealed DEK map (incl. the transfer `_blob` DEK) from a bundle. */
async function sealedDeks(bundleBytes: Uint8Array, transferKey: Uint8Array) {
  const { seal } = parseExtractedPartitionBody((await readNoydbBundle(bundleBytes)).dumpJson)
  return unsealDeks(seal, transferKey)
}

describe('extractPartition blob carriage — round-trip', () => {
  for (const erasable of [true, false] as const) {
    it(`cover survives extract → adopt → own, byte-identical (${erasable ? 'erasable' : 'legacy'})`, async () => {
      const src = memory()
      const db = await createNoydb({ cargoStrategy: withCargo(), store: src, user: 'alice', secret: SECRET, blobStrategy: withBlobs() })
      const company = await db.openVault('demo-co')
      const docs = company.collection<Doc>('docs', erasable ? { perRecordKeys: true } : {})
      await docs.put('d1', { id: 'd1', title: 'Report' })
      const cover = bytes('PNG cover bytes — the original blob content')
      await docs.blob('d1').put('cover.png', cover)

      const { bundleBytes, transferKey } = await extractPartition(company, {
        seeds: { docs: (r) => r['id'] === 'd1' },
      })

      const dest = memory()
      await adoptPartition(bundleBytes, { transferKey, destinationStore: dest, vaultName: 'fresh' })
      await createOwnerOnAdoptedPartition(dest, 'fresh', {
        userId: 'belle', passphrase: 'belle-pass-phrase-2026', transferKey,
      })

      const recipientDb = await createNoydb({ cargoStrategy: withCargo(), store: dest, user: 'belle', secret: 'belle-pass-phrase-2026', blobStrategy: withBlobs() })
      const vault = await recipientDb.openVault('fresh')
      const got = await vault.collection<Doc>('docs', erasable ? { perRecordKeys: true } : {}).blob('d1').get('cover.png')
      expect(got).not.toBeNull()
      expect(decode(got!)).toBe('PNG cover bytes — the original blob content')
      recipientDb.close()
      db.close()
    })
  }
})

describe('extractPartition blob carriage — HARDENED isolation property', () => {
  it('the sealed transfer `_blob` DEK decrypts ONLY the carried slice, NOT a source blob outside the slice', async () => {
    const src = memory()
    const db = await createNoydb({ cargoStrategy: withCargo(), store: src, user: 'alice', secret: SECRET, blobStrategy: withBlobs() })
    const company = await db.openVault('demo-co')
    const docs = company.collection<Doc>('docs', { perRecordKeys: true })
    await docs.put('d1', { id: 'd1', title: 'In slice' })
    await docs.put('d2', { id: 'd2', title: 'Out of slice' })
    await docs.blob('d1').put('cover.png', bytes('carried cover'))
    await docs.blob('d2').put('lonely.png', bytes('source-only blob outside the slice'))

    const coverETag = (await docs.blob('d1').blobInfo('cover.png'))!.eTag
    const lonelyETag = (await docs.blob('d2').blobInfo('lonely.png'))!.eTag
    expect(coverETag).not.toBe(lonelyETag)

    const { bundleBytes, transferKey } = await extractPartition(company, {
      seeds: { docs: (r) => r['id'] === 'd1' },
    })

    const deks = await sealedDeks(bundleBytes, transferKey)
    const transferBlobDek = deks.get('_blob')
    expect(transferBlobDek).toBeDefined()

    const dest = memory()
    await adoptPartition(bundleBytes, { transferKey, destinationStore: dest, vaultName: 'fresh' })

    // The SOURCE vault's blob DEK — proves the out-of-slice ciphertext below is
    // valid (decryptable by its real key), so the negative assertions are real.
    const srcBlobDek = await company._introspectState().getDEK('_blob')
    expect(srcBlobDek).not.toBe(transferBlobDek) // FRESH transfer DEK, not the source's

    // Positive: the transfer DEK decrypts the CARRIED cover's index entry
    // (re-keyed under the transfer DEK into the bundle / destination)...
    const coverIdx = await dest.get('fresh', BLOB_INDEX_COLLECTION, coverETag)
    expect(coverIdx).not.toBeNull()
    const coverBlob = JSON.parse(await decrypt(coverIdx!._iv, coverIdx!._data, transferBlobDek!)) as { _cek?: string }
    expect(coverBlob._cek).toBeDefined()
    // ...and unwraps its content CEK (chunks become decryptable for the recipient).
    await expect(unwrapCek(coverBlob._cek!, transferBlobDek!)).resolves.toBeDefined()

    // The out-of-slice blob never travelled into the bundle at all.
    expect(await dest.get('fresh', BLOB_INDEX_COLLECTION, lonelyETag)).toBeNull()

    // HARDENED master-key-leak proof: even handed the SOURCE vault's out-of-slice
    // ciphertext directly, the transfer DEK yields NOTHING. (Under v1 — which
    // sealed the source's shared `_blob` DEK — this DEK would decrypt it.)
    const lonelyIdx = await src.get('demo-co', BLOB_INDEX_COLLECTION, lonelyETag)
    expect(lonelyIdx).not.toBeNull()
    // Sanity — the source DEK CAN read it (so the ciphertext is real)...
    const lonelyBlob = JSON.parse(await decrypt(lonelyIdx!._iv, lonelyIdx!._data, srcBlobDek)) as { _cek?: string }
    expect(lonelyBlob._cek).toBeDefined()
    // ...but the transfer DEK throws on the index envelope...
    await expect(decrypt(lonelyIdx!._iv, lonelyIdx!._data, transferBlobDek!)).rejects.toThrow()
    // ...and cannot unwrap the source blob's content CEK (the key isolation property).
    await expect(unwrapCek(lonelyBlob._cek!, transferBlobDek!)).rejects.toThrow()

    db.close()
  })
})

describe('extractPartition blob carriage — selective carriage', () => {
  it('fieldProjection drops a projected-out blob field (its blob does not travel)', async () => {
    const src = memory()
    const db = await createNoydb({ cargoStrategy: withCargo(), store: src, user: 'alice', secret: SECRET, blobStrategy: withBlobs() })
    const company = await db.openVault('demo-co')
    const docs = company.collection<Doc>('docs', { perRecordKeys: true })
    await docs.put('d1', { id: 'd1', title: 'Report' })
    await docs.blob('d1').put('cover', bytes('kept cover bytes'))
    await docs.blob('d1').put('secret', bytes('dropped secret bytes'))
    const secretETag = (await docs.blob('d1').blobInfo('secret'))!.eTag

    const { bundleBytes, transferKey } = await extractPartition(company, {
      seeds: { docs: (r) => r['id'] === 'd1' },
      fieldProjection: { docs: ['title', 'cover'] },
    })

    const dest = memory()
    await adoptPartition(bundleBytes, { transferKey, destinationStore: dest, vaultName: 'fresh' })
    await createOwnerOnAdoptedPartition(dest, 'fresh', {
      userId: 'belle', passphrase: 'belle-pass-phrase-2026', transferKey,
    })

    const recipientDb = await createNoydb({ cargoStrategy: withCargo(), store: dest, user: 'belle', secret: 'belle-pass-phrase-2026', blobStrategy: withBlobs() })
    const vault = await recipientDb.openVault('fresh')
    const slot = vault.collection<Doc>('docs', { perRecordKeys: true }).blob('d1')
    expect(decode((await slot.get('cover'))!)).toBe('kept cover bytes')
    expect(await slot.get('secret')).toBeNull()
    // The projected-out blob's index entry never travelled.
    expect(await dest.get('fresh', BLOB_INDEX_COLLECTION, secretETag)).toBeNull()
    recipientDb.close()
    db.close()
  })

  it('a blob referenced only by an out-of-closure record does not travel', async () => {
    const src = memory()
    const db = await createNoydb({ cargoStrategy: withCargo(), store: src, user: 'alice', secret: SECRET, blobStrategy: withBlobs() })
    const company = await db.openVault('demo-co')
    const docs = company.collection<Doc>('docs', { perRecordKeys: true })
    await docs.put('d1', { id: 'd1', title: 'In' })
    await docs.put('d2', { id: 'd2', title: 'Out' })
    await docs.blob('d1').put('cover.png', bytes('in-slice cover'))
    await docs.blob('d2').put('lonely.png', bytes('out-of-slice blob'))
    const lonelyETag = (await docs.blob('d2').blobInfo('lonely.png'))!.eTag

    const { bundleBytes, transferKey } = await extractPartition(company, {
      seeds: { docs: (r) => r['id'] === 'd1' },
    })

    const dest = memory()
    await adoptPartition(bundleBytes, { transferKey, destinationStore: dest, vaultName: 'fresh' })
    await createOwnerOnAdoptedPartition(dest, 'fresh', {
      userId: 'belle', passphrase: 'belle-pass-phrase-2026', transferKey,
    })

    const recipientDb = await createNoydb({ cargoStrategy: withCargo(), store: dest, user: 'belle', secret: 'belle-pass-phrase-2026', blobStrategy: withBlobs() })
    const vault = await recipientDb.openVault('fresh')
    const docsR = vault.collection<Doc>('docs', { perRecordKeys: true })
    expect(decode((await docsR.blob('d1').get('cover.png'))!)).toBe('in-slice cover')
    // d2 was never in the closure: no record, no slot, no blob.
    expect(await docsR.get('d2')).toBeNull()
    expect(await dest.get('fresh', BLOB_INDEX_COLLECTION, lonelyETag)).toBeNull()
    expect((await dest.list('fresh', BLOB_CHUNKS_COLLECTION)).some((k) => k.startsWith(lonelyETag))).toBe(false)
    recipientDb.close()
    db.close()
  })
})

describe('extractPartition blob carriage — refCount + no-blob', () => {
  it('the carried BlobObject refCount reflects carried references only', async () => {
    const src = memory()
    const db = await createNoydb({ cargoStrategy: withCargo(), store: src, user: 'alice', secret: SECRET, blobStrategy: withBlobs() })
    const company = await db.openVault('demo-co')
    const docs = company.collection<Doc>('docs', { perRecordKeys: true })
    // Two records share identical bytes → source refCount 2; only d1 is carried.
    await docs.put('d1', { id: 'd1', title: 'A' })
    await docs.put('d2', { id: 'd2', title: 'B' })
    const shared = bytes('shared bytes across two records')
    await docs.blob('d1').put('f.bin', shared)
    await docs.blob('d2').put('f.bin', shared)
    const eTag = (await docs.blob('d1').blobInfo('f.bin'))!.eTag
    expect((await docs.blob('d1').blobInfo('f.bin'))!.refCount).toBe(2)

    const { bundleBytes, transferKey } = await extractPartition(company, {
      seeds: { docs: (r) => r['id'] === 'd1' },
    })

    const deks = await sealedDeks(bundleBytes, transferKey)
    const dest = memory()
    await adoptPartition(bundleBytes, { transferKey, destinationStore: dest, vaultName: 'fresh' })
    const carriedIdx = await dest.get('fresh', BLOB_INDEX_COLLECTION, eTag)
    const carried = JSON.parse(await decrypt(carriedIdx!._iv, carriedIdx!._data, deks.get('_blob')!)) as { refCount: number }
    expect(carried.refCount).toBe(1) // recomputed from the single carried reference
    db.close()
  })

  it('a no-blob partition extracts/adopts cleanly and mints no `_blob` DEK (source keyring untouched)', async () => {
    const src = memory()
    const db = await createNoydb({ cargoStrategy: withCargo(), store: src, user: 'alice', secret: SECRET, blobStrategy: withBlobs() })
    const company = await db.openVault('demo-co')
    const docs = company.collection<Doc>('docs')
    const lines = company.collection<Line>('lines', { refs: { docId: ref('docs') } })
    await docs.put('d1', { id: 'd1', title: 'No blobs here' })
    await lines.put('l1', { id: 'l1', docId: 'd1' })

    const keyringBefore = await src.get('demo-co', '_keyring', 'alice')
    const deksBefore = Object.keys((JSON.parse(keyringBefore!._data) as KeyringFile).deks)

    const { bundleBytes, transferKey } = await extractPartition(company, {
      seeds: { docs: () => true },
    })

    // No `_blob` DEK in the seal.
    const deks = await sealedDeks(bundleBytes, transferKey)
    expect(deks.has('_blob')).toBe(false)

    // Source keyring did NOT gain a phantom `_blob` DEK.
    const keyringAfter = await src.get('demo-co', '_keyring', 'alice')
    const deksAfter = Object.keys((JSON.parse(keyringAfter!._data) as KeyringFile).deks)
    expect(deksAfter).not.toContain('_blob')
    expect(deksAfter.sort()).toEqual(deksBefore.sort())

    // Round-trips: records adopt + own, and blob.get is simply null.
    const dest = memory()
    await adoptPartition(bundleBytes, { transferKey, destinationStore: dest, vaultName: 'fresh' })
    await createOwnerOnAdoptedPartition(dest, 'fresh', {
      userId: 'belle', passphrase: 'belle-pass-phrase-2026', transferKey,
    })
    const recipientDb = await createNoydb({ cargoStrategy: withCargo(), store: dest, user: 'belle', secret: 'belle-pass-phrase-2026', blobStrategy: withBlobs() })
    const vault = await recipientDb.openVault('fresh')
    expect(await vault.collection<Doc>('docs').get('d1')).toMatchObject({ id: 'd1', title: 'No blobs here' })
    expect(await vault.collection<Doc>('docs').blob('d1').get('cover.png')).toBeNull()
    recipientDb.close()
    db.close()
  })
})

/**
 * #767 — extract-partition must carry an in-flight `_blob_intent` marker for
 * a carried record. A partition extracted mid-shred/mid-rehome without the
 * marker would restore the blob rows without it, reproducing the ambiguous-
 * refCount state the journal exists to prevent. Mirrors `dumpVault`'s
 * backup allowlist, which already carries `_blob_intent` for the same
 * reason (`with-pod/backup.ts`).
 */
describe('extractPartition blob carriage — #767: carries in-flight `_blob_intent` markers', () => {
  it('an in-flight `_blob_intent` marker for a carried record travels, re-keyed under the destination DEK', async () => {
    const src = memory()
    const db = await createNoydb({ cargoStrategy: withCargo(), store: src, user: 'alice', secret: SECRET, blobStrategy: withBlobs() })
    const company = await db.openVault('demo-co')
    const docs = company.collection<Doc>('docs', { perRecordKeys: true })
    await docs.put('d1', { id: 'd1', title: 'Report' })
    await docs.blob('d1').put('cover.png', bytes('cover bytes'))

    // Simulate a crashed mid-flight shred: plant a `_blob_intent` marker for
    // d1 directly (mirrors blob-shred-journal.test.ts's use of `createIntent`
    // for the same crash-recovery journal).
    const { getDEK } = company._introspectState()
    const intent: BlobIntent = { op: 'shred', opId: 'op-1', holds: [{ eTag: 'e1', n: 1, chunkCount: 1 }] }
    await createIntent(src, 'demo-co', 'docs', 'd1', getDEK, intent)

    const { bundleBytes, transferKey } = await extractPartition(company, {
      seeds: { docs: (r) => r['id'] === 'd1' },
    })

    const dest = memory()
    await adoptPartition(bundleBytes, { transferKey, destinationStore: dest, vaultName: 'fresh' })
    // The marker travelled at its stable `{collection}::{recordId}` key.
    expect(await dest.get('fresh', BLOB_INTENT_COLLECTION, 'docs::d1')).not.toBeNull()

    await createOwnerOnAdoptedPartition(dest, 'fresh', {
      userId: 'belle', passphrase: 'belle-pass-phrase-2026', transferKey,
    })
    const recipientDb = await createNoydb({ cargoStrategy: withCargo(), store: dest, user: 'belle', secret: 'belle-pass-phrase-2026', blobStrategy: withBlobs() })
    const recipientVault = await recipientDb.openVault('fresh')
    const rState = recipientVault._introspectState()
    // Round-trip: readable through the public marker reader under the
    // recipient's own (re-keyed) DEK — resume-on-touch would heal it.
    const recovered = await getIntent(rState.adapter, rState.name, 'docs', 'd1', rState.getDEK)
    expect(recovered).toEqual(intent)

    recipientDb.close()
    db.close()
  })

  it('no in-flight marker → nothing carried (the normal case)', async () => {
    const src = memory()
    const db = await createNoydb({ cargoStrategy: withCargo(), store: src, user: 'alice', secret: SECRET, blobStrategy: withBlobs() })
    const company = await db.openVault('demo-co')
    const docs = company.collection<Doc>('docs', { perRecordKeys: true })
    await docs.put('d1', { id: 'd1', title: 'Report' })
    await docs.blob('d1').put('cover.png', bytes('cover bytes'))

    const { bundleBytes, transferKey } = await extractPartition(company, {
      seeds: { docs: (r) => r['id'] === 'd1' },
    })

    const dest = memory()
    await adoptPartition(bundleBytes, { transferKey, destinationStore: dest, vaultName: 'fresh' })
    expect(await dest.get('fresh', BLOB_INTENT_COLLECTION, 'docs::d1')).toBeNull()
    db.close()
  })
})

/**
 * #769 — `reKeyBlobs` must strip the internal `SlotRecord.pendingRelease`
 * breadcrumb (#746's slot-CAS→release strand marker) when re-serializing a
 * slot map into a partition: it names a source-vault-LOCAL eTag awaiting
 * release that may be absent from the destination vault. Contrast with a
 * full-vault `backup()`, which restores into the SAME vault and therefore
 * CARRIES the breadcrumb unchanged (resumable there) — the asymmetry is
 * documented in `with-pod/backup.ts`.
 */
describe('extractPartition blob carriage — #769: strips `pendingRelease` (backup retains it)', () => {
  it('extract-partition strips SlotRecord.pendingRelease; a full-vault backup of the same vault retains it', async () => {
    const src = memory()
    const db = await createNoydb({ cargoStrategy: withCargo(), store: src, user: 'alice', secret: SECRET, blobStrategy: withBlobs() })
    const company = await db.openVault('demo-co')
    const docs = company.collection<Doc>('docs', { perRecordKeys: true })
    await docs.put('d1', { id: 'd1', title: 'Report' })
    await docs.blob('d1').put('cover.png', bytes('cover bytes'))

    // Plant a `pendingRelease` breadcrumb directly on the raw slot record —
    // mirrors a crash between a rehome's slot-CAS and its old-eTag release
    // landing (#746).
    const { adapter, name: vaultName, getDEK } = company._introspectState()
    const slotsCollection = `${BLOB_SLOTS_PREFIX}docs`
    const slotEnv = (await adapter.get(vaultName, slotsCollection, 'd1'))!
    const dek = await getDEK('docs')
    const slots = JSON.parse(await openEnvelopeJson(slotEnv, dek)) as Record<string, { eTag: string; pendingRelease?: string }>
    slots['cover.png']!.pendingRelease = 'stale-etag-awaiting-release'
    const reEncrypted = await encrypt(JSON.stringify(slots), dek)
    await adapter.put(vaultName, slotsCollection, 'd1', { ...slotEnv, _iv: reEncrypted.iv, _data: reEncrypted.data }, slotEnv._v)

    // ── extract-partition: STRIPS it (cross-vault; breadcrumb is meaningless there) ──
    const { bundleBytes, transferKey } = await extractPartition(company, {
      seeds: { docs: (r) => r['id'] === 'd1' },
    })
    const dest = memory()
    await adoptPartition(bundleBytes, { transferKey, destinationStore: dest, vaultName: 'fresh' })
    await createOwnerOnAdoptedPartition(dest, 'fresh', {
      userId: 'belle', passphrase: 'belle-pass-phrase-2026', transferKey,
    })
    const recipientDb = await createNoydb({ cargoStrategy: withCargo(), store: dest, user: 'belle', secret: 'belle-pass-phrase-2026', blobStrategy: withBlobs() })
    const recipientVault = await recipientDb.openVault('fresh')
    const rState = recipientVault._introspectState()
    const carriedSlotEnv = (await rState.adapter.get('fresh', slotsCollection, 'd1'))!
    const carriedSlots = JSON.parse(
      await openEnvelopeJson(carriedSlotEnv, await rState.getDEK('docs')),
    ) as Record<string, { eTag: string; pendingRelease?: string }>
    expect(carriedSlots['cover.png']!.pendingRelease).toBeUndefined()
    // The eTag itself still travels — only the breadcrumb is stripped.
    expect(carriedSlots['cover.png']!.eTag).toBe(slots['cover.png']!.eTag)
    recipientDb.close()

    // ── backup: CARRIES it unchanged (same-vault-resumable) ──────────────
    const backupJson = await company.dump()
    const backup = JSON.parse(backupJson) as { _internal?: Record<string, Record<string, EncryptedEnvelope>> }
    const backedUpSlotEnv = backup._internal?.[slotsCollection]?.['d1']
    expect(backedUpSlotEnv).toBeDefined()
    const backedUpSlots = JSON.parse(
      await openEnvelopeJson(backedUpSlotEnv!, dek),
    ) as Record<string, { eTag: string; pendingRelease?: string }>
    expect(backedUpSlots['cover.png']!.pendingRelease).toBe('stale-etag-awaiting-release')

    db.close()
  })
})
