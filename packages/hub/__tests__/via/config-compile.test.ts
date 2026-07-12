import { describe, it, expect } from 'vitest'
import { installViaBinder } from '../../src/kernel/via.js'
import { compileViaBindings, resolveCollectionConfig, type CollectionOpts } from '../../src/kernel/collection-config.js'
import { ViaPipeline } from '../../src/kernel/via-pipeline.js'
import { NoydbEventEmitter } from '../../src/kernel/events.js'
import { classified } from '../../src/shape/via-classified/presets.js'
import type { ClassifiedGuardCtx } from '../../src/port/with/classified-strategy.js'
import { via } from '../../src/kernel/via-compose.js'
import { computed } from '../../src/shape/via-computed/descriptor.js'
import { money } from '../../src/shape/via-money/descriptor.js'
import { enumOf, dict } from '../../src/shape/via-lookup/descriptor.js'
import { dictKey } from '../../src/shape/via-i18n/dictionary.js'
import { i18nText } from '../../src/shape/via-i18n/core.js'
import { ValidationError } from '../../src/kernel/errors.js'

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

describe('via config-compile seam — computed (#638 Task 7)', () => {
  it('compileViaBindings compiles a computed binding LAST when a virtual computed field is declared — WITHOUT at-rest hooks', () => {
    const opts = {
      ...syntheticOpts(),
      moneyFields: { amount: money({ currency: 'EUR' }) },
      viaFields: { doubled: via(computed((r) => (r.amount as number) * 2, { deps: ['amount'], mode: 'virtual' })) },
    } as CollectionOpts<unknown>

    const bindings = compileViaBindings(opts, emptyGuardCtx())

    expect(bindings.map((b) => b.brand)).toEqual(['money', 'computed'])
    // Never sealed/stored — the codec must NOT route this collection through
    // the async at-rest-hook path (#553 sync-stack contract).
    expect(ViaPipeline.build(bindings)!.hasAtRestHooks).toBe(false)
  })

  it('compileViaBindings pushes nothing computed-branded for a MATERIALIZED-only via(computed(...)) entry', () => {
    const opts = {
      ...syntheticOpts(),
      viaFields: { total: via(computed((r) => (r.qty as number) * 2, { mode: 'materialized' })) },
    } as CollectionOpts<unknown>

    const bindings = compileViaBindings(opts, emptyGuardCtx())
    expect(bindings.some((b) => b.brand === 'computed')).toBe(false)
  })

  it('compileViaBindings pushes nothing computed-branded when no computed field is declared', () => {
    const bindings = compileViaBindings(syntheticOpts(), emptyGuardCtx())
    expect(bindings.some((b) => b.brand === 'computed')).toBe(false)
  })

  it('resolveCollectionConfig wires a virtual-computed-only collection\'s cfg.via — pipeline present, no at-rest hooks, queryable none', () => {
    const opts = {
      ...syntheticOpts(),
      viaFields: { doubled: via(computed((r) => (r.n as number) * 2, { mode: 'virtual' })) },
    } as CollectionOpts<unknown>

    const cfg = resolveCollectionConfig(opts)

    expect(cfg.via).toBeDefined()
    expect(cfg.via!.hasAtRestHooks).toBe(false)
    expect(cfg.via!.bindings.map((b) => b.brand)).toEqual(['computed'])
    expect(cfg.via!.postureFor('doubled')?.queryable).toBe('none')
    expect(cfg.computed).toBeUndefined() // never merged into the write-time materialized map
  })

  it('a materialized via(computed(...)) entry merges into cfg.computed like the plain sugar form', () => {
    const opts = {
      ...syntheticOpts(),
      viaFields: { total: via(computed((r) => (r.qty as number) * 2, { mode: 'materialized' })) },
    } as CollectionOpts<unknown>

    const cfg = resolveCollectionConfig(opts)
    expect(cfg.computed).toBeDefined()
    expect(Object.keys(cfg.computed!)).toEqual(['total'])
  })
})

describe('via config-compile seam — cross-binding same-field collision guard (#631)', () => {
  it('throws when the same field is claimed by moneyFields AND blobFields', () => {
    const opts = {
      ...syntheticOpts(),
      moneyFields: { amount: money({ currency: 'EUR' }) },
      blobFields: { amount: {} },
    } as CollectionOpts<unknown>

    expect(() => compileViaBindings(opts, emptyGuardCtx())).toThrow(ValidationError)
    expect(() => compileViaBindings(opts, emptyGuardCtx())).toThrow(/"amount"/)
    expect(() => compileViaBindings(opts, emptyGuardCtx())).toThrow(/moneyFields/)
    expect(() => compileViaBindings(opts, emptyGuardCtx())).toThrow(/blobFields/)
  })

  it('throws when the same field is claimed by classifiedFields AND lookupFields', () => {
    const opts = {
      ...syntheticOpts(),
      classifiedFields: { ssn: classified.email() },
      lookupFields: { ssn: enumOf(['a', 'b'] as const) },
    } as CollectionOpts<unknown>

    expect(() => compileViaBindings(opts, emptyGuardCtx())).toThrow(ValidationError)
    expect(() => compileViaBindings(opts, emptyGuardCtx())).toThrow(/"ssn"/)
    expect(() => compileViaBindings(opts, emptyGuardCtx())).toThrow(/classifiedFields/)
    expect(() => compileViaBindings(opts, emptyGuardCtx())).toThrow(/lookupFields/)
  })

  it('does NOT throw for a classified group descriptor whose resolved member field collides with blobFields (group key itself is not a field name)', () => {
    // `classified.creditCard({ pan: 'pan' })`'s top-level key is `card`, but the real
    // sealed field is `pan` (resolveClassifiedFields flattens group members) — a
    // `blobFields` entry literally named `card` does NOT collide with anything real.
    const opts = {
      ...syntheticOpts(),
      classifiedFields: { card: classified.creditCard({ pan: 'pan' }) },
      blobFields: { card: {} },
    } as CollectionOpts<unknown>

    expect(() => compileViaBindings(opts, emptyGuardCtx())).not.toThrow()
  })

  it('control: via(computed(...), money(...)) composing on the SAME field is NOT refused — the documented composition path (#638)', () => {
    const opts = {
      ...syntheticOpts(),
      viaFields: {
        total: via(
          computed((r) => (r.qty as number) * 2, { deps: ['qty'], mode: 'virtual' }),
          money({ currency: 'EUR', scale: 2 }),
        ),
      },
    } as CollectionOpts<unknown>

    const bindings = compileViaBindings(opts, emptyGuardCtx())
    expect(bindings.map((b) => b.brand)).toEqual(['money', 'computed'])
  })

  it('control: via(computed(...), dictKey(...)) composing on the SAME field is NOT refused (i18n family, #631 round 2)', () => {
    const opts = {
      ...syntheticOpts(),
      viaFields: {
        status: via(
          computed((r) => (r.n as number) > 0 ? 'paid' : 'draft', { mode: 'materialized' }),
          dictKey('status', ['draft', 'paid'] as const),
        ),
      },
    } as CollectionOpts<unknown>

    expect(() => compileViaBindings(opts, emptyGuardCtx())).not.toThrow()
  })

  it('control: via(computed(...), dict(...)) composing on the SAME field is NOT refused (lookup family, #631 round 2)', () => {
    const opts = {
      ...syntheticOpts(),
      viaFields: {
        status: via(
          computed((r) => (r.n as number) > 0 ? 'paid' : 'draft', { mode: 'materialized' }),
          dict('status'),
        ),
      },
    } as CollectionOpts<unknown>

    expect(() => compileViaBindings(opts, emptyGuardCtx())).not.toThrow()
  })

  it('control: computed: {...} + dictKeyFields: {...} two-sugar-maps (no via()) composing on the SAME field is NOT refused (i18n family, #631 round 2)', () => {
    const opts = {
      ...syntheticOpts(),
      computed: { status: (r: Record<string, unknown>) => (r.n as number) > 0 ? 'paid' : 'draft' },
      dictKeyFields: { status: dictKey('status', ['draft', 'paid'] as const) },
    } as CollectionOpts<unknown>

    expect(() => compileViaBindings(opts, emptyGuardCtx())).not.toThrow()
  })

  it('control: computed: {...} + lookupFields: {...} two-sugar-maps (no via()) composing on the SAME field is NOT refused (lookup family, #631 round 2)', () => {
    const opts = {
      ...syntheticOpts(),
      computed: { status: (r: Record<string, unknown>) => (r.n as number) > 0 ? 'paid' : 'draft' },
      lookupFields: { status: dict('status') },
    } as CollectionOpts<unknown>

    expect(() => compileViaBindings(opts, emptyGuardCtx())).not.toThrow()
  })

  it('throws (3-claimant tightening): computed + i18nFields + dictKeyFields on ONE field — family-collapse must NOT exempt a 3rd independent claimant (#631 review fix)', () => {
    // i18nFields and dictKeyFields both map to the SAME 'i18n' family, so the naive
    // families.size===2 check would have wrongly exempted this as "computed + i18n" —
    // but there are THREE independent claimants (computed, i18nFields, dictKeyFields), and
    // two of them (i18nFields/dictKeyFields) are themselves colliding on the same field name,
    // which is exactly the mistake this guard exists to catch.
    const opts = {
      ...syntheticOpts(),
      computed: { status: (r: Record<string, unknown>) => (r.n as number) > 0 ? 'paid' : 'draft' },
      i18nFields: { status: i18nText({ languages: ['en', 'th'], required: 'all' }) },
      dictKeyFields: { status: dictKey('status', ['draft', 'paid'] as const) },
    } as CollectionOpts<unknown>

    expect(() => compileViaBindings(opts, emptyGuardCtx())).toThrow(ValidationError)
    expect(() => compileViaBindings(opts, emptyGuardCtx())).toThrow(/"status"/)
  })
})
