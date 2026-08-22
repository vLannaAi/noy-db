import { describe, it, expect, vi } from 'vitest'
import { i18nVia } from '../../src/via/i18n/binding.js'
import { i18nText } from '../../src/via/i18n/core.js'
import { dictKey } from '../../src/via/i18n/dictionary.js'
import type { I18nStrategy } from '../../src/port/with/i18n-strategy.js'

/** Minimal stub strategy — a locale map collapses to its requested slot; every other hook is a no-op. */
function stubStrategy(): I18nStrategy {
  return {
    applyI18nLocale(record, fields, locale) {
      const out = { ...record }
      for (const field of Object.keys(fields)) {
        const map = record[field]
        if (map && typeof map === 'object') out[field] = (map as Record<string, string>)[locale]
      }
      return out
    },
    validateI18nTextValue() {},
    enforceScript(value) { return { value, warnings: [] } },
    computeExemptFills() { return new Map() },
    densify() {},
    buildDictionaryHandle() { throw new Error('not used in this test') },
  }
}

describe('i18nVia (#623 Task 7)', () => {
  it('declares the i18n brand + posture', () => {
    const b = i18nVia({ strategy: stubStrategy(), collectionName: 'items' })
    expect(b.brand).toBe('i18n')
    expect(b.posture).toEqual({
      encryptedAtRest: 'envelope',
      queryable: 'full',
      exportable: true,
      forgettable: true,
    })
  })

  it('present resolves an i18nText locale map, injects a dictKey <field>Label, and strips _i18nFilled', async () => {
    const i18nFields = { title: i18nText({ languages: ['en', 'th'], required: 'all' }) }
    const dictKeyFields = { status: dictKey('status', ['draft', 'paid'] as const) }
    const dictLabelResolver = vi.fn(async (...args: unknown[]) => `${args[1] as string}-${args[2] as string}`)

    const b = i18nVia({
      i18nFields,
      dictKeyFields,
      strategy: stubStrategy(),
      dictLabelResolver,
      collectionName: 'items',
    })

    const record = {
      title: { en: 'Hello', th: 'สวัสดี' },
      status: 'paid',
      _i18nFilled: { title: ['th'] },
    }
    const presented = await b.present!(record, { locale: 'en', layer: 'read' })

    expect(presented.title).toBe('Hello')
    expect(presented.statusLabel).toBe('paid-en')
    expect(presented._i18nFilled).toBeUndefined()
    expect(dictLabelResolver).toHaveBeenCalledWith('status', 'paid', 'en', undefined)
  })

  it('encodeWrite invokes the i18nPutValidator closure', async () => {
    const i18nFields = { title: i18nText({ languages: ['en', 'th'], required: 'all' }) }
    const i18nPutValidator = vi.fn()
    const b = i18nVia({
      i18nFields,
      strategy: stubStrategy(),
      i18nPutValidator,
      collectionName: 'items',
    })

    const record = { title: { en: 'Hello', th: 'สวัสดี' } }
    const out = await b.encodeWrite!(record, { id: 'x', vault: 'test-vault', prior: async () => null, emit: () => {} })

    expect(i18nPutValidator).toHaveBeenCalledWith(out)
  })
})
