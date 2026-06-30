import { describe, it, expect } from 'vitest'
import { canonicalize } from '../../src/with-shape/persisted-schemas/canonicalize.js'

describe('canonicalize', () => {
  it('sorts object keys lexicographically at every depth', () => {
    const a = canonicalize({ b: 1, a: { y: 2, x: 1 } })
    const b = canonicalize({ a: { x: 1, y: 2 }, b: 1 })
    expect(a).toBe(b)
    expect(a).toBe('{"a":{"x":1,"y":2},"b":1}')
  })

  it('preserves array order (arrays are semantically ordered)', () => {
    const out = canonicalize({ items: [3, 1, 2] })
    expect(out).toBe('{"items":[3,1,2]}')
  })

  it('handles nested arrays of objects', () => {
    const out = canonicalize({ rows: [{ b: 2, a: 1 }, { d: 4, c: 3 }] })
    expect(out).toBe('{"rows":[{"a":1,"b":2},{"c":3,"d":4}]}')
  })

  it('handles primitives + null', () => {
    expect(canonicalize(null)).toBe('null')
    expect(canonicalize(42)).toBe('42')
    expect(canonicalize('hi')).toBe('"hi"')
    expect(canonicalize(true)).toBe('true')
  })
})
