import { describe, it, expect } from 'vitest'
import { normalizeField, validateFieldSchema, getPath } from '../src/normalize.js'

describe('normalizeField', () => {
  it('trim / lower / upper', () => {
    expect(normalizeField('  Hi ', 'trim')).toBe('Hi')
    expect(normalizeField(' Hi ', 'lower')).toBe('hi')
    expect(normalizeField(' Hi ', 'upper')).toBe('HI')
  })
  it('alnum-upper strips punctuation and uppercases', () => {
    expect(normalizeField('gb-12 34.56', 'alnum-upper')).toBe('GB123456')
  })
  it('digits keeps only digits', () => {
    expect(normalizeField('+1 (415) 555', 'digits')).toBe('1415555')
  })
  it('cents converts money to integer-cents string', () => {
    expect(normalizeField(1234.5, 'cents')).toBe('123450')
    expect(normalizeField('19.99', 'cents')).toBe('1999')
    expect(normalizeField(0, 'cents')).toBe('0')
  })
  it('cents throws on non-numeric', () => {
    expect(() => normalizeField('abc', 'cents')).toThrow(/cents/)
  })
  it('iso-date normalizes Date and ISO string to YYYY-MM-DD', () => {
    expect(normalizeField('2026-05-29T10:00:00Z', 'iso-date')).toBe('2026-05-29')
    expect(normalizeField(new Date('2026-05-29T23:59:59Z'), 'iso-date')).toBe('2026-05-29')
  })
  it('iso-date throws on unparseable', () => {
    expect(() => normalizeField('not-a-date', 'iso-date')).toThrow(/iso-date/)
  })
})

describe('validateFieldSchema', () => {
  it('accepts a valid schema', () => {
    expect(() => validateFieldSchema({ fields: [{ path: 'total', normalize: 'cents' }] })).not.toThrow()
  })
  it('rejects an unknown normalizer', () => {
    // @ts-expect-error testing runtime guard
    expect(() => validateFieldSchema({ fields: [{ path: 'x', normalize: 'bogus' }] })).toThrow(/normalizer/)
  })
  it('rejects empty fields and duplicate paths', () => {
    expect(() => validateFieldSchema({ fields: [] })).toThrow(/at least one/)
    expect(() => validateFieldSchema({ fields: [{ path: 'a', normalize: 'trim' }, { path: 'a', normalize: 'upper' }] })).toThrow(/duplicate/)
  })
})

describe('getPath', () => {
  it('resolves dot paths', () => {
    expect(getPath({ a: { b: 7 } }, 'a.b')).toBe(7)
    expect(getPath({ total: 5 }, 'total')).toBe(5)
  })
  it('returns undefined for a missing path', () => {
    expect(getPath({ a: {} }, 'a.b.c')).toBeUndefined()
  })
})
