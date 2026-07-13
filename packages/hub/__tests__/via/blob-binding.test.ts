/**
 * #629 Task 7 — the blob `ViaBinding`, unit-tested directly. Mirrors
 * `via/classified-binding.test.ts` — construct a config by hand, exercise
 * each hook. The binding is deliberately THIN: blob writes are fully
 * out-of-band (`collection.blob(id)` → `BlobSet` side-collections; they
 * never touch `_putInternal` or the codec), so the binding declares NO
 * write/read pipeline hooks — in particular no `encodeAtRest`/
 * `decodeAtRest`: a blobFields collection must not flip `hasAtRestHooks`.
 */
import { describe, it, expect, vi } from 'vitest'
import { blobBinding, linkBlobVia, type BlobViaConfig } from '../../src/via/blob/binding.js'
import type { BlobFieldsConfig } from '../../src/with-shape/blobs/blob-compaction.js'
import { ViaPipeline } from '../../src/kernel/via-pipeline.js'
import { isViaInstalled, viaBinder, type ViaCryptoCtx, type ViaEraseCtx, type ViaEraseReport } from '../../src/kernel/via.js'

const unusedCrypto: ViaCryptoCtx = {
  sealedSlots: {
    seal: async () => { throw new Error('blob binding must never touch sealedSlots') },
    unseal: async () => { throw new Error('blob binding must never touch sealedSlots') },
    delete: async () => { throw new Error('blob binding must never touch sealedSlots') },
  },
  reservedEnvelopes: () => ({
    encrypt: async () => { throw new Error('blob binding must never touch reservedEnvelopes') },
    decrypt: async () => { throw new Error('blob binding must never touch reservedEnvelopes') },
  }),
}

const eraseCtxFixture = (): ViaEraseCtx => ({
  id: 'r1',
  vault: 'test-vault',
  live: undefined,
  crypto: unusedCrypto,
})

function cfg(over: Partial<BlobViaConfig> = {}): BlobViaConfig {
  const fields: BlobFieldsConfig = {
    receipt: { retainDays: 30, evictWhen: () => false, external: true, backlink: 'opaque-token' },
    scan: { legalHold: () => true, retainUntil: () => null, public: true },
    photo: {},
  }
  return { fields, collectionName: 'invoices', ...over }
}

describe('blobBinding (#629 Task 7)', () => {
  it('declares the blob brand + posture (envelope at rest, not queryable, exportable, forgettable)', () => {
    const b = blobBinding(cfg())
    expect(b.brand).toBe('blob')
    expect(b.posture).toEqual({
      encryptedAtRest: 'envelope',
      queryable: 'none',
      exportable: true,
      forgettable: true,
    })
  })

  it('declares NO pipeline write/read/query hooks — blob content is out-of-band', () => {
    const b = blobBinding(cfg())
    // Lesson 2 (#629): no at-rest hooks — blob bytes never flow the codec.
    expect(b.encodeAtRest).toBeUndefined()
    expect(b.decodeAtRest).toBeUndefined()
    // No write/read/query participation of any kind.
    expect(b.enforceWrite).toBeUndefined()
    expect(b.ingest).toBeUndefined()
    expect(b.canonicalizeStored).toBeUndefined()
    expect(b.encodeWrite).toBeUndefined()
    expect(b.present).toBeUndefined()
    expect(b.buildClause).toBeUndefined()
    expect(b.evaluateClause).toBeUndefined()
    expect(b.decodeResults).toBeUndefined()
    expect(b.compareForOrder).toBeUndefined()
    expect(b.wrapReducers).toBeUndefined()
  })

  it('a blob-only pipeline keeps hasAtRestHooks false (the codec stays on its inline path)', () => {
    const pipeline = ViaPipeline.build([blobBinding(cfg())])
    expect(pipeline).toBeDefined()
    expect(pipeline!.hasAtRestHooks).toBe(false)
    expect(pipeline!.hasResultDecode).toBe(false)
  })

  it('describeFragment reports declarative knobs as scalars and predicate knobs as presence flags', () => {
    const b = blobBinding(cfg())
    expect(b.describeFragment!()).toEqual({
      blobFields: {
        receipt: { retainDays: 30, evictWhen: true, external: true, backlink: 'opaque-token' },
        scan: { legalHold: true, retainUntil: true, public: true },
        photo: {},
      },
    })
  })

  it('erase reports a zero-shredded, zero-residue no-op when no purge closure is wired (Task 10 wires it)', async () => {
    const b = blobBinding(cfg())
    await expect(b.erase!(eraseCtxFixture())).resolves.toEqual({ shredded: 0, residue: [] })
  })

  it('erase delegates to the wired purgeBlobsForRecord closure with the record id and returns its report', async () => {
    const report: ViaEraseReport = {
      shredded: 2,
      residue: [{ kind: 'blob-legacy-residue', eTag: 'etag-1' }],
    }
    const purgeBlobsForRecord = vi.fn(async (_id: string) => report)
    const b = blobBinding(cfg({ purgeBlobsForRecord }))

    await expect(b.erase!(eraseCtxFixture())).resolves.toEqual(report)
    expect(purgeBlobsForRecord).toHaveBeenCalledExactlyOnceWith('r1')
  })

  it('linkBlobVia installs the blob binder (idempotently)', () => {
    linkBlobVia()
    expect(isViaInstalled('blob')).toBe(true)
    const b = viaBinder('blob')(cfg())
    expect(b.brand).toBe('blob')
  })
})
