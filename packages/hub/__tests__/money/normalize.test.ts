import { describe, it, expect } from 'vitest'
import { quantizeMoneyFields, decodeMoneyFields } from '../../src/money/normalize.js'
import { money, MoneyPrecisionError } from '../../src/money/descriptor.js'

const fields = {
  fixed: { total: money({ currency: 'EUR', scale: 2 }) },
  rounded: { total: money({ currency: 'EUR', scale: 2, rounding: 'half-up' }) },
  multi: { total: money({ currencies: ['EUR', 'USD', 'JPY'] }) },
  multiSole: { total: money({ currencies: ['EUR'] }) },
}

describe('quantizeMoneyFields (write)', () => {
  it('fixed: decimal → scaled-integer digit string', () => {
    expect(quantizeMoneyFields({ total: 123.45 }, fields.fixed)).toEqual({ total: '12345' })
    expect(quantizeMoneyFields({ total: '123.45' }, fields.fixed)).toEqual({ total: '12345' })
    expect(quantizeMoneyFields({ total: '-0.01' }, fields.fixed)).toEqual({ total: '-1' })
  })

  it('multi: stores { amount, currency } with per-currency scale', () => {
    expect(quantizeMoneyFields({ total: { amount: '123.45', currency: 'EUR' } }, fields.multi))
      .toEqual({ total: { amount: '12345', currency: 'EUR' } })
    // JPY scale 0
    expect(quantizeMoneyFields({ total: { amount: '500', currency: 'JPY' } }, fields.multi))
      .toEqual({ total: { amount: '500', currency: 'JPY' } })
  })

  it('multi single-currency allow-list accepts a bare amount', () => {
    expect(quantizeMoneyFields({ total: 123.45 }, fields.multiSole))
      .toEqual({ total: { amount: '12345', currency: 'EUR' } })
  })

  it('multi with >1 currency rejects a bare amount', () => {
    expect(() => quantizeMoneyFields({ total: 123.45 }, fields.multi)).toThrow(/multi-currency/)
  })

  it('null / undefined pass through untouched', () => {
    expect(quantizeMoneyFields({ total: null }, fields.fixed)).toEqual({ total: null })
    expect(quantizeMoneyFields({ other: 1 }, fields.fixed)).toEqual({ other: 1 })
  })

  it('excess precision throws MoneyPrecisionError without rounding', () => {
    expect(() => quantizeMoneyFields({ total: '123.456' }, fields.fixed)).toThrow(MoneyPrecisionError)
  })

  it('rounding mode quantizes excess precision', () => {
    expect(quantizeMoneyFields({ total: '123.456' }, fields.rounded)).toEqual({ total: '12346' })
  })

  it('float artifact past scale precision-rejects (string is the exact write path)', () => {
    // 0.1 + 0.2 === 0.30000000000000004 → 17 frac digits, scale 2, no rounding
    expect(() => quantizeMoneyFields({ total: 0.1 + 0.2 }, fields.fixed)).toThrow(MoneyPrecisionError)
    // the exact path:
    expect(quantizeMoneyFields({ total: '0.30' }, fields.fixed)).toEqual({ total: '30' })
  })

  it('does not mutate the input record', () => {
    const input = { total: 123.45 }
    quantizeMoneyFields(input, fields.fixed)
    expect(input).toEqual({ total: 123.45 })
  })
})

describe('decodeMoneyFields (read)', () => {
  it('fixed: scaled-integer string → exact decimal + virtuals', () => {
    const out = decodeMoneyFields({ total: '12345' }, fields.fixed, 'de-DE') as Record<string, unknown>
    expect(out.total).toBe('123.45')
    expect(String(out.totalFormatted)).toContain('123,45')
    expect(out.totalNumber).toBe(123.45)
  })

  it('multi: { amount, currency } decodes with the record currency', () => {
    const out = decodeMoneyFields(
      { total: { amount: '12345', currency: 'USD' } },
      fields.multi,
      'en-US',
    ) as Record<string, unknown>
    expect(out.total).toEqual({ amount: '123.45', currency: 'USD' })
    expect(String(out.totalFormatted)).toContain('123.45')
    expect(out.totalNumber).toBe(123.45)
  })

  it("locale 'raw' decodes the primary but skips Intl virtuals", () => {
    const out = decodeMoneyFields({ total: '12345' }, fields.fixed, 'raw') as Record<string, unknown>
    expect(out.total).toBe('123.45')
    expect(out.totalFormatted).toBeUndefined()
    expect(out.totalNumber).toBeUndefined()
  })

  it('exact past 2^53: primary string stays exact, Formatted full-precision, Number is the lossy convenience', () => {
    const out = decodeMoneyFields({ total: '9007199254740991' }, fields.fixed, 'de-DE') as Record<string, unknown>
    expect(out.total).toBe('90071992547409.91') // exact
    expect(String(out.totalFormatted)).toContain('90.071.992.547.409,91') // exact, grouped
    expect(typeof out.totalNumber).toBe('number') // defined, documented-lossy
  })

  it('round-trips: write then read returns the original decimal', () => {
    const stored = quantizeMoneyFields({ total: '1000000.99' }, fields.fixed)
    const read = decodeMoneyFields(stored, fields.fixed, 'raw') as Record<string, unknown>
    expect(read.total).toBe('1000000.99')
  })
})
