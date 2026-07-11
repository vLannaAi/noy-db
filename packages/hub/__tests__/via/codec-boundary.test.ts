/**
 * #629 Task 3 — the codec boundary: `RecordCodec.encryptRecord`/
 * `decryptRecord` invoke the via pipeline's `encodeAtRest`/`decodeAtRest`
 * hooks at exactly the point the inline `_sealed` sub-step runs today,
 * passing a `ViaCryptoCtx` built from the codec's own key material — when
 * the collection's pipeline declares no at-rest hooks (`hasAtRestHooks`
 * false, including `via` undefined), the codec stays on today's inline
 * path (classified `sensitiveFields`), byte/behavior-identical.
 *
 * A fixture at-rest binding (seals/unseals a `secret` field) proves the
 * wiring on both a plaintext (`storeCiphertext: false`) and an encrypted
 * (`storeCiphertext: true`) collection. classified itself still runs
 * inline in this task — its binding doesn't exist yet (#629 Task 5/6).
 */
import { describe, it, expect } from 'vitest'
import { RecordCodec, type RecordCodecContext } from '../../src/kernel/enclave/record-keys/record-codec.js'
import { ViaPipeline } from '../../src/kernel/via-pipeline.js'
import type { ViaBinding, ViaPosture } from '../../src/kernel/via.js'
import { generateDEK, type EnclaveKey } from '../../src/kernel/enclave/index.js'
import { SealedHandle } from '../../src/kernel/types.js'
import { NO_CRDT } from '../../src/with-commit/crdt/strategy.js'

const posture = (): ViaPosture => ({ encryptedAtRest: 'sealed', queryable: 'none', exportable: false, forgettable: true })

/** Fixture at-rest binding: seals/unseals a `secret` field via `crypto.sealedSlots`. */
function fixtureBinding(): ViaBinding {
  return {
    brand: 'fixture',
    posture: posture(),
    async encodeAtRest(record, crypto) {
      if (record.secret === undefined) return { record }
      const { secret, ...rest } = record
      const ref = await crypto.sealedSlots.seal('secret', secret)
      return { record: rest, sealed: { secret: ref } }
    },
    async decodeAtRest(record, sealed, crypto, opts) {
      const ref = sealed.secret
      if (ref === undefined) return record
      if (opts.asHandles) {
        return { ...record, secret: new SealedHandle(() => crypto.sealedSlots.unseal('secret', ref)) }
      }
      return { ...record, secret: await crypto.sealedSlots.unseal('secret', ref) }
    },
  }
}

function makeCtx(opts: { storeCiphertext: boolean; via?: ViaPipeline; dek: EnclaveKey; sensitiveFields?: ReadonlySet<string> }): RecordCodecContext<Record<string, unknown>> {
  return {
    name: 'fixtures',
    actor: 'tester',
    storeCiphertext: opts.storeCiphertext,
    debugPlaintext: false,
    provenance: false,
    sensitiveFields: opts.sensitiveFields ?? new Set(),
    deterministicFields: null,
    vdigFields: null,
    crdtMode: undefined,
    crdtStrategy: NO_CRDT,
    schema: undefined,
    getDEK: async () => opts.dek,
    cekCache: null,
    via: opts.via,
  }
}

describe('RecordCodec codec boundary — via at-rest hooks (#629 Task 3)', () => {
  it('encrypted collection: encodeAtRest lands the sealed map on `_sealed`, keeps other fields in `_data`', async () => {
    const dek = await generateDEK()
    const pipeline = ViaPipeline.build([fixtureBinding()])!
    const codec = new RecordCodec(makeCtx({ storeCiphertext: true, via: pipeline, dek }))

    const envelope = await codec.encryptRecord({ secret: 'shh', open: 'visible' }, 1, undefined, undefined, undefined, undefined, 'r1')

    expect(envelope._sealed).toBeDefined()
    expect(envelope._sealed!.secret).toMatch(/^.+:.+$/)
    const bodyJson = await codec.decryptJsonString(envelope, 'r1')
    expect(JSON.parse(bodyJson!)).toEqual({ open: 'visible' }) // `secret` peeled out before `_data` was built
  })

  it('decodeAtRest round-trips the sealed field back to plaintext, threading the per-record CEK', async () => {
    const dek = await generateDEK()
    const cek = await generateDEK()
    const pipeline = ViaPipeline.build([fixtureBinding()])!
    const codec = new RecordCodec(makeCtx({ storeCiphertext: true, via: pipeline, dek }))

    const envelope = await codec.encryptRecord({ secret: 'shh', open: 'visible' }, 1, cek, undefined, undefined, undefined, 'r1')
    expect(envelope._cek).toBeDefined() // per-record CEK path was taken

    const decoded = await codec.decryptRecord(envelope, { id: 'r1' })

    expect(decoded).toEqual({ secret: 'shh', open: 'visible' })
  })

  it('decodeAtRest honors asHandles: yields a lazy Sealed handle that reveals the same value', async () => {
    const dek = await generateDEK()
    const pipeline = ViaPipeline.build([fixtureBinding()])!
    const codec = new RecordCodec(makeCtx({ storeCiphertext: true, via: pipeline, dek }))

    const envelope = await codec.encryptRecord({ secret: 'shh', open: 'visible' }, 1, undefined, undefined, undefined, undefined, 'r1')
    const decoded = (await codec.decryptRecord(envelope, { id: 'r1', sealedAsHandles: true })) as Record<string, unknown>

    expect(decoded.secret).toBeInstanceOf(SealedHandle)
    expect(JSON.stringify(decoded.secret)).toBe('"[sealed]"') // never leaks the plaintext
    await expect((decoded.secret as SealedHandle<unknown>).reveal()).resolves.toBe('shh')
    expect(decoded.open).toBe('visible')
  })

  it('plaintext (debug) collection: at-rest hooks never fire — the record passes through unchanged', async () => {
    const dek = await generateDEK()
    const pipeline = ViaPipeline.build([fixtureBinding()])!
    const codec = new RecordCodec(makeCtx({ storeCiphertext: false, via: pipeline, dek }))

    const envelope = await codec.encryptRecord({ secret: 'shh', open: 'visible' }, 1)

    expect(envelope._sealed).toBeUndefined()
    expect(envelope._iv).toBe('')
    expect(JSON.parse(envelope._data)).toEqual({ secret: 'shh', open: 'visible' })
  })

  it('encryptRecord refuses (explicit recordId check) when hasAtRestHooks is true but no id is supplied', async () => {
    const dek = await generateDEK()
    const pipeline = ViaPipeline.build([fixtureBinding()])!
    const codec = new RecordCodec(makeCtx({ storeCiphertext: true, via: pipeline, dek }))

    await expect(codec.encryptRecord({ secret: 'shh' }, 1)).rejects.toThrow(/record id/i)
  })

  it('decryptRecord refuses (explicit recordId check) when hasAtRestHooks is true but opts.id is missing', async () => {
    const dek = await generateDEK()
    const pipeline = ViaPipeline.build([fixtureBinding()])!
    const codec = new RecordCodec(makeCtx({ storeCiphertext: true, via: pipeline, dek }))
    const envelope = await codec.encryptRecord({ secret: 'shh' }, 1, undefined, undefined, undefined, undefined, 'r1')

    await expect(codec.decryptRecord(envelope)).rejects.toThrow(/record id/i)
  })
})

describe('zero-via fast path stays on the inline path (#629 Task 3 parity)', () => {
  it('a via pipeline with no at-rest hooks (money-like) still seals via the classic sensitiveFields path', async () => {
    const dek = await generateDEK()
    const syncOnlyBinding: ViaBinding = { brand: 'sync-only', posture: posture(), ingest: (r) => r }
    const pipeline = ViaPipeline.build([syncOnlyBinding])!
    expect(pipeline.hasAtRestHooks).toBe(false)

    const codec = new RecordCodec(makeCtx({ storeCiphertext: true, via: pipeline, dek, sensitiveFields: new Set(['secret']) }))

    const envelope = await codec.encryptRecord({ secret: 'shh', open: 'visible' }, 1)

    expect(envelope._sealed).toBeDefined()
    expect(envelope._sealed!.secret).toMatch(/^.+:.+$/)
    const decoded = await codec.decryptRecord(envelope)
    expect(decoded).toEqual({ secret: 'shh', open: 'visible' })
  })

  it('`via: undefined` and a no-at-rest-hooks pipeline produce structurally identical envelopes', async () => {
    const dek = await generateDEK()
    const record = { secret: 'shh', open: 'visible' }
    const codecNoVia = new RecordCodec(makeCtx({ storeCiphertext: true, dek, sensitiveFields: new Set(['secret']) }))
    const syncOnlyBinding: ViaBinding = { brand: 'sync-only', posture: posture(), ingest: (r) => r }
    const codecSyncPipeline = new RecordCodec(
      makeCtx({ storeCiphertext: true, via: ViaPipeline.build([syncOnlyBinding])!, dek, sensitiveFields: new Set(['secret']) }),
    )

    const envNoVia = await codecNoVia.encryptRecord(record, 1)
    const envSyncPipeline = await codecSyncPipeline.encryptRecord(record, 1)

    expect(Object.keys(envNoVia).sort()).toEqual(Object.keys(envSyncPipeline).sort())
    expect(Object.keys(envNoVia._sealed ?? {})).toEqual(Object.keys(envSyncPipeline._sealed ?? {}))
    expect(await codecNoVia.decryptRecord(envNoVia)).toEqual(await codecSyncPipeline.decryptRecord(envSyncPipeline))
  })
})
