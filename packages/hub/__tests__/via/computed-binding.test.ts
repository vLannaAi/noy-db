import { describe, it, expect } from 'vitest'
import { computedBinding } from '../../src/shape/via-computed/binding.js'
import type { ComputedDescriptor } from '../../src/shape/via-computed/descriptor.js'

function virtualDescriptor(fn: (record: Record<string, unknown>) => unknown, deps?: readonly string[]): ComputedDescriptor {
  return { _viaBrand: 'computed', fn, mode: 'virtual', ...(deps !== undefined ? { deps } : {}) }
}

describe('computedBinding (#638 Task 7)', () => {
  it('declares the computed brand + the fixed virtual posture (queryable: none, unconditionally)', () => {
    const b = computedBinding({ virtualFields: new Map([['doubled', virtualDescriptor((r) => (r.amount as number) * 2)]]) })
    expect(b.brand).toBe('computed')
    expect(b.posture).toEqual({
      encryptedAtRest: 'envelope',
      queryable: 'none',
      exportable: true,
      forgettable: false,
    })
  })

  it('covers only its declared virtual fields', () => {
    const b = computedBinding({ virtualFields: new Map([['doubled', virtualDescriptor((r) => r.amount)]]) })
    expect(b.covers?.('doubled')).toBe(true)
    expect(b.covers?.('other')).toBe(false)
  })

  it('present() computes each virtual field from the accumulating record, in Map iteration order', async () => {
    const b = computedBinding({
      virtualFields: new Map([
        ['doubled', virtualDescriptor((r) => (r.amount as number) * 2, ['amount'])],
        ['quadrupled', virtualDescriptor((r) => (r.doubled as number) * 2, ['doubled'])],
      ]),
    })
    const out = await b.present!({ id: 'x', amount: 5 }, { layer: 'read' })
    expect(out.doubled).toBe(10)
    expect(out.quadrupled).toBe(20) // reads the SAME call's already-set 'doubled'
  })

  it('present() does not mutate the input record', async () => {
    const b = computedBinding({ virtualFields: new Map([['doubled', virtualDescriptor((r) => (r.amount as number) * 2)]]) })
    const input = { id: 'x', amount: 5 }
    const out = await b.present!(input, { layer: 'read' })
    expect(input).not.toHaveProperty('doubled')
    expect(out).not.toBe(input)
  })

  it('declares no at-rest hooks — a virtual field is never sealed/stored', () => {
    const b = computedBinding({ virtualFields: new Map([['doubled', virtualDescriptor((r) => r.amount)]]) })
    expect(b.encodeAtRest).toBeUndefined()
    expect(b.decodeAtRest).toBeUndefined()
  })

  it('declares no query-participation hooks — queryable:none is enforced entirely via posture', () => {
    const b = computedBinding({ virtualFields: new Map([['doubled', virtualDescriptor((r) => r.amount)]]) })
    expect(b.buildClause).toBeUndefined()
    expect(b.evaluateClause).toBeUndefined()
    expect(b.compareForOrder).toBeUndefined()
    expect(b.wrapReducers).toBeUndefined()
  })
})
