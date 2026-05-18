import { describe, it, expect } from 'vitest'
import { DerivationRegistry } from '../../src/derivations/registry.js'
import { withDerivation } from '../../src/derivations/with-derivation.js'
import { DerivationCycleError } from '../../src/errors.js'

describe('DerivationRegistry', () => {
  it('register + lookup by source', async () => {
    const reg = new DerivationRegistry()
    await reg.register(withDerivation({
      source: 'pdfs',
      deterministic: true,
      outputs: { meta: { shape: 'record', collection: 'pdf-meta' } },
      derive: () => ({ meta: {} }),
      lifecycle: 'eager',
    }).spec)
    expect(reg.strategiesForSource('pdfs')).toHaveLength(1)
    expect(reg.strategiesForSource('nope')).toHaveLength(0)
  })

  it('reverse lookup — output collection → source strategies', async () => {
    const reg = new DerivationRegistry()
    await reg.register(withDerivation({
      source: 'pdfs',
      deterministic: true,
      outputs: { meta: { shape: 'record', collection: 'pdf-meta' } },
      derive: () => ({ meta: {} }),
      lifecycle: 'eager',
    }).spec)
    expect(reg.strategiesProducingOutput('pdf-meta')).toHaveLength(1)
  })

  it('detects self-cycle at register-and-validate', async () => {
    const reg = new DerivationRegistry()
    await reg.register(withDerivation({
      source: 'a',
      deterministic: true,
      outputs: { o: { shape: 'record', collection: 'a' } }, // a → a
      derive: () => ({ o: {} }),
      lifecycle: 'eager',
    }).spec)
    expect(() => reg.validate()).toThrow(DerivationCycleError)
  })

  it('detects A → B → A cycle', async () => {
    const reg = new DerivationRegistry()
    await reg.register(withDerivation({
      source: 'a',
      deterministic: true,
      outputs: { o: { shape: 'record', collection: 'b' } },
      derive: () => ({ o: {} }),
      lifecycle: 'eager',
    }).spec)
    await reg.register(withDerivation({
      source: 'b',
      deterministic: true,
      outputs: { o: { shape: 'record', collection: 'a' } },
      derive: () => ({ o: {} }),
      lifecycle: 'eager',
    }).spec)
    expect(() => reg.validate()).toThrow(DerivationCycleError)
  })

  it('accepts an acyclic graph', async () => {
    const reg = new DerivationRegistry()
    await reg.register(withDerivation({
      source: 'a',
      deterministic: true,
      outputs: { o: { shape: 'record', collection: 'b' } },
      derive: () => ({ o: {} }),
      lifecycle: 'eager',
    }).spec)
    await reg.register(withDerivation({
      source: 'b',
      deterministic: true,
      outputs: { o: { shape: 'record', collection: 'c' } },
      derive: () => ({ o: {} }),
      lifecycle: 'eager',
    }).spec)
    expect(() => reg.validate()).not.toThrow()
  })
})
