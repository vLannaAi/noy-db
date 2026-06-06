/**
 * `useI18nField` — a reactive `pickLang` for a single i18nText map.
 *
 * Resolves a `{ [locale]: string }` map to the active locale, recomputing
 * when the locale (or a reactive source) changes. Uses hub's
 * `resolveI18nText` with `policy: 'null'`, so it never throws and never
 * yields `undefined` — `null` when no locale (and no fallback) resolves.
 *
 * Follows the global `useNoydbI18n` locale/fallback unless overridden.
 * Ideal for resolving one field at the edge while siblings stay raw
 * (e.g. a bilingual section reading raw maps).
 *
 * @public
 */
import { computed, unref, type Ref } from 'vue'
import { resolveI18nText } from '@noy-db/hub/i18n'
import { useNoydbI18n } from './useNoydbI18n.js'

type MapSource =
  | Record<string, string>
  | (() => Record<string, string> | undefined | null)

export interface UseI18nFieldOptions {
  /** Override the active locale (string or ref). Defaults to the global. */
  readonly locale?: string | Ref<string>
  /** Override the fallback chain. Defaults to the global. */
  readonly fallback?: string | readonly string[]
}

export function useI18nField(
  source: MapSource,
  opts: UseI18nFieldOptions = {},
): Ref<string | null> {
  const i18n = useNoydbI18n()
  return computed<string | null>(() => {
    const map = typeof source === 'function' ? source() : source
    if (!map || typeof map !== 'object') return null
    const locale = opts.locale !== undefined ? unref(opts.locale) : i18n.locale
    const fallback = opts.fallback ?? i18n.fallback
    const out = resolveI18nText(
      map as Record<string, string>,
      locale,
      fallback,
      undefined,
      { policy: 'null' },
    )
    // With a concrete locale (never 'raw'), the result is string | null.
    return typeof out === 'string' ? out : null
  })
}
