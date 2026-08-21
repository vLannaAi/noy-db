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
import { recordAadFor } from '../../src/kernel/enclave/record-aad.js'
import { ViaPipeline } from '../../src/kernel/via/pipeline.js'
import type { NoydbVia, ViaPosture } from '../../src/kernel/via/index.js'
import { generateDEK, decrypt, type EnclaveKey } from '../../src/kernel/enclave/index.js'
import { SealedHandle, type EncryptedEnvelope } from '../../src/kernel/types.js'
import { NO_CRDT } from '../../src/with-commit/crdt/strategy.js'
import { classifiedVia } from '../../src/via/classified/binding.js'
import { classified } from '../../src/via/classified/presets.js'

const posture = (): ViaPosture => ({ encryptedAtRest: 'sealed', queryable: 'none', exportable: false, forgettable: true })

/** Fixture at-rest binding: seals/unseals a `secret` field via `crypto.sealedSlots`. */
function fixtureBinding(): NoydbVia {
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

    const envelope = await codec.encryptRecord({ collection: 'c', id: 'r1' }, { secret: 'shh', open: 'visible' }, 1, undefined)

    expect(envelope._sealed).toBeDefined()
    expect(envelope._sealed!.secret).toMatch(/^.+:.+$/)
    const bodyJson = await codec.decryptJsonString({ collection: 'c', id: 'r1' }, envelope)
    expect(JSON.parse(bodyJson!)).toEqual({ open: 'visible' }) // `secret` peeled out before `_data` was built
  })

  it('decodeAtRest round-trips the sealed field back to plaintext, threading the per-record CEK', async () => {
    const dek = await generateDEK()
    const cek = await generateDEK()
    const pipeline = ViaPipeline.build([fixtureBinding()])!
    const codec = new RecordCodec(makeCtx({ storeCiphertext: true, via: pipeline, dek }))

    const envelope = await codec.encryptRecord({ collection: 'c', id: 'r1' }, { secret: 'shh', open: 'visible' }, 1, cek)
    expect(envelope._cek).toBeDefined() // per-record CEK path was taken

    const decoded = await codec.decryptRecord({ collection: 'c', id: 'r1' }, envelope)

    expect(decoded).toEqual({ secret: 'shh', open: 'visible' })
  })

  it('decodeAtRest honors asHandles: yields a lazy Sealed handle that reveals the same value', async () => {
    const dek = await generateDEK()
    const pipeline = ViaPipeline.build([fixtureBinding()])!
    const codec = new RecordCodec(makeCtx({ storeCiphertext: true, via: pipeline, dek }))

    const envelope = await codec.encryptRecord({ collection: 'c', id: 'r1' }, { secret: 'shh', open: 'visible' }, 1, undefined)
    const decoded = (await codec.decryptRecord({ collection: 'c', id: 'r1' }, envelope, { sealedAsHandles: true })) as Record<string, unknown>

    expect(decoded.secret).toBeInstanceOf(SealedHandle)
    expect(JSON.stringify(decoded.secret)).toBe('"[sealed]"') // never leaks the plaintext
    await expect((decoded.secret as SealedHandle<unknown>).reveal()).resolves.toBe('shh')
    expect(decoded.open).toBe('visible')
  })

  it('plaintext (debug) collection: at-rest hooks never fire — the record passes through unchanged', async () => {
    const dek = await generateDEK()
    const pipeline = ViaPipeline.build([fixtureBinding()])!
    const codec = new RecordCodec(makeCtx({ storeCiphertext: false, via: pipeline, dek }))

    const envelope = await codec.encryptRecord({ collection: 'c', id: 'r1' }, { secret: 'shh', open: 'visible' }, 1)

    expect(envelope._sealed).toBeUndefined()
    expect(envelope._iv).toBe('')
    expect(JSON.parse(envelope._data)).toEqual({ secret: 'shh', open: 'visible' })
  })

  // #1051 retargeted this: the old `id === undefined` case is now a COMPILE
  // error (`ref.id` is a required string), so the runtime backstop guards the
  // value that can still slip through — an empty id, which would bind every
  // such record to the same identity once AAD is on.
  it('encryptRecord refuses when hasAtRestHooks is true but the record id is empty', async () => {
    const dek = await generateDEK()
    const pipeline = ViaPipeline.build([fixtureBinding()])!
    const codec = new RecordCodec(makeCtx({ storeCiphertext: true, via: pipeline, dek }))

    await expect(codec.encryptRecord({ collection: 'c', id: '' }, { secret: 'shh' }, 1)).rejects.toThrow(/record id/i)
  })

  // #1041: AAD SUBSUMES this guard on the read path. "No id supplied" is now a
  // compile error, and an empty id no longer even reaches the sealed-slot
  // check — the body was sealed against the real id, so decryption fails
  // first. The guard stays as a backstop for a plaintext collection (no AEAD,
  // nothing to catch it), but here the assertion is that a wrong identity is
  // refused, not which layer refuses it.
  it('decryptRecord refuses an empty record id when at-rest hooks are declared', async () => {
    const dek = await generateDEK()
    const pipeline = ViaPipeline.build([fixtureBinding()])!
    const codec = new RecordCodec(makeCtx({ storeCiphertext: true, via: pipeline, dek }))
    const envelope = await codec.encryptRecord({ collection: 'c', id: 'r1' }, { secret: 'shh' }, 1, undefined)

    await expect(codec.decryptRecord({ collection: 'c', id: '' }, envelope)).rejects.toThrow()
  })
})

describe('zero-via fast path stays on the inline path (#629 Task 3 parity)', () => {
  it('a via pipeline with no at-rest hooks (money-like) still seals via the classic sensitiveFields path', async () => {
    const dek = await generateDEK()
    const syncOnlyBinding: NoydbVia = { brand: 'sync-only', posture: posture(), ingest: (r) => r }
    const pipeline = ViaPipeline.build([syncOnlyBinding])!
    expect(pipeline.hasAtRestHooks).toBe(false)

    const codec = new RecordCodec(makeCtx({ storeCiphertext: true, via: pipeline, dek, sensitiveFields: new Set(['secret']) }))

    const envelope = await codec.encryptRecord({ collection: 'c', id: 'r1' }, { secret: 'shh', open: 'visible' }, 1)

    expect(envelope._sealed).toBeDefined()
    expect(envelope._sealed!.secret).toMatch(/^.+:.+$/)
    const decoded = await codec.decryptRecord({ collection: 'c', id: 'r1' }, envelope)
    expect(decoded).toEqual({ secret: 'shh', open: 'visible' })
  })

  it('`via: undefined` and a no-at-rest-hooks pipeline produce structurally identical envelopes', async () => {
    const dek = await generateDEK()
    const record = { secret: 'shh', open: 'visible' }
    const codecNoVia = new RecordCodec(makeCtx({ storeCiphertext: true, dek, sensitiveFields: new Set(['secret']) }))
    const syncOnlyBinding: NoydbVia = { brand: 'sync-only', posture: posture(), ingest: (r) => r }
    const codecSyncPipeline = new RecordCodec(
      makeCtx({ storeCiphertext: true, via: ViaPipeline.build([syncOnlyBinding])!, dek, sensitiveFields: new Set(['secret']) }),
    )

    const envNoVia = await codecNoVia.encryptRecord({ collection: 'c', id: 'r1' }, record, 1)
    const envSyncPipeline = await codecSyncPipeline.encryptRecord({ collection: 'c', id: 'r1' }, record, 1)

    expect(Object.keys(envNoVia).sort()).toEqual(Object.keys(envSyncPipeline).sort())
    expect(Object.keys(envNoVia._sealed ?? {})).toEqual(Object.keys(envSyncPipeline._sealed ?? {}))
    expect(await codecNoVia.decryptRecord({ collection: 'c', id: 'r1' }, envNoVia)).toEqual(await codecSyncPipeline.decryptRecord({ collection: 'c', id: 'r1' }, envSyncPipeline))
  })
})

describe('viaCryptoCtx.reservedEnvelopes — per-collection DEK resolution (#629 Task 4)', () => {
  /**
   * A binding declaring `reservedPrefixes` gets a `crypto.reservedEnvelopes`
   * door whose DEK resolver must resolve the RESERVED collection's own DEK
   * (e.g. `_dict_other`), never `this.ctx.name`'s ("fixtures") — the bug the
   * Task 3 review flagged: `() => this.ctx.getDEK()` ignored its `collection`
   * argument entirely. Proven end-to-end: the fixture binding's
   * `encodeAtRest` mints a reserved envelope for a DIFFERENT collection than
   * the one being written, and only the reserved collection's DEK opens it.
   */
  it("resolves the reserved collection's DEK, not the record's own collection DEK", async () => {
    const ownDek = await generateDEK()
    const dictDek = await generateDEK()
    const deks = new Map<string, EnclaveKey>([
      ['fixtures', ownDek],
      ['_dict_other', dictDek],
    ])

    let captured: EncryptedEnvelope | undefined
    const reservedBinding: NoydbVia = {
      brand: 'reserved-fixture',
      posture: posture(),
      reservedPrefixes: ['_dict_'],
      async encodeAtRest(record, crypto) {
        captured = await crypto.reservedEnvelopes('_dict_').encrypt({ collection: '_dict_other', id: 'r1' }, JSON.stringify({ hello: 'world' }), 1)
        return { record }
      },
    }
    const pipeline = ViaPipeline.build([reservedBinding])!
    const ctx: RecordCodecContext<Record<string, unknown>> = {
      ...makeCtx({ storeCiphertext: true, via: pipeline, dek: ownDek }),
      getDEK: async (collection?: string) => {
        const key = collection ?? 'fixtures'
        const dek = deks.get(key)
        if (!dek) throw new Error(`no fixture DEK registered for "${key}"`)
        return dek
      },
    }
    const codec = new RecordCodec(ctx)

    await codec.encryptRecord({ collection: 'c', id: 'r1' }, { open: 'visible' }, 1, undefined)

    expect(captured).toBeDefined()
    // AAD is the reserved envelope's own address, not the record's (#1041).
    const aad = recordAadFor({ collection: '_dict_other', id: 'r1' }, captured!)
    // The record's OWN collection DEK must NOT open the reserved envelope.
    await expect(decrypt(captured!._iv, captured!._data, ownDek, aad)).rejects.toThrow()
    // Only the reserved collection's DEK does.
    const json = await decrypt(captured!._iv, captured!._data, dictDek, aad)
    expect(JSON.parse(json)).toEqual({ hello: 'world' })
  })
})

describe('at-rest hook failure propagates through the codec boundary (#629 Task 5 — first real at-rest binding)', () => {
  /**
   * An earlier review flagged the hook-throwing path as missing coverage:
   * every prior codec-boundary test proves the SUCCESS path. This uses the
   * real classified binding (not a fixture). Both failures are genuine —
   * not simulated by breaking codec plumbing (a broken `getDEK` would also
   * fail body encryption independently of the hook, confounding the proof)
   * — so a passing test here is proof the HOOK's own failure specifically
   * propagates, not some unrelated codec-level failure.
   */
  const fixtureGuardCtx = {
    perRecordKeys: false, crdt: false, hasConflictPolicy: false, storeCiphertext: true,
    deterministicFields: null, indexedFields: new Set<string>(), textIndexFields: new Set<string>(),
    vectorSourceFields: new Set<string>(), subjectKeyField: undefined, bareSensitiveFields: new Set<string>(),
    acknowledgeEquatableRisk: false,
  }

  it('encryptRecord rejects when the binding\'s encodeAtRest hook throws (unserializable field value)', async () => {
    const dek = await generateDEK()
    const pipeline = ViaPipeline.build([
      classifiedVia({ entries: { mail: classified.email() }, collectionName: 'fixtures', guardCtx: fixtureGuardCtx }),
    ])!
    const codec = new RecordCodec(makeCtx({ storeCiphertext: true, via: pipeline, dek }))

    // A BigInt value: JSON.stringify throws inside sealOneField, BEFORE any
    // crypto runs — a genuine encodeAtRest-hook failure, not a codec-level one.
    await expect(
      codec.encryptRecord({ collection: 'c', id: 'r1' }, { mail: 10n as unknown as string }, 1, undefined),
    ).rejects.toThrow(/BigInt/)
  })

  it('decryptRecord rejects when the binding\'s decodeAtRest hook throws (tampered sealed slot)', async () => {
    const dek = await generateDEK()
    const cfg = { entries: { mail: classified.email() }, collectionName: 'fixtures', guardCtx: fixtureGuardCtx }
    const pipeline = ViaPipeline.build([classifiedVia(cfg)])!
    const codec = new RecordCodec(makeCtx({ storeCiphertext: true, via: pipeline, dek }))
    const envelope = await codec.encryptRecord(
      { collection: 'c', id: 'r1' },
      { mail: 'person@example.com' },
      1,
    )
    expect(envelope._sealed!.mail).toBeDefined()

    // Tamper the sealed slot's ciphertext — AES-GCM auth fails inside
    // crypto.sealedSlots.unseal, called from decodeAtRest.
    const [iv, data] = envelope._sealed!.mail!.split(':')
    const tamperedData = data!.slice(0, -2) + (data!.slice(-2) === '00' ? '11' : '00')
    const tampered: EncryptedEnvelope = { ...envelope, _sealed: { mail: `${iv}:${tamperedData}` } }

    await expect(codec.decryptRecord({ collection: 'c', id: 'r1' }, tampered)).rejects.toThrow()
  })
})
