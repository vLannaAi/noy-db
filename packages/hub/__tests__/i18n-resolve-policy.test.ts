/**
 * Policy-aware resolveI18nText — the resolution decision table.
 *
 * - caller `fallback` ALWAYS applies first (backward compat + read override)
 * - declared `substitute` applies ONLY under policy 'substitute'
 * - exhaustion: 'throw' → throw; 'null'/'substitute' → null
 * - locale:'raw' → return the map; legacy 4-arg form unchanged
 */
import { describe, it, expect } from 'vitest'
import { resolveI18nText } from '../src/with-shape/i18n/core.js'

const v = { th: 'สมชาย' }

describe('resolveI18nText — policy semantics', () => {
  it('returns the present locale', () => {
    expect(resolveI18nText({ en: 'A', th: 'B' }, 'en')).toBe('A')
  })

  it('legacy 4-arg form throws on miss (backward compat, default policy throw)', () => {
    expect(() => resolveI18nText(v, 'en')).toThrow(/locale/i)
  })

  it('caller fallback always wins, even with default (throw) policy', () => {
    expect(resolveI18nText(v, 'en', ['th'])).toBe('สมชาย')
    expect(resolveI18nText(v, 'en', 'th')).toBe('สมชาย')
  })

  it("declared substitute applies under policy 'substitute'", () => {
    expect(
      resolveI18nText(v, 'en', undefined, 'firstName', {
        policy: 'substitute',
        substitute: ['th', 'any'],
      }),
    ).toBe('สมชาย')
  })

  it("policy 'null' returns null and ignores declared substitute", () => {
    expect(
      resolveI18nText(v, 'en', undefined, 'firstName', {
        policy: 'null',
        substitute: ['th'],
      }),
    ).toBeNull()
  })

  it("policy 'null' still honors an explicit caller fallback", () => {
    expect(
      resolveI18nText(v, 'en', ['th'], 'firstName', { policy: 'null' }),
    ).toBe('สมชาย')
  })

  it("policy 'substitute' exhausted → null (not throw)", () => {
    expect(
      resolveI18nText({}, 'en', undefined, 'f', {
        policy: 'substitute',
        substitute: ['th', 'any'],
      }),
    ).toBeNull()
  })

  it("declared substitute is ignored under policy 'throw' (strict)", () => {
    expect(() =>
      resolveI18nText(v, 'en', undefined, 'f', {
        policy: 'throw',
        substitute: ['th'],
      }),
    ).toThrow(/locale/i)
  })

  it("'any' in a chain picks the first non-empty value", () => {
    expect(
      resolveI18nText({ ja: 'X' }, 'en', undefined, 'f', {
        policy: 'substitute',
        substitute: ['any'],
      }),
    ).toBe('X')
  })

  it('raw passthrough returns the full map', () => {
    expect(resolveI18nText(v, 'raw')).toEqual(v)
  })
})
