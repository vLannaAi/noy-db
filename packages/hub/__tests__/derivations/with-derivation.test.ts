import { describe, it, expect } from 'vitest'
import { withDerivation } from '../../src/derivations/with-derivation.js'

describe('withDerivation factory', () => {
  it('returns a handle with __noydb_strategy: "derivation"', () => {
    const h = withDerivation({
      source: 'pdfs',
      deterministic: true,
      outputs: { meta: { shape: 'record', collection: 'pdf-meta' } },
      derive: (s: { body: string }) => ({ meta: { len: s.body.length } }),
      lifecycle: 'eager',
    })
    expect(h.__noydb_strategy).toBe('derivation')
    expect(h.spec.source).toBe('pdfs')
  })

  it('rejects missing source', () => {
    expect(() =>
      withDerivation({
        source: '',
        deterministic: true,
        outputs: { o: { shape: 'record', collection: 'x' } },
        derive: () => ({ o: {} } as any),
        lifecycle: 'eager',
      } as any),
    ).toThrow(/source/i)
  })

  it('rejects empty outputs map', () => {
    expect(() =>
      withDerivation({
        source: 's',
        deterministic: true,
        outputs: {},
        derive: () => ({} as any),
        lifecycle: 'eager',
      } as any),
    ).toThrow(/outputs/i)
  })

  it('rejects non-deterministic spec in v1', () => {
    expect(() =>
      withDerivation({
        source: 's',
        deterministic: false as unknown as true,
        outputs: { o: { shape: 'record', collection: 'x' } },
        derive: () => ({ o: {} } as any),
        lifecycle: 'eager',
      } as any),
    ).toThrow(/deterministic/i)
  })
})
