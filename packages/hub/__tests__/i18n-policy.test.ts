/**
 * resolvePolicy — per-layer onMissing resolution.
 *
 * Encodes the spec's effective-policy table:
 *   policy(λ) = explicit(λ) ?? layerDefault(λ) ?? scalar ?? 'throw'
 *   layerDefault('guard') = 'substitute'  (lenient, never inherits a scalar)
 *   layerDefault(other)   = undefined
 */
import { describe, it, expect } from 'vitest'
import { resolvePolicy } from '../src/with-shape/i18n/policy.js'

describe('resolvePolicy', () => {
  it('undefined onMissing → throw for every layer except guard', () => {
    expect(resolvePolicy(undefined, 'read')).toBe('throw')
    expect(resolvePolicy(undefined, 'mv')).toBe('throw')
    expect(resolvePolicy(undefined, 'derivation')).toBe('throw')
    expect(resolvePolicy(undefined, 'export')).toBe('throw')
    expect(resolvePolicy(undefined, 'join')).toBe('throw')
    expect(resolvePolicy(undefined, 'guard')).toBe('substitute')
  })

  it('scalar applies to all non-guard layers; guard stays lenient', () => {
    expect(resolvePolicy('throw', 'read')).toBe('throw')
    expect(resolvePolicy('substitute', 'mv')).toBe('substitute')
    expect(resolvePolicy('null', 'join')).toBe('null')
    // guard never inherits the scalar
    expect(resolvePolicy('throw', 'guard')).toBe('substitute')
    expect(resolvePolicy('null', 'guard')).toBe('substitute')
  })

  it('explicit guard override beats the lenient default', () => {
    expect(resolvePolicy({ guard: 'throw' }, 'guard')).toBe('throw')
    expect(resolvePolicy({ guard: 'null' }, 'guard')).toBe('null')
  })

  it('partial object: listed→value; unlisted non-guard→throw; guard→substitute', () => {
    const p = { read: 'substitute', mv: 'throw' } as const
    expect(resolvePolicy(p, 'read')).toBe('substitute')
    expect(resolvePolicy(p, 'mv')).toBe('throw')
    expect(resolvePolicy(p, 'join')).toBe('throw') // unlisted non-guard
    expect(resolvePolicy(p, 'export')).toBe('throw')
    expect(resolvePolicy(p, 'guard')).toBe('substitute') // unlisted guard
  })
})
