import { describe, it, expect } from 'vitest'
import {
  resolveClassifiedFields, ClassifiedConfigError,
  type ClassifiedFieldSpec, type ClassifiedGroup,
} from '../../src/shape/via-classified/resolve.js'

const spec = (over: Partial<ClassifiedFieldSpec> = {}): ClassifiedFieldSpec => ({
  _noydbClassified: true, preset: 'test', storage: 'recoverable',
  list: { kind: 'omit' }, sensitivity: 'pii', ...over,
})

describe('resolveClassifiedFields', () => {
  it('simple entry: key is the field name', () => {
    const r = resolveClassifiedFields('c', { dob: spec() })
    expect(Object.keys(r.byField)).toEqual(['dob'])
    expect(r.byField.dob!.preset).toBe('test')
  })

  it('group entry: members flatten under their own field names', () => {
    const g: ClassifiedGroup = {
      _noydbClassifiedGroup: true, preset: 'grp',
      members: { pan: spec({ storage: 'recoverable' }), cvc: spec({ storage: 'never' }) },
    }
    const r = resolveClassifiedFields('c', { card: g })
    expect(Object.keys(r.byField).sort()).toEqual(['cvc', 'pan'])
  })

  it('riders become <field>_<rider> computed entries reading the source field', () => {
    const r = resolveClassifiedFields('c', {
      pan: spec({ riders: { last4: (v) => String(v).slice(-4) } }),
    })
    expect(r.riderComputed['pan_last4']!({ pan: '4242424242424242' })).toBe('4242')
    expect(r.riderComputed['pan_last4']!({})).toBeUndefined()
  })

  it('throws on duplicate field claims and rider/field collisions', () => {
    const g: ClassifiedGroup = { _noydbClassifiedGroup: true, preset: 'g', members: { dob: spec() } }
    expect(() => resolveClassifiedFields('c', { dob: spec(), g })).toThrow(ClassifiedConfigError)
    expect(() => resolveClassifiedFields('c', {
      a: spec({ riders: { x: (v) => v } }), a_x: spec(),
    })).toThrow(ClassifiedConfigError)
  })
})
