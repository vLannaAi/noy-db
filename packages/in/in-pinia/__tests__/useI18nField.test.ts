/**
 * useI18nField — reactive pickLang over an i18nText map.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { ref } from 'vue'
import { useNoydbI18n } from '../src/useNoydbI18n.js'
import { useI18nField } from '../src/useI18nField.js'

beforeEach(() => setActivePinia(createPinia()))

describe('useI18nField', () => {
  it('resolves to the global locale and recomputes on flip', () => {
    const i = useNoydbI18n()
    const name = useI18nField({ th: 'สมชาย', en: 'Somchai' })
    expect(name.value).toBe('Somchai') // default en
    i.setLocale('th')
    expect(name.value).toBe('สมชาย')
  })

  it('uses the default fallback chain (en,any) to fill a missing locale', () => {
    useNoydbI18n() // en active
    const name = useI18nField({ th: 'สมชาย' }) // no en → fallback en,any → th
    expect(name.value).toBe('สมชาย')
  })

  it('returns null when the map is empty (policy null, never throws)', () => {
    useNoydbI18n()
    const name = useI18nField({})
    expect(name.value).toBeNull()
  })

  it('per-call locale override ignores the global locale', () => {
    const i = useNoydbI18n()
    i.setLocale('en')
    const th = useI18nField({ th: 'สมชาย', en: 'Somchai' }, { locale: 'th' })
    expect(th.value).toBe('สมชาย')
  })

  it('reactive getter source recomputes', () => {
    useNoydbI18n()
    const src = ref<Record<string, string>>({ en: 'A' })
    const v = useI18nField(() => src.value)
    expect(v.value).toBe('A')
    src.value = { en: 'B' }
    expect(v.value).toBe('B')
  })
})
