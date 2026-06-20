/** #435 F1 — densifyOnWrite. */
import { describe, it, expect } from 'vitest'
import { i18nText } from '../src/i18n/core.js'
import { computeExemptFills, densify } from '../src/i18n/densify.js'

describe('densifyOnWrite config validation', () => {
  it('rejects densifyOnWrite + explicit scalar throw policy', () => {
    expect(() =>
      i18nText({ languages: ['th', 'en'], required: 'any', densifyOnWrite: true, onMissing: 'throw' }),
    ).toThrow(/densifyOnWrite/)
  })

  it('rejects densifyOnWrite + explicit per-layer throw policy', () => {
    expect(() =>
      i18nText({ languages: ['th', 'en'], required: 'any', densifyOnWrite: true, onMissing: { mv: 'throw' } }),
    ).toThrow(/densifyOnWrite/)
  })

  it('allows densifyOnWrite with no explicit onMissing (default throw is fine)', () => {
    expect(() =>
      i18nText({ languages: ['th', 'en'], required: 'any', densifyOnWrite: true }),
    ).not.toThrow()
  })

  it('allows densifyOnWrite with an explicit non-throw policy', () => {
    expect(() =>
      i18nText({ languages: ['th', 'en'], required: 'any', densifyOnWrite: true, onMissing: 'substitute' }),
    ).not.toThrow()
  })
})

describe('densify (pure)', () => {
  const fields = {
    name: i18nText({ languages: ['th', 'en'], required: 'any', substitute: ['en', 'th'], densifyOnWrite: true }),
  }

  it('fills empty slots and records provenance (insert)', () => {
    const rec: any = { id: 'c1', name: { th: 'สมชาย' } }
    densify(rec, undefined, fields)
    expect(rec.name).toEqual({ th: 'สมชาย', en: 'สมชาย' })
    expect(rec._i18nFilled).toEqual({ name: ['en'] })
  })

  it('refreshes an unchanged round-tripped fill when the source changed', () => {
    const prior: any = { name: { th: 'สมชาย', en: 'สมชาย' }, _i18nFilled: { name: ['en'] } }
    const rec: any = { id: 'c1', name: { th: 'สมชัย', en: 'สมชาย' } } // th corrected, en still old fill
    densify(rec, prior, fields)
    expect(rec.name.en).toBe('สมชัย')
    expect(rec._i18nFilled).toEqual({ name: ['en'] })
  })

  it('clears the marker when a slot becomes authored (no clobber)', () => {
    const prior: any = { name: { th: 'สมชาย', en: 'สมชาย' }, _i18nFilled: { name: ['en'] } }
    const rec: any = { id: 'c1', name: { th: 'สมชาย', en: 'Somchai' } } // real en authored
    densify(rec, prior, fields)
    expect(rec.name.en).toBe('Somchai')
    expect(rec._i18nFilled).toBeUndefined()
  })

  it('computeExemptFills exempts unchanged fills, not changed slots', () => {
    const prior: any = { name: { th: 'สมชาย', en: 'สมชาย' }, _i18nFilled: { name: ['en'] } }
    expect(computeExemptFills(prior, { name: { th: 'สมชัย', en: 'สมชาย' } }, fields).get('name')).toEqual(new Set(['en']))
    expect(computeExemptFills(prior, { name: { th: 'สมชาย', en: 'Somchai' } }, fields).get('name')).toBeUndefined()
    expect(computeExemptFills(undefined, { name: { th: 'สมชาย' } }, fields).size).toBe(0)
  })

  it('fills nothing when there is no source value', () => {
    const rec: any = { id: 'c1' } // name absent
    densify(rec, undefined, fields)
    expect(rec._i18nFilled).toBeUndefined()
  })
})
