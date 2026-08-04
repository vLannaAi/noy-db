import { describe, it, expect } from 'vitest'
import { DerivationRegistry } from '../../src/with-formula/derivations/registry.js'
import { withDerivation } from '../../src/with-formula/derivations/with-derivation.js'
import { DerivationCycleError, DuplicateBehaviorNameError } from '../../src/kernel/errors.js'

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
    // Build the spec directly — withDerivation() now rejects an undeclared
    // self-write at construction (#376), so to exercise validate()'s DFS in
    // isolation (and prove it still flags a denorm-LESS a → a self-cycle) we
    // register a hand-built spec.
    await reg.register({
      source: 'a',
      deterministic: true,
      outputs: { o: { shape: 'record', collection: 'a' } }, // a → a, no denorm
      derive: () => ({ o: {} }),
      lifecycle: 'eager',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
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

  it('throws DuplicateBehaviorNameError when two derivations share a name', async () => {
    const reg = new DerivationRegistry()
    await reg.register(withDerivation({
      source: 'a',
      name: 'dup',
      deterministic: true,
      outputs: { o: { shape: 'record', collection: 'b' } },
      derive: () => ({ o: {} }),
      lifecycle: 'eager',
    }).spec)
    await expect(reg.register(withDerivation({
      source: 'c',
      name: 'dup',
      deterministic: true,
      outputs: { o: { shape: 'record', collection: 'd' } },
      derive: () => ({ o: {} }),
      lifecycle: 'eager',
    }).spec)).rejects.toThrow(DuplicateBehaviorNameError)
    await expect(reg.register(withDerivation({
      source: 'c',
      name: 'dup',
      deterministic: true,
      outputs: { o: { shape: 'record', collection: 'd' } },
      derive: () => ({ o: {} }),
      lifecycle: 'eager',
    }).spec)).rejects.toThrow(/dup/)
  })

  it('allows derivations with different names', async () => {
    const reg = new DerivationRegistry()
    await reg.register(withDerivation({
      source: 'a',
      name: 'first',
      deterministic: true,
      outputs: { o: { shape: 'record', collection: 'b' } },
      derive: () => ({ o: {} }),
      lifecycle: 'eager',
    }).spec)
    await expect(reg.register(withDerivation({
      source: 'c',
      name: 'second',
      deterministic: true,
      outputs: { o: { shape: 'record', collection: 'd' } },
      derive: () => ({ o: {} }),
      lifecycle: 'eager',
    }).spec)).resolves.toBeUndefined()
  })

  it('allows multiple unnamed derivations', async () => {
    const reg = new DerivationRegistry()
    await reg.register(withDerivation({
      source: 'a',
      deterministic: true,
      outputs: { o: { shape: 'record', collection: 'b' } },
      derive: () => ({ o: {} }),
      lifecycle: 'eager',
    }).spec)
    await expect(reg.register(withDerivation({
      source: 'c',
      deterministic: true,
      outputs: { o: { shape: 'record', collection: 'd' } },
      derive: () => ({ o: {} }),
      lifecycle: 'eager',
    }).spec)).resolves.toBeUndefined()
  })
})
