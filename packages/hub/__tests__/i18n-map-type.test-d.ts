/**
 * I18nMap<Langs, Required> — type-level tests (vitest --typecheck).
 *
 * Infers the stored locale-map shape from the `required` mode so that
 * accessing an absent-optional locale is a compile error
 * (`string | undefined`) rather than a silent `undefined`.
 *
 * Run: `pnpm exec vitest --run --typecheck.enabled --typecheck.only`
 */
import { describe, it, expectTypeOf } from 'vitest'
import type { I18nMap } from '../src/i18n/core.js'

type Lang = 'th' | 'en' | 'ja'

describe('I18nMap', () => {
  it('all (default) → every locale required', () => {
    expectTypeOf<I18nMap<Lang>>().toEqualTypeOf<{ th: string; en: string; ja: string }>()
    expectTypeOf<I18nMap<Lang, 'all'>>().toEqualTypeOf<{ th: string; en: string; ja: string }>()
    expectTypeOf<I18nMap<Lang>['th']>().toEqualTypeOf<string>()
  })

  it('any → every locale optional (bare access is string | undefined)', () => {
    expectTypeOf<I18nMap<Lang, 'any'>>().toEqualTypeOf<{ th?: string; en?: string; ja?: string }>()
    expectTypeOf<I18nMap<Lang, 'any'>['th']>().toEqualTypeOf<string | undefined>()
  })

  it('string[] → listed locales required, the rest optional', () => {
    expectTypeOf<I18nMap<Lang, ['th']>>().toEqualTypeOf<{ th: string; en?: string; ja?: string }>()
    expectTypeOf<I18nMap<Lang, ['th', 'en']>>().toEqualTypeOf<{ th: string; en: string; ja?: string }>()
    expectTypeOf<I18nMap<Lang, ['th']>['th']>().toEqualTypeOf<string>()
    expectTypeOf<I18nMap<Lang, ['th']>['en']>().toEqualTypeOf<string | undefined>()
  })
})
