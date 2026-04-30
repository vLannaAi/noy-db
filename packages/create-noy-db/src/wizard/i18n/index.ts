/**
 * i18n entrypoint for the `@noy-db/create` wizard.
 *
 * Three responsibilities:
 *
 *   1. Re-export `Locale` and `WizardMessages` so callers don't
 *      need to know about the bundle layout.
 *   2. `detectLocale(env)` — pure function that maps Unix-style
 *      `LC_ALL` / `LANG` / `LANGUAGE` env vars to a supported
 *      `Locale`. Returns `'en'` for anything we don't recognise.
 *   3. `loadMessages(locale)` — synchronous lookup that returns
 *      the message bundle for a locale. Synchronous (not dynamic
 *      `import()`) on purpose: bundles are tiny (< 2 KB each), the
 *      wizard reads them on every prompt, and async would force
 *      every caller to be async. tsup tree-shakes unused locales
 *      out of the bin only if we use top-level `import`s.
 *
 * ## Why env-var detection instead of `Intl.DateTimeFormat().resolvedOptions().locale`
 *
 * The Intl approach reads the JS engine's *display* locale, which
 * on most CI runners and Docker images is `en-US` regardless of
 * the user's actual setup. The Unix env vars (`LC_ALL`, `LANG`)
 * are how shells, terminals, and CLI tools have negotiated locale
 * for 30+ years — that's what a Thai-speaking dev's terminal will
 * actually have set. Following that convention also means power
 * users can override per-invocation with `LANG=th_TH.UTF-8 npm
 * create @noy-db`, no flag required.
 */

import { en } from './en.js'
import { th } from './th.js'
import type { Locale, WizardMessages } from './types.js'

export type { Locale, WizardMessages } from './types.js'

const BUNDLES: Record<Locale, WizardMessages> = { en, th }

/** Every locale we ship a bundle for. Used by tests and `--lang` validation. */
export const SUPPORTED_LOCALES: readonly Locale[] = ['en', 'th'] as const

/**
 * Resolve a locale code to its message bundle. Falls back to `en`
 * if the requested locale isn't shipped — defensive, since
 * `Locale` is a union type and TS already prevents this at compile
 * time, but `--lang` parsing comes from user input at runtime.
 */
export function loadMessages(locale: Locale): WizardMessages {
  return BUNDLES[locale] ?? BUNDLES.en
}

/**
 * Auto-detect a locale from POSIX env vars. Returns `'en'` when
 * nothing is set or when the value doesn't match a supported
 * locale — never throws.
 *
 * Inspection order matches the POSIX spec:
 *   1. `LC_ALL` (overrides everything)
 *   2. `LC_MESSAGES` (the category we actually care about)
 *   3. `LANG` (system default)
 *   4. `LANGUAGE` (GNU extension, comma-separated preference list)
 *
 * The first non-empty value wins. We then strip the encoding
 * suffix (`th_TH.UTF-8` → `th_TH`) and the region (`th_TH` → `th`)
 * before matching against `SUPPORTED_LOCALES`.
 */
export function detectLocale(env: NodeJS.ProcessEnv = process.env): Locale {
  const candidates = [
    env.LC_ALL,
    env.LC_MESSAGES,
    env.LANG,
    // LANGUAGE is a comma-separated preference list — take the first
    // entry. We deliberately do NOT walk the whole list; the wizard
    // ships exactly two locales, so a "best fit" walk would be
    // overkill and would obscure unexpected behaviour.
    env.LANGUAGE?.split(':')[0]?.split(',')[0],
  ]

  for (const raw of candidates) {
    if (!raw) continue
    const normalised = raw
      .split('.')[0]! // strip encoding: th_TH.UTF-8 → th_TH
      .split('@')[0]! // strip modifier: en_US@euro → en_US
      .toLowerCase()
      .split('_')[0]! // strip region: th_th → th

    if ((SUPPORTED_LOCALES as readonly string[]).includes(normalised)) {
      return normalised as Locale
    }
  }

  return 'en'
}

/**
 * Parse a `--lang` CLI argument into a `Locale`. Throws a clear
 * error for unsupported values — the caller (parse-args) catches
 * and reformats into a usage message.
 */
export function parseLocaleFlag(value: string): Locale {
  const normalised = value.toLowerCase().trim()
  if ((SUPPORTED_LOCALES as readonly string[]).includes(normalised)) {
    return normalised as Locale
  }
  throw new Error(
    `Unsupported --lang value: "${value}". Supported: ${SUPPORTED_LOCALES.join(', ')}`,
  )
}
