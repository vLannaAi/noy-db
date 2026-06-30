import { describe, it, expect } from 'vitest'
import { parseToScaledInt, formatScaledInt } from '../../src/with-shape/money/fixed-point.js'

const ok = (r: ReturnType<typeof parseToScaledInt>): bigint => {
  if (!r.ok) throw new Error(`expected ok, got ${r.reason}`)
  return r.value
}

describe('parseToScaledInt', () => {
  it('exact, no rounding needed', () => {
    expect(ok(parseToScaledInt('123.45', 2))).toBe(12345n)
    expect(ok(parseToScaledInt(123.45, 2))).toBe(12345n)
    expect(ok(parseToScaledInt('5', 0))).toBe(5n)
    expect(ok(parseToScaledInt('-0.01', 2))).toBe(-1n)
    expect(ok(parseToScaledInt('1.20', 2))).toBe(120n)
    expect(ok(parseToScaledInt('0', 2))).toBe(0n)
    expect(ok(parseToScaledInt('-0', 2))).toBe(0n)
    expect(ok(parseToScaledInt('.5', 2))).toBe(50n)
  })

  it('never uses float multiplication (0.1-class stays exact)', () => {
    expect(ok(parseToScaledInt('0.1', 2))).toBe(10n)
    expect(ok(parseToScaledInt('0.2', 2))).toBe(20n)
    expect(ok(parseToScaledInt('0.3', 2))).toBe(30n)
  })

  it('exact past Number.MAX_SAFE_INTEGER', () => {
    expect(ok(parseToScaledInt('90071992547409.91', 2))).toBe(9007199254740991n)
    expect(ok(parseToScaledInt('999999999999999999.99', 2))).toBe(99999999999999999999n)
  })

  it('handles exponent-notation number input', () => {
    expect(ok(parseToScaledInt(1e-2, 2))).toBe(1n) // 0.01
    expect(ok(parseToScaledInt(1.5e3, 2))).toBe(150000n) // 1500.00
  })

  it('rejects excess precision without rounding', () => {
    expect(parseToScaledInt('123.456', 2)).toEqual({ ok: false, reason: 'precision' })
    expect(parseToScaledInt('0.001', 2)).toEqual({ ok: false, reason: 'precision' })
  })

  it('rejects non-finite / unparseable', () => {
    expect(parseToScaledInt(NaN, 2)).toEqual({ ok: false, reason: 'nonfinite' })
    expect(parseToScaledInt(Infinity, 2)).toEqual({ ok: false, reason: 'nonfinite' })
    expect(parseToScaledInt('abc', 2)).toEqual({ ok: false, reason: 'nonfinite' })
    expect(parseToScaledInt('1.2.3', 2)).toEqual({ ok: false, reason: 'nonfinite' })
  })

  it('rounding modes on the tie digit', () => {
    expect(ok(parseToScaledInt('123.455', 2, 'half-up'))).toBe(12346n)
    expect(ok(parseToScaledInt('123.445', 2, 'half-up'))).toBe(12345n)
    expect(ok(parseToScaledInt('123.455', 2, 'half-even'))).toBe(12346n) // last kept 5 odd → up
    expect(ok(parseToScaledInt('123.445', 2, 'half-even'))).toBe(12344n) // last kept 4 even → stay
    expect(ok(parseToScaledInt('123.465', 2, 'half-even'))).toBe(12346n) // last kept 6 even → stay
    expect(ok(parseToScaledInt('123.451', 2, 'half-down'))).toBe(12345n)
    expect(ok(parseToScaledInt('123.456', 2, 'half-down'))).toBe(12346n)
    expect(ok(parseToScaledInt('123.455', 2, 'half-down'))).toBe(12345n) // exactly 5, no more → down
    expect(ok(parseToScaledInt('123.451', 2, 'down'))).toBe(12345n)
    expect(ok(parseToScaledInt('123.451', 2, 'up'))).toBe(12346n)
    expect(ok(parseToScaledInt('123.451', 2, 'ceil'))).toBe(12346n)
    expect(ok(parseToScaledInt('-123.451', 2, 'ceil'))).toBe(-12345n)
    expect(ok(parseToScaledInt('123.451', 2, 'floor'))).toBe(12345n)
    expect(ok(parseToScaledInt('-123.451', 2, 'floor'))).toBe(-12346n)
  })

  it('tail of trailing zeros past scale is exact, not a precision error', () => {
    expect(ok(parseToScaledInt('123.4500', 2))).toBe(12345n)
  })
})

describe('formatScaledInt', () => {
  it('renders canonical decimal strings', () => {
    expect(formatScaledInt(12345n, 2)).toBe('123.45')
    expect(formatScaledInt(-1n, 2)).toBe('-0.01')
    expect(formatScaledInt(5n, 0)).toBe('5')
    expect(formatScaledInt(0n, 2)).toBe('0.00')
    expect(formatScaledInt(7n, 2)).toBe('0.07')
    expect(formatScaledInt(120n, 2)).toBe('1.20')
    expect(formatScaledInt(9007199254740991n, 2)).toBe('90071992547409.91')
  })

  it('round-trips with parseToScaledInt', () => {
    for (const s of ['123.45', '-0.01', '0.00', '1000000.99', '90071992547409.91']) {
      expect(formatScaledInt(ok(parseToScaledInt(s, 2)), 2)).toBe(s)
    }
  })
})
