import { describe, it, expect } from 'vitest'
import { installViaBinder } from '../../src/kernel/via.js'
import { compileViaBindings, resolveCollectionConfig, type CollectionOpts } from '../../src/kernel/collection-config.js'
import { ViaPipeline } from '../../src/kernel/via-pipeline.js'
import { NoydbEventEmitter } from '../../src/kernel/events.js'

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

describe('via config-compile seam (#623 Task 3)', () => {
  it('compileViaBindings returns [] regardless of installed binders — no consumers yet', () => {
    // A fixture binder installed under a foreign brand must not leak into
    // the compiled list: compileViaBindings has no wiring to consult the
    // registry until Tasks 5/8 add the money/i18n entries.
    installViaBinder('fixture', () => ({
      brand: 'fixture',
      posture: { encryptedAtRest: 'envelope', queryable: 'none', exportable: true, forgettable: true },
    }))

    const bindings = compileViaBindings(syntheticOpts())
    expect(bindings).toEqual([])
    // the zero-via fast path
    expect(ViaPipeline.build(bindings)).toBeUndefined()
  })

  it('resolveCollectionConfig wires cfg.via via ViaPipeline.build — undefined for a plain collection', () => {
    const cfg = resolveCollectionConfig(syntheticOpts())
    expect(cfg.via).toBeUndefined()
  })
})
