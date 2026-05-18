import { describe, it, expect } from 'vitest'
import {
  NoydbError,
  DerivationCycleError,
  DerivationDepthError,
  DerivationOutputUnknownError,
  DerivationOutputShapeError,
} from '../../src/errors.js'

describe('derivation errors', () => {
  it('DerivationCycleError lists the cycle path', () => {
    const e = new DerivationCycleError(['a', 'b', 'c', 'a'])
    expect(e).toBeInstanceOf(NoydbError)
    expect(e.code).toBe('DERIVATION_CYCLE')
    expect(e.path).toEqual(['a', 'b', 'c', 'a'])
    expect(e.message).toContain('a → b → c → a')
  })

  it('DerivationDepthError reports limit + current depth', () => {
    const e = new DerivationDepthError(5, 7)
    expect(e.code).toBe('DERIVATION_DEPTH')
    expect(e.limit).toBe(5)
    expect(e.attempted).toBe(7)
  })

  it('DerivationOutputUnknownError names the missing output collection', () => {
    const e = new DerivationOutputUnknownError('pdf-text-NOT-REGISTERED')
    expect(e.code).toBe('DERIVATION_OUTPUT_UNKNOWN')
    expect(e.collection).toBe('pdf-text-NOT-REGISTERED')
  })

  it('DerivationOutputShapeError names the offending output key', () => {
    const e = new DerivationOutputShapeError('metadata', 'expected object, got string')
    expect(e.code).toBe('DERIVATION_OUTPUT_SHAPE')
    expect(e.outputKey).toBe('metadata')
  })
})
