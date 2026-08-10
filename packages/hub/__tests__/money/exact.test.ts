/**
 * #1007 — exact decimal arithmetic handed to an MV `derive`.
 *
 * The whole point is that no operation may route through binary floating
 * point, so the cases here are the ones a float gets wrong.
 */
import { describe, it, expect } from 'vitest'
import { exactMath as exact } from '../../src/via/money/exact.js'
import { ValidationError } from '../../src/kernel/errors.js'

describe('exactMath', () => {
  it('subtracts without float drift', () => {
    // The canonical float failure: 10.05 - 0.10 === 9.950000000000001
    expect(exact.sub('10.05', '0.10')).toBe('9.95')
    expect(Number('10.05') - Number('0.10')).not.toBe(9.95)
  })

  it('adds without float drift', () => {
    expect(exact.add('0.1', '0.2')).toBe('0.3')
    expect(Number('0.1') + Number('0.2')).not.toBe(0.3)
  })

  it('aligns operands of different scale, keeping the wider one', () => {
    expect(exact.add('1.5', '2.25')).toBe('3.75')
    expect(exact.sub('1', '0.001')).toBe('0.999')
  })

  it('handles negatives and crossing zero', () => {
    expect(exact.sub('0.10', '10.05')).toBe('-9.95')
    expect(exact.neg('9.95')).toBe('-9.95')
    expect(exact.neg('-9.95')).toBe('9.95')
    expect(exact.add('-1.50', '1.50')).toBe('0.00')
  })

  it('max / min clamp exactly — the overpayment case', () => {
    expect(exact.max(0, exact.sub('100.00', '250.00'))).toBe('0.00')
    expect(exact.max(0, exact.sub('250.00', '100.00'))).toBe('150.00')
    expect(exact.min('1.005', '1.0050')).toBe('1.0050')
  })

  it('compares across differing scales', () => {
    expect(exact.cmp('1.50', '1.5')).toBe(0)
    expect(exact.cmp('1.50', '1.51')).toBe(-1)
    expect(exact.cmp('2', '1.99')).toBe(1)
  })

  it('accepts bigint whole units and plain numbers', () => {
    expect(exact.add(10n, '0.05')).toBe('10.05')
    expect(exact.sub(10, 0.5)).toBe('9.5')
  })

  it('stays exact well past the float-safe integer range', () => {
    // 2^53 + 1 — a double cannot represent this at all.
    expect(exact.add('9007199254740993', '1')).toBe('9007199254740994')
  })

  it('rejects a non-decimal operand instead of coercing it to NaN', () => {
    expect(() => exact.add('abc', '1')).toThrow(ValidationError)
    expect(() => exact.sub('1', '')).toThrow(ValidationError)
    expect(() => exact.add('1.2.3', '1')).toThrow(ValidationError)
  })
})
