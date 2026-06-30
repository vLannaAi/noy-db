import { describe, it, expect } from 'vitest'
import { scaleForCurrency } from '../../src/with-shape/money/iso4217.js'

describe('scaleForCurrency', () => {
  it('returns ISO-4217 minor units for known codes', () => {
    expect(scaleForCurrency('EUR')).toBe(2)
    expect(scaleForCurrency('USD')).toBe(2)
    expect(scaleForCurrency('JPY')).toBe(0)
    expect(scaleForCurrency('KRW')).toBe(0)
    expect(scaleForCurrency('BHD')).toBe(3)
    expect(scaleForCurrency('KWD')).toBe(3)
  })

  it('returns null for unknown currency (no silent default)', () => {
    expect(scaleForCurrency('ZZZ')).toBeNull()
    expect(scaleForCurrency('XAU')).toBeNull() // gold — caller must set scale
  })
})
