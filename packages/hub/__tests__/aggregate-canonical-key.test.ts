import { describe, it, expect } from 'vitest'
import { canonicalGroupKey } from '../src/with-lookup/reduce/canonical-key.js'

describe('canonicalGroupKey', () => {
  it('returns a single-field encoding for one key', () => {
    expect(canonicalGroupKey(['period'], { period: '2026-05' }))
      .toBe('period="2026-05"')
  })

  it('sorts field names lexicographically before serialising', () => {
    const a = canonicalGroupKey(['clientId', 'period'], { clientId: 'c1', period: '2026-05' })
    const b = canonicalGroupKey(['period', 'clientId'], { clientId: 'c1', period: '2026-05' })
    expect(a).toBe(b)
    expect(a).toBe('clientId="c1"|period="2026-05"')
  })

  it('JSON-stringifies value types', () => {
    expect(canonicalGroupKey(['n'], { n: 42 })).toBe('n=42')
    expect(canonicalGroupKey(['flag'], { flag: true })).toBe('flag=true')
    expect(canonicalGroupKey(['obj'], { obj: { a: 1 } })).toBe('obj={"a":1}')
  })

  it('distinguishes undefined and null', () => {
    expect(canonicalGroupKey(['x'], { x: undefined })).toBe('x=undefined')
    expect(canonicalGroupKey(['x'], { x: null })).toBe('x=null')
  })

  it('reads missing fields as undefined', () => {
    expect(canonicalGroupKey(['absent'], {})).toBe('absent=undefined')
  })

  it('three-key composite is order-invariant in fields argument', () => {
    const row = { clientId: 'c1', period: '2026-05', direction: 'in' }
    const k1 = canonicalGroupKey(['clientId', 'period', 'direction'], row)
    const k2 = canonicalGroupKey(['direction', 'clientId', 'period'], row)
    expect(k1).toBe(k2)
  })
})
