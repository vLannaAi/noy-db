/**
 * Per-locale script enforcement for `i18nText` fields (write-time).
 *
 * Each locale slot's string is validated against an allowed set of
 * Unicode scripts. `'auto'` infers the set from the locale code with
 * **asymmetric Latin tolerance**: every non-Latin-script locale
 * also allows `Latin`, because proper names and addresses in those
 * locales routinely embed Latin brand/building/technical names — while
 * Latin-script locales do NOT allow other scripts, so the common error
 * (e.g. Thai text dumped into an `en` slot) is still caught.
 *
 * The always-on baseline is `Common` (digits, punctuation), `Inherited`
 * and `Mark` (combining diacritics, joiners, harakat, tone marks), and
 * whitespace — so Latin digits and in-script combining marks never
 * false-reject.
 *
 * @public
 */
import { ScriptViolationError } from '../../kernel/errors.js'
import type { I18nTextDescriptor } from './core.js'

/** Locales whose base language is written in the Latin script. */
const LATIN_BASE = new Set([
  'en', 'fr', 'de', 'es', 'it', 'pt', 'nl', 'sv', 'no', 'da', 'fi', 'is',
  'pl', 'cs', 'sk', 'hu', 'ro', 'hr', 'sl', 'et', 'lv', 'lt', 'tr', 'vi',
  'id', 'ms', 'tl', 'sw', 'af', 'ca', 'gl', 'eu', 'cy', 'ga',
])

/** Base-language → primary (non-Latin) scripts. Latin is appended by inferScripts. */
const SCRIPT_TABLE: Record<string, readonly string[]> = {
  th: ['Thai'],
  ko: ['Hangul', 'Han'],
  ja: ['Han', 'Hiragana', 'Katakana'],
  zh: ['Han'],
  ar: ['Arabic'],
  fa: ['Arabic'],
  ur: ['Arabic'],
  ru: ['Cyrillic'],
  uk: ['Cyrillic'],
  bg: ['Cyrillic'],
  sr: ['Cyrillic'],
  he: ['Hebrew'],
  el: ['Greek'],
  hi: ['Devanagari'],
  ta: ['Tamil'],
  km: ['Khmer'],
  lo: ['Lao'],
  my: ['Myanmar'],
}

/** Map a BCP-47 script subtag (e.g. `Latn`, `Cyrl`) to allowed scripts. */
const SUBTAG_SCRIPTS: Record<string, readonly string[]> = {
  Latn: ['Latin'],
  Cyrl: ['Cyrillic', 'Latin'],
  Hans: ['Han', 'Latin'],
  Hant: ['Han', 'Latin'],
  Thai: ['Thai', 'Latin'],
  Arab: ['Arabic', 'Latin'],
}

/**
 * Infer the allowed Unicode scripts for a BCP-47 locale, with asymmetric
 * Latin tolerance. A script subtag (`th-Latn`) wins over the base
 * language. Unknown locales default to `['Latin']`.
 */
export function inferScripts(locale: string): readonly string[] {
  const parts = locale.split('-')
  const subtag = parts.find((t) => /^[A-Z][a-z]{3}$/.test(t))
  if (subtag && SUBTAG_SCRIPTS[subtag]) return SUBTAG_SCRIPTS[subtag]

  const base = (parts[0] ?? '').toLowerCase()
  if (LATIN_BASE.has(base)) return ['Latin']
  const primary = SCRIPT_TABLE[base]
  if (primary) return [...primary, 'Latin'] // asymmetric Latin tolerance
  return ['Latin']
}

/** Resolve the allowed scripts for a field's locale slot. */
function allowedFor(descriptor: I18nTextDescriptor, locale: string): readonly string[] {
  const script = descriptor.options.script
  if (script && script !== 'auto') {
    const explicit = script[locale]
    if (explicit) return explicit
  }
  return inferScripts(locale)
}

/** Always-allowed baseline character classes (besides the named scripts). */
const BASELINE = String.raw`\p{White_Space}\p{Script=Common}\p{Script=Inherited}\p{Mark}`

/** Build a whole-string matcher for the allowed scripts. */
function fullMatcher(scripts: readonly string[]): RegExp {
  const cls = scripts.map((s) => `\\p{Script=${s}}`).join('')
  return new RegExp(`^[${BASELINE}${cls}]*$`, 'u')
}

/** Build a single-character matcher (for sampling / stripping). */
function charMatcher(scripts: readonly string[]): RegExp {
  const cls = scripts.map((s) => `\\p{Script=${s}}`).join('')
  return new RegExp(`[${BASELINE}${cls}]`, 'u')
}

/** Collect a short sample of characters that violate the allowed scripts. */
function offendingSample(str: string, scripts: readonly string[]): string {
  const ok = charMatcher(scripts)
  const bad: string[] = []
  for (const ch of str) {
    if (!ok.test(ch)) bad.push(ch)
    if (bad.length >= 8) break
  }
  return bad.join('')
}

/** Remove characters that violate the allowed scripts. */
function stripDisallowed(str: string, scripts: readonly string[]): string {
  const ok = charMatcher(scripts)
  let out = ''
  for (const ch of str) if (ok.test(ch)) out += ch
  return out
}

/** A non-fatal script violation recorded under `'filter'`/`'warn'` modes. */
export interface ScriptWarning {
  readonly field: string
  readonly locale: string
  readonly expected: readonly string[]
  readonly sample: string
}

/**
 * Enforce a field's script constraint over an i18nText value map.
 *
 * - No `script` option ⇒ returns the value unchanged.
 * - `onScriptViolation: 'reject'` (default) ⇒ throws {@link ScriptViolationError}.
 * - `'filter'` ⇒ returns a copy with disallowed characters stripped + warnings.
 * - `'warn'` ⇒ returns the value unchanged + warnings.
 */
export function enforceScript(
  value: Record<string, unknown>,
  field: string,
  descriptor: I18nTextDescriptor,
  exempt?: ReadonlySet<string>,
): { value: Record<string, unknown>; warnings: ScriptWarning[] } {
  const opt = descriptor.options
  if (!opt.script) return { value, warnings: [] }

  const mode = opt.onScriptViolation ?? 'reject'
  const warnings: ScriptWarning[] = []
  let out = value

  for (const [locale, raw] of Object.entries(value)) {
    if (exempt?.has(locale)) continue
    if (typeof raw !== 'string') continue
    const allowed = allowedFor(descriptor, locale)
    if (fullMatcher(allowed).test(raw)) continue

    const sample = offendingSample(raw, allowed)
    if (mode === 'reject') {
      throw new ScriptViolationError(field, locale, allowed, sample)
    }
    warnings.push({ field, locale, expected: allowed, sample })
    if (mode === 'filter') {
      if (out === value) out = { ...value }
      out[locale] = stripDisallowed(raw, allowed)
    }
  }

  return { value: out, warnings }
}
