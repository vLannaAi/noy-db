import { describe, it, expect } from 'vitest'
import { installViaBinder } from '../../src/kernel/via.js'
import { compileViaBindings, resolveCollectionConfig, type CollectionOpts } from '../../src/kernel/collection-config.js'
import { ViaPipeline } from '../../src/kernel/via-pipeline.js'
import { NoydbEventEmitter } from '../../src/kernel/events.js'
import { classified } from '../../src/shape/via-classified/presets.js'
import type { ClassifiedGuardCtx } from '../../src/port/with/classified-strategy.js'

// Synthetic opts — resolveCollectionConfig/compileViaBindings never call methods
// on adapter/keyring/getDEK, only forward them, so undefined stand-ins are safe.
function syntheticOpts(): CollectionOpts<unknown> {
  return {
    adapter: undefined,
    vault: 'test-vault',
    name: 'test-collection',
    keyring: undefined,
    encrypted: false,
    emitter: new NoydbEventEmitter(),
    getDEK: async () => { throw new Error('unused in this test') },
  } as unknown as CollectionOpts<unknown>
}

// #629 Task 6 — compileViaBindings gained a required classifiedGuardCtx
// parameter (the classified binding's construction input); a plain
// collection with no classifiedFields never reads it.
function emptyGuardCtx(): ClassifiedGuardCtx {
  return {
    perRecordKeys: false, crdt: false, hasConflictPolicy: false, storeCiphertext: true,
    deterministicFields: null, indexedFields: new Set(), textIndexFields: new Set(),
    vectorSourceFields: new Set(), subjectKeyField: undefined, bareSensitiveFields: new Set(),
    acknowledgeEquatableRisk: false,
  }
}

describe('via config-compile seam (#623 Task 3)', () => {
  it('compileViaBindings returns [] regardless of installed binders — no consumers yet', () => {
    // A fixture binder installed under a foreign brand must not leak into
    // the compiled list: compileViaBindings has no wiring to consult the
    // registry until Tasks 5/8 add the money/i18n entries.
    installViaBinder('fixture', () => ({
      brand: 'fixture',
      posture: { encryptedAtRest: 'envelope', queryable: 'none', exportable: true, forgettable: true },
    }))

    const bindings = compileViaBindings(syntheticOpts(), emptyGuardCtx())
    expect(bindings).toEqual([])
    // the zero-via fast path
    expect(ViaPipeline.build(bindings)).toBeUndefined()
  })

  it('resolveCollectionConfig wires cfg.via via ViaPipeline.build — undefined for a plain collection', () => {
    const cfg = resolveCollectionConfig(syntheticOpts())
    expect(cfg.via).toBeUndefined()
  })
})

describe('via config-compile seam — classified (#629 Task 6)', () => {
  it('compileViaBindings compiles a classified binding LAST when classifiedFields is declared', () => {
    const opts = {
      ...syntheticOpts(),
      classifiedFields: { note: classified.email() },
    } as CollectionOpts<unknown>

    const bindings = compileViaBindings(opts, emptyGuardCtx())

    expect(bindings.map((b) => b.brand)).toEqual(['classified'])
    // hasAtRestHooks becomes true — the codec boundary now routes this
    // collection's sealed-field crypto through the binding's encodeAtRest/
    // decodeAtRest hooks instead of the inline sensitiveFields path.
    expect(ViaPipeline.build(bindings)!.hasAtRestHooks).toBe(true)
  })

  it('compileViaBindings pushes nothing classified-branded when classifiedFields is absent', () => {
    const bindings = compileViaBindings(syntheticOpts(), emptyGuardCtx())
    expect(bindings.some((b) => b.brand === 'classified')).toBe(false)
  })

  it('resolveCollectionConfig wires a classified collection\'s cfg.via with hasAtRestHooks true', () => {
    const opts = {
      ...syntheticOpts(),
      encrypted: true,
      perRecordKeys: true,
      classifiedFields: { secret: classified.password() },
    } as CollectionOpts<unknown>

    const cfg = resolveCollectionConfig(opts)

    expect(cfg.via?.hasAtRestHooks).toBe(true)
    expect(cfg.classified?.byField.secret?.storage).toBe('digest-only')
  })
})

describe('via config-compile seam — blob (#629 Task 7)', () => {
  it('compileViaBindings compiles a blob binding when blobFields is declared — WITHOUT at-rest hooks', () => {
    const opts = {
      ...syntheticOpts(),
      blobFields: { receipt: { retainDays: 30 } },
    } as CollectionOpts<unknown>

    const bindings = compileViaBindings(opts, emptyGuardCtx())

    expect(bindings.map((b) => b.brand)).toEqual(['blob'])
    // Blob content is out-of-band (BlobSet side-collections) — the binding
    // must NOT flip hasAtRestHooks, or the codec would abandon its inline
    // seal path for a feature that never seals record fields (#629 lesson 2).
    expect(ViaPipeline.build(bindings)!.hasAtRestHooks).toBe(false)
  })

  it('compileViaBindings pushes nothing blob-branded when blobFields is absent', () => {
    const bindings = compileViaBindings(syntheticOpts(), emptyGuardCtx())
    expect(bindings.some((b) => b.brand === 'blob')).toBe(false)
  })

  it('classified + blob compile together — blob LAST, hasAtRestHooks true (from classified alone)', () => {
    const opts = {
      ...syntheticOpts(),
      classifiedFields: { note: classified.email() },
      blobFields: { attachment: {} },
    } as CollectionOpts<unknown>

    const bindings = compileViaBindings(opts, emptyGuardCtx())

    expect(bindings.map((b) => b.brand)).toEqual(['classified', 'blob'])
    expect(ViaPipeline.build(bindings)!.hasAtRestHooks).toBe(true)
  })

  it('resolveCollectionConfig wires a blobFields-only collection\'s cfg.via — pipeline present, no at-rest hooks', () => {
    const opts = {
      ...syntheticOpts(),
      blobFields: { receipt: { retainDays: 30 } },
    } as CollectionOpts<unknown>

    const cfg = resolveCollectionConfig(opts)

    expect(cfg.via).toBeDefined()
    expect(cfg.via!.hasAtRestHooks).toBe(false)
    expect(cfg.via!.bindings.map((b) => b.brand)).toEqual(['blob'])
  })
})
