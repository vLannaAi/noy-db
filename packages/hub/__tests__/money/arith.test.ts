import { describe, it, expect } from 'vitest'
import { mulRate, allocate, MoneyUnsupportedError } from '../../src/index.js'

// #337 — exact arithmetic helpers. The invariant under test throughout:
// no float step anywhere, so Σ parts === whole holds EXACTLY (zero
// tolerance), and rate application rounds once, at the end, in the
// requested mode.

describe('mulRate (#337)', () => {
  it('applies a VAT-style rate on the canonical decoded string', () => {
    expect(mulRate('10000.00', 0.07)).toBe('700.00')
    expect(mulRate('10000.00', '0.07')).toBe('700.00')
  })

  it('rounds once, at the end, in the requested mode', () => {
    // 33.33 × 0.07 = 2.3331 → half-up 2.33, ceil 2.34
    expect(mulRate('33.33', 0.07)).toBe('2.33')
    expect(mulRate('33.33', 0.07, { rounding: 'ceil' })).toBe('2.34')
    // 0.05 × 0.5 = 0.025 — the classic float trap (0.05*0.5 is fine but
    // 2.675*100-style drift is not); half-up 0.03, half-even 0.02
    expect(mulRate('0.05', 0.5)).toBe('0.03')
    expect(mulRate('0.05', 0.5, { rounding: 'half-even' })).toBe('0.02')
  })

  it('output scale follows the amount, or the explicit option', () => {
    expect(mulRate(100, 0.07)).toBe('7')
    expect(mulRate(100, 0.07, { scale: 2 })).toBe('7.00')
    expect(mulRate('100.0', 0.07, { scale: 0, rounding: 'half-up' })).toBe('7')
  })

  it('is exact past 2^53', () => {
    // 90071992547409.91 × 100 in float space loses integer precision;
    // BigInt space does not.
    expect(mulRate('90071992547409.91', '100')).toBe('9007199254740991.00')
    expect(mulRate('9007199254740993.00', '1')).toBe('9007199254740993.00')
  })

  it('handles negative amounts and rates', () => {
    expect(mulRate('-10000.00', 0.07)).toBe('-700.00')
    expect(mulRate('10000.00', '-0.07')).toBe('-700.00')
    // -2.3331 → half-up rounds the magnitude: -2.33
    expect(mulRate('-33.33', 0.07)).toBe('-2.33')
    expect(mulRate('-33.33', 0.07, { rounding: 'floor' })).toBe('-2.34')
  })

  it('throws loudly on malformed input', () => {
    expect(() => mulRate('banana', 0.07)).toThrow(MoneyUnsupportedError)
    expect(() => mulRate('100.00', 'banana')).toThrow(MoneyUnsupportedError)
    expect(() => mulRate(Infinity, 0.07)).toThrow(MoneyUnsupportedError)
    expect(() => mulRate('100.00', 0.07, { scale: -1 })).toThrow(MoneyUnsupportedError)
  })
})

describe('allocate (#337)', () => {
  it('splits with zero drift — parts sum EXACTLY to the input', () => {
    expect(allocate('100.00', [1, 1, 1])).toEqual(['33.34', '33.33', '33.33'])
    expect(allocate('0.05', [3, 7])).toEqual(['0.02', '0.03'])
    expect(allocate('0.01', [1, 1, 1])).toEqual(['0.01', '0.00', '0.00'])
  })

  it('largest remainder gets the spare minor units (not first-come)', () => {
    // 1000 cents across [1, 2, 4] (Σ=7): floors 142, 285, 571 leave two
    // spare cents; remainders are 6/7, 5/7, 3/7 → buckets 0 and 1 get
    // one each, bucket 2 (smallest remainder) gets none.
    expect(allocate('10.00', [1, 2, 4])).toEqual(['1.43', '2.86', '5.71'])
  })

  it('ties break by position — earlier bucket first', () => {
    expect(allocate('0.03', [1, 1])).toEqual(['0.02', '0.01'])
  })

  it('zero-weight buckets get exactly zero', () => {
    expect(allocate('100.00', [1, 0, 1])).toEqual(['50.00', '0.00', '50.00'])
  })

  it('decimal-string weights stay exact (no float ratio anywhere)', () => {
    expect(allocate('100.00', ['0.1', '0.2'])).toEqual(['33.33', '66.67'])
  })

  it('negative amounts allocate symmetrically and still sum exactly', () => {
    expect(allocate('-100.00', [1, 1, 1])).toEqual(['-33.34', '-33.33', '-33.33'])
  })

  it('is exact past 2^53', () => {
    const parts = allocate('9007199254740993.00', [1, 1])
    expect(parts).toEqual(['4503599627370496.50', '4503599627370496.50'])
  })

  it('property: Σ parts === whole for awkward shapes', () => {
    const cases: Array<[string, number[]]> = [
      ['999.97', [3, 3, 3]],
      ['0.07', [5, 3, 1, 1]],
      ['123456.78', [7, 11, 13]],
      ['1.00', [1, 1, 1, 1, 1, 1, 1]],
    ]
    for (const [amount, weights] of cases) {
      const parts = allocate(amount, weights)
      const sum = parts.reduce((acc, p) => acc + BigInt(p.replace('.', '')), 0n)
      expect(sum).toBe(BigInt(amount.replace('.', '')))
    }
  })

  it('throws loudly on empty / all-zero / negative weights and bad amounts', () => {
    expect(() => allocate('100.00', [])).toThrow(MoneyUnsupportedError)
    expect(() => allocate('100.00', [0, 0])).toThrow(MoneyUnsupportedError)
    expect(() => allocate('100.00', [1, -1])).toThrow(MoneyUnsupportedError)
    expect(() => allocate('banana', [1, 1])).toThrow(MoneyUnsupportedError)
  })
})
