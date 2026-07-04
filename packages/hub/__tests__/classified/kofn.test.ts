import { describe, it, expect } from 'vitest'
import { evaluateKofN } from '../../src/kernel/enclave/classify/kofn.js'

describe('evaluateKofN', () => {
  it('truth table', () => {
    expect(evaluateKofN([true, true, false], 2)).toBe(true)
    expect(evaluateKofN([true, false, false], 2)).toBe(false)
    expect(evaluateKofN([true, true, true], 3)).toBe(true)
    expect(evaluateKofN([false, false, false], 1)).toBe(false)
    expect(evaluateKofN([true], 1)).toBe(true)
    expect(evaluateKofN([true, true, false, false], 2)).toBe(true)
  })

  it('min bounds are caller-bug throws (I2c)', () => {
    expect(() => evaluateKofN([true, true], 0)).toThrow(/out of range/)
    expect(() => evaluateKofN([true, true], 3)).toThrow(/out of range/)
    expect(() => evaluateKofN([true, true], 1.5)).toThrow(/out of range/)
    expect(() => evaluateKofN([], 1)).toThrow(/out of range/)
  })
})
