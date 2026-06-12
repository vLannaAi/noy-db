import { describe, it, expect } from 'vitest'
import { asMoney, isMoneyString, moneyNumber, MoneyUnsupportedError } from '../../src/index.js'
import type { MoneyString } from '../../src/index.js'

// #338 — branded money output type. The brand is type-level only;
// these tests cover the runtime guards/accessors and pin the
// input/output asymmetry contract at the type level.

describe('asMoney / isMoneyString / moneyNumber (#338)', () => {
  it('asMoney brands canonical decimal strings (runtime identity)', () => {
    const m = asMoney('10000.00')
    expect(m).toBe('10000.00')
    expect(asMoney(123.45)).toBe('123.45')
    expect(asMoney(' 99.90 ')).toBe('99.90') // trims, like the write path
  })

  it('asMoney throws loudly on non-decimals', () => {
    expect(() => asMoney('banana')).toThrow(MoneyUnsupportedError)
    expect(() => asMoney(Infinity)).toThrow(MoneyUnsupportedError)
    expect(() => asMoney(NaN)).toThrow(MoneyUnsupportedError)
    expect(() => asMoney('10,000.00')).toThrow(MoneyUnsupportedError) // locale strings are display-only
  })

  it('isMoneyString narrows decimal strings only', () => {
    expect(isMoneyString('10000.00')).toBe(true)
    expect(isMoneyString('-0.01')).toBe(true)
    expect(isMoneyString('1e-7')).toBe(true) // exponent form is a valid decimal
    expect(isMoneyString(10000)).toBe(false) // numbers are input-side, not the decoded shape
    expect(isMoneyString('THB 100')).toBe(false)
    expect(isMoneyString(null)).toBe(false)
  })

  it('moneyNumber is the explicit lossy escape hatch', () => {
    expect(moneyNumber(asMoney('123.45'))).toBe(123.45)
    expect(moneyNumber('99.90')).toBe(99.9)
    expect(() => moneyNumber('banana')).toThrow(MoneyUnsupportedError)
  })

  it('type-level: MoneyString assigns to string, but not the reverse', () => {
    const branded: MoneyString = asMoney('1.00')
    const plain: string = branded // widening is fine
    expect(plain).toBe('1.00')
    // @ts-expect-error — a bare string is NOT a MoneyString without the guard
    const bad: MoneyString = '1.00'
    void bad
  })
})
