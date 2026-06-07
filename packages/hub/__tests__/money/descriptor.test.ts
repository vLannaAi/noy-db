import { describe, it, expect } from 'vitest'
import { money, isMoneyDescriptor, MoneyCurrencyError } from '../../src/money/descriptor.js'

describe('money()', () => {
  it('fixed mode resolves scale from ISO-4217 when omitted', () => {
    const d = money({ currency: 'EUR' })
    expect(d.mode).toBe('fixed')
    expect(d.fixedCurrency).toBe('EUR')
    expect(d.scaleFor('EUR')).toBe(2)
    expect(d.soleCurrency()).toBe('EUR')
  })

  it('fixed mode honors explicit scale (unlisted currency)', () => {
    expect(money({ currency: 'XAU', scale: 4 }).scaleFor('XAU')).toBe(4)
  })

  it('fixed mode rejects a different currency', () => {
    expect(() => money({ currency: 'EUR' }).scaleFor('USD')).toThrow(MoneyCurrencyError)
  })

  it('multi mode resolves per-currency scale', () => {
    const d = money({ currencies: ['EUR', 'JPY'] })
    expect(d.mode).toBe('multi')
    expect(d.scaleFor('EUR')).toBe(2)
    expect(d.scaleFor('JPY')).toBe(0)
    expect(d.allows('EUR')).toBe(true)
    expect(d.allows('USD')).toBe(false)
  })

  it("multi 'any' allows any code with a known scale", () => {
    const d = money({ currencies: 'any' })
    expect(d.allows('USD')).toBe(true)
    expect(d.scaleFor('BHD')).toBe(3)
    expect(d.soleCurrency()).toBeUndefined()
  })

  it('multi scaleOverrides win', () => {
    expect(money({ currencies: 'any', scaleOverrides: { FOO: 5 } }).scaleFor('FOO')).toBe(5)
  })

  it('multi single-element allow-list has a sole currency', () => {
    expect(money({ currencies: ['EUR'] }).soleCurrency()).toBe('EUR')
  })

  it('multi rejects a disallowed currency', () => {
    expect(() => money({ currencies: ['EUR'] }).scaleFor('USD')).toThrow(MoneyCurrencyError)
  })

  it('unknown currency without scale throws at construction', () => {
    expect(() => money({ currency: 'ZZZ' })).toThrow(MoneyCurrencyError)
  })

  it('multi allow-list with an unresolvable code throws at construction', () => {
    expect(() => money({ currencies: ['EUR', 'ZZZ'] })).toThrow(MoneyCurrencyError)
  })

  it('currency + currencies together throws', () => {
    // @ts-expect-error mutually exclusive
    expect(() => money({ currency: 'EUR', currencies: 'any' })).toThrow()
  })

  it('isMoneyDescriptor predicate', () => {
    expect(isMoneyDescriptor(money({ currency: 'EUR' }))).toBe(true)
    expect(isMoneyDescriptor({})).toBe(false)
    expect(isMoneyDescriptor(null)).toBe(false)
  })
})
