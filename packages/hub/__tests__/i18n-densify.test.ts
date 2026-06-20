/** #435 F1 — densifyOnWrite. */
import { describe, it, expect } from 'vitest'
import { i18nText, applyI18nLocale } from '../src/i18n/core.js'
import { computeExemptFills, densify } from '../src/i18n/densify.js'
import { withI18n } from '../src/i18n/index.js'
import { NO_I18N } from '../src/i18n/strategy.js'

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

  it('drops a stale fill and clears the marker when its source disappears', () => {
    const prior: any = { name: { th: 'สมชาย', en: 'สมชาย' }, _i18nFilled: { name: ['en'] } }
    const rec: any = { id: 'c1', name: { en: 'สมชาย' } } // th removed, only the stale en fill remains
    densify(rec, prior, fields)
    expect(rec.name.en).toBeUndefined() // stale fill dropped — no authored source left
    expect(rec._i18nFilled).toBeUndefined()
  })

  it('fills multiple empty locales from one authored source in one pass', () => {
    const multi = {
      name: i18nText({ languages: ['th', 'en', 'lo'], required: 'any', substitute: ['th'], densifyOnWrite: true }),
    }
    const rec: any = { id: 'c1', name: { th: 'สมชาย' } }
    densify(rec, undefined, multi)
    expect(rec.name).toEqual({ th: 'สมชาย', en: 'สมชาย', lo: 'สมชาย' })
    expect(rec._i18nFilled.name).toEqual(expect.arrayContaining(['en', 'lo']))
    expect(rec._i18nFilled.name).toHaveLength(2)
  })

  it('treats an empty-string slot as eligible to fill', () => {
    const rec: any = { id: 'c1', name: { th: 'สมชาย', en: '' } }
    densify(rec, undefined, fields)
    expect(rec.name.en).toBe('สมชาย') // '' is empty, not authored → filled
    expect(rec._i18nFilled).toEqual({ name: ['en'] })
  })

  it('does not mutate the prior record', () => {
    const prior: any = { name: { th: 'สมชาย', en: 'สมชาย' }, _i18nFilled: { name: ['en'] } }
    const priorSnapshot = JSON.parse(JSON.stringify(prior))
    const rec: any = { id: 'c1', name: { th: 'สมชัย', en: 'สมชาย' } }
    densify(rec, prior, fields)
    expect(prior).toEqual(priorSnapshot)
  })

  it('keeps a re-authored value identical to the fill classified as a fill (value-equality limitation)', () => {
    // 'en' was filled from 'th'; the user re-types the same string for 'en'.
    // Value-equality provenance cannot tell this apart from the round-tripped fill.
    const prior: any = { name: { th: 'สมชาย', en: 'สมชาย' }, _i18nFilled: { name: ['en'] } }
    const rec: any = { id: 'c1', name: { th: 'สมชาย', en: 'สมชาย' } }
    densify(rec, prior, fields)
    expect(rec.name.en).toBe('สมชาย')
    expect(rec._i18nFilled).toEqual({ name: ['en'] }) // stays a fill (and stays script-exempt)
  })
})

describe('densify wired into the strategy', () => {
  const fields = { name: i18nText({ languages: ['th', 'en'], required: 'any', substitute: ['en', 'th'], densifyOnWrite: true }) }

  it('withI18n().densify fills slots', () => {
    const rec: any = { id: 'c1', name: { th: 'สมชาย' } }
    withI18n().densify(rec, undefined, fields)
    expect(rec.name.en).toBe('สมชาย')
  })

  it('NO_I18N densify is a no-op and computeExemptFills is empty', () => {
    const rec: any = { id: 'c1', name: { th: 'สมชาย' } }
    NO_I18N.densify(rec, undefined, fields)
    expect(rec._i18nFilled).toBeUndefined()
    expect(NO_I18N.computeExemptFills(undefined, rec, fields).size).toBe(0)
  })
})

describe('applyI18nLocale strips the _i18nFilled marker (#435)', () => {
  const fields = { name: i18nText({ languages: ['th', 'en'], required: 'any' }) }

  it('removes _i18nFilled from output without mutating the input', () => {
    const rec: any = { id: 'c1', name: { th: 'A', en: 'A' }, _i18nFilled: { name: ['en'] } }
    const out: any = applyI18nLocale(rec, fields, 'raw')
    expect('_i18nFilled' in out).toBe(false)
    expect(rec._i18nFilled).toEqual({ name: ['en'] }) // input untouched
  })
})
