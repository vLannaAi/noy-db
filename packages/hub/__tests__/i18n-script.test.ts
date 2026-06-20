/**
 * Per-locale script enforcement (#283).
 *
 * - inferScripts: asymmetric Latin tolerance (non-Latin locales include Latin)
 * - Common (digits/punct) + Inherited + Mark always in baseline
 * - onScriptViolation: reject (default) / filter / warn
 */
import { describe, it, expect } from 'vitest'
import { i18nText } from '../src/i18n/core.js'
import { inferScripts, enforceScript } from '../src/i18n/script.js'
import { ScriptViolationError } from '../src/errors.js'

describe('inferScripts — asymmetric Latin (#283)', () => {
  it('Latin locales stay Latin-only', () => {
    expect(inferScripts('en')).toEqual(['Latin'])
    expect(inferScripts('fr')).toEqual(['Latin'])
  })
  it('non-Latin locales include Latin', () => {
    expect(inferScripts('th')).toEqual(['Thai', 'Latin'])
    expect(inferScripts('ja')).toEqual(['Han', 'Hiragana', 'Katakana', 'Latin'])
    expect(inferScripts('ko')).toEqual(['Hangul', 'Han', 'Latin'])
    expect(inferScripts('ar')).toEqual(['Arabic', 'Latin'])
    expect(inferScripts('ru')).toEqual(['Cyrillic', 'Latin'])
  })
  it('script subtag wins', () => {
    expect(inferScripts('th-Latn')).toEqual(['Latin'])
    expect(inferScripts('ja-Latn')).toEqual(['Latin'])
  })
})

describe('enforceScript — reject (default)', () => {
  const desc = i18nText({ languages: ['th', 'en'], required: 'any', script: 'auto' })

  it('Thai address with embedded Latin passes (#283 driving case)', () => {
    expect(() =>
      enforceScript({ th: '9/9 อาคาร TCM ถนนรัชดาภิเษก' }, 'address', desc),
    ).not.toThrow()
  })
  it('Latin digits pass in a Thai slot (Common)', () => {
    expect(() => enforceScript({ th: 'สมชาย 2024' }, 'firstName', desc)).not.toThrow()
  })
  it('Thai tone marks pass (combining marks)', () => {
    // น้ำ contains a Thai tone mark (combining) — must not false-reject
    expect(() => enforceScript({ th: 'น้ำดื่ม' }, 'product', desc)).not.toThrow()
  })
  it('Thai text in the en slot is rejected (the real error)', () => {
    expect(() => enforceScript({ en: 'สมชาย' }, 'firstName', desc)).toThrow(ScriptViolationError)
  })
  it('explicit tightening forbids embedded Latin in Thai', () => {
    const strict = i18nText({ languages: ['th'], required: 'any', script: { th: ['Thai'] } })
    expect(() => enforceScript({ th: 'อาคาร TCM' }, 'pureThai', strict)).toThrow(ScriptViolationError)
  })
  it('no script option ⇒ no check', () => {
    const plain = i18nText({ languages: ['th', 'en'], required: 'any' })
    expect(() => enforceScript({ en: 'สมชาย' }, 'firstName', plain)).not.toThrow()
  })
})

describe('enforceScript — filter / warn', () => {
  it("filter strips disallowed characters", () => {
    const desc = i18nText({
      languages: ['en'], required: 'any', script: 'auto', onScriptViolation: 'filter',
    })
    const { value, warnings } = enforceScript({ en: 'John สมชาย' }, 'name', desc)
    expect(value.en.trim()).toBe('John')
    expect(warnings).toHaveLength(1)
  })
  it("warn keeps the value and records a warning", () => {
    const desc = i18nText({
      languages: ['en'], required: 'any', script: 'auto', onScriptViolation: 'warn',
    })
    const { value, warnings } = enforceScript({ en: 'John สมชาย' }, 'name', desc)
    expect(value.en).toBe('John สมชาย')
    expect(warnings[0]?.locale).toBe('en')
  })
})

describe('enforceScript exempt set (#435)', () => {
  const d = i18nText({ languages: ['th', 'en'], required: 'any', script: 'auto' })

  it('throws on Thai in the en slot without exempt', () => {
    expect(() => enforceScript({ th: 'สมชาย', en: 'สมชาย' }, 'name', d)).toThrow()
  })

  it('skips an exempt locale (a known fill)', () => {
    expect(() => enforceScript({ th: 'สมชาย', en: 'สมชาย' }, 'name', d, new Set(['en']))).not.toThrow()
  })
})
