/** #435 F1 — densifyOnWrite. */
import { describe, it, expect } from 'vitest'
import { i18nText } from '../src/i18n/core.js'

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
