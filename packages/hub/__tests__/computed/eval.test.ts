import { describe, it, expect } from 'vitest'
import { evalComputedFields, ComputedFieldError } from '../../src/computed/index.js'

describe('evalComputedFields', () => {
  it('injects a computed value derived from input fields', () => {
    const out = evalComputedFields(
      { unitPrice: 10, qty: 3 },
      { netAmount: (r) => (r.unitPrice as number) * (r.qty as number) },
      'a',
    )
    expect(out).toEqual({ unitPrice: 10, qty: 3, netAmount: 30 })
  })

  it('evaluates in declaration order — later fields read earlier ones', () => {
    const out: Record<string, unknown> = evalComputedFields(
      { unitPrice: 10, qty: 2 },
      {
        netAmount: (r) => (r.unitPrice as number) * (r.qty as number),
        taxAmount: (r) => (r.netAmount as number) * 0.5,
        total: (r) => (r.netAmount as number) + (r.taxAmount as number),
      },
      'a',
    )
    expect(out.netAmount).toBe(20)
    expect(out.taxAmount).toBe(10)
    expect(out.total).toBe(30)
  })

  it('overwrites a user-supplied value of the same name', () => {
    const out = evalComputedFields({ n: 1, total: 999 }, { total: () => 42 }, 'a')
    expect(out.total).toBe(42)
  })

  it('does not mutate the input record', () => {
    const input = { n: 1 }
    evalComputedFields(input, { doubled: (r) => (r.n as number) * 2 }, 'a')
    expect(input).toEqual({ n: 1 })
  })

  it('wraps a throwing function in ComputedFieldError', () => {
    expect(() =>
      evalComputedFields({ n: 0 }, { bad: () => { throw new Error('boom') } }, 'rec1'),
    ).toThrow(ComputedFieldError)
    try {
      evalComputedFields({ n: 0 }, { bad: () => { throw new Error('boom') } }, 'rec1')
    } catch (e) {
      expect((e as ComputedFieldError).field).toBe('bad')
      expect((e as ComputedFieldError).id).toBe('rec1')
      expect((e as ComputedFieldError).message).toContain('boom')
    }
  })
})
