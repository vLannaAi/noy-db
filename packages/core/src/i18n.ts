/**
 * i18nText schema type — v0.8 #82
 *
 * `i18nText({ languages, required })` creates a descriptor for a
 * multi-language content field whose value is stored as a
 * `{ [locale]: string }` map (e.g. `{ en: 'Consulting', th: 'ที่ปรึกษา' }`).
 *
 * On put, the descriptor validates that required languages are present.
 * On read (when a `locale` option is passed), the map is collapsed to the
 * caller's locale string via the fallback chain.
 *
 * Design decisions
 * ────────────────
 *
 * **Descriptor pattern (not a Zod type).**
 * `i18nText()` returns a plain descriptor object used in the collection's
 * `i18nFields` option — same pattern as `ref()` / `dictKey()`. This keeps
 * `@noy-db/core` at zero runtime dependencies and avoids Zod v3 field-type
 * constraints. TypeScript inference is handled via the descriptor's type.
 *
 * **Enforcement at the collection boundary.**
 * The `required` option is checked by `Collection.put()` via the compartment's
 * registered `i18nFields`. Failed validation throws `MissingTranslationError`
 * — a distinct class from `SchemaValidationError` so callers can tell
 * "wrong shape" from "missing translations".
 *
 * **Resolution is post-decryption.**
 * Locale resolution happens AFTER `decryptRecord()`, as a pure in-memory
 * transform. No additional crypto work is needed. The resolved record is
 * returned in place of the stored one, with i18nText fields replaced by
 * their locale-resolved strings.
 *
 * **`locale: 'raw'`.**
 * Passing `{ locale: 'raw' }` skips resolution and returns the full
 * `{ [locale]: string }` map — useful for bilingual exports, admin UIs,
 * and any context where all translations must be visible at once.
 *
 * **Out of scope.**
 * Pluralization, RTL rendering, date/number formatting, per-locale CRDT
 * merging — see ROADMAP.md §v0.8 and the issue #82 body for the full
 * out-of-scope statement.
 */

import { MissingTranslationError, LocaleNotSpecifiedError } from './errors.js'

// ─── i18nText descriptor ───────────────────────────────────────────────

/**
 * Options for `i18nText()`.
 *
 * `languages` declares the full set of supported locales. `required`
 * controls which must be present on every `put()`.
 *
 * `autoTranslate` is the per-field opt-in for the `plaintextTranslator`
 * hook (v0.8 #83). When `true` and a `plaintextTranslator` is configured
 * on `createNoydb()`, missing translations are generated before `put()`.
 * Default: `false`.
 */
export interface I18nTextOptions {
  /** All supported locale codes (BCP 47). */
  readonly languages: readonly string[]
  /**
   * Which locales must be present on every `put()`.
   *
   * - `'all'`       — every declared language must be present.
   * - `'any'`       — at least one declared language must be present.
   * - `string[]`    — listed locales are required; others are optional.
   */
  readonly required: 'all' | 'any' | readonly string[]
  /**
   * Per-field opt-in for the `plaintextTranslator` hook (#83).
   * When `true`, missing required translations are auto-generated
   * before `put()` if a translator is configured. Default: `false`.
   */
  readonly autoTranslate?: boolean
}

/**
 * Descriptor returned by `i18nText()`. Attach to the collection's
 * `i18nFields` option:
 *
 * ```ts
 * const lineItems = company.collection<LineItem>('line-items', {
 *   i18nFields: {
 *     description: i18nText({ languages: ['en', 'th'], required: 'all' }),
 *   },
 * })
 * ```
 */
export interface I18nTextDescriptor {
  readonly _noydbI18nText: true
  readonly options: I18nTextOptions
}

/**
 * Create an `I18nTextDescriptor` for a multi-language content field.
 *
 * @param options  Language list + enforcement mode.
 *
 * @example
 * ```ts
 * i18nText({ languages: ['en', 'th'], required: 'all' })
 * i18nText({ languages: ['en', 'th'], required: ['th'], autoTranslate: true })
 * ```
 */
export function i18nText(options: I18nTextOptions): I18nTextDescriptor {
  return { _noydbI18nText: true, options }
}

/** Runtime predicate for detecting an `I18nTextDescriptor`. */
export function isI18nTextDescriptor(x: unknown): x is I18nTextDescriptor {
  return (
    typeof x === 'object' &&
    x !== null &&
    (x as { _noydbI18nText?: unknown })._noydbI18nText === true
  )
}

// ─── Validation helpers ────────────────────────────────────────────────

/**
 * Validate that a value is a valid `{ [locale]: string }` map and that
 * all required locales are present. Throws `MissingTranslationError`
 * when the required constraint is violated.
 *
 * Called by `Collection.put()` for each registered `i18nField`.
 *
 * @param value       The raw field value from the record being put.
 * @param field       The field name (used in the thrown error message).
 * @param descriptor  The `i18nText()` descriptor for this field.
 */
export function validateI18nTextValue(
  value: unknown,
  field: string,
  descriptor: I18nTextDescriptor,
): void {
  const { options } = descriptor

  // Must be a non-null object
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MissingTranslationError(
      field,
      options.languages,
      `Field "${field}" must be a { [locale]: string } map, got ${typeof value}.`,
    )
  }

  const map = value as Record<string, unknown>

  // All values must be strings
  for (const [locale, v] of Object.entries(map)) {
    if (typeof v !== 'string') {
      throw new MissingTranslationError(
        field,
        [locale],
        `Field "${field}": locale "${locale}" must be a string, got ${typeof v}.`,
      )
    }
  }

  // Check required constraint
  const { required } = options
  if (required === 'all') {
    const missing = options.languages.filter(
      (lang) => !(lang in map) || map[lang] === '',
    )
    if (missing.length > 0) {
      throw new MissingTranslationError(
        field,
        missing,
        `Field "${field}" requires all declared languages. Missing: ${missing.join(', ')}.`,
      )
    }
  } else if (required === 'any') {
    const present = options.languages.some(
      (lang) => lang in map && map[lang] !== '',
    )
    if (!present) {
      throw new MissingTranslationError(
        field,
        options.languages,
        `Field "${field}" requires at least one declared language. None present.`,
      )
    }
  } else {
    // string[] — named required locales; TypeScript narrows required to readonly string[]
    const requiredList = required
    const missing = requiredList.filter(
      (lang) => !(lang in map) || map[lang] === '',
    )
    if (missing.length > 0) {
      throw new MissingTranslationError(
        field,
        missing,
        `Field "${field}" requires: ${requiredList.join(', ')}. Missing: ${missing.join(', ')}.`,
      )
    }
  }
}

// ─── Locale resolution ─────────────────────────────────────────────────

/**
 * Resolve an i18nText value (`{ [locale]: string }` map) to a string
 * for the given locale.
 *
 * @param value    The stored locale map.
 * @param locale   The requested locale code, or `'raw'` to return the map.
 * @param fallback Single locale or ordered list; use `'any'` as the last
 *                 element to fall back to any available translation.
 * @param field    Field name used in `LocaleNotSpecifiedError` messages.
 * @returns The resolved string, OR the original map when `locale === 'raw'`.
 */
export function resolveI18nText(
  value: Record<string, string>,
  locale: string,
  fallback?: string | readonly string[],
  field?: string,
): string | Record<string, string> {
  if (locale === 'raw') {
    return value
  }

  if (!locale) {
    throw new LocaleNotSpecifiedError(field ?? '<unknown>')
  }

  // Primary locale
  if (value[locale] !== undefined && value[locale] !== '') {
    return value[locale]
  }

  // Fallback chain
  const chain: readonly string[] = Array.isArray(fallback)
    ? fallback
    : fallback
      ? [fallback]
      : []

  for (const fb of chain) {
    if (fb === 'any') {
      const any = Object.values(value).find((v) => v !== '')
      if (any !== undefined) return any
    } else if (value[fb] !== undefined && value[fb] !== '') {
      return value[fb]
    }
  }

  throw new LocaleNotSpecifiedError(
    field ?? '<unknown>',
    `No translation available for locale "${locale}"` +
      (chain.length > 0 ? ` or fallback chain [${chain.join(', ')}]` : '') +
      '.',
  )
}

/**
 * Apply locale resolution to a single record, in-place over a copy.
 *
 * For each field registered as an `i18nText` descriptor:
 * - If `locale === 'raw'`, the field value is left as the stored map.
 * - Otherwise, the field value is replaced with the resolved string.
 *
 * Records that are not plain objects (null, array, primitives) are
 * returned unchanged.
 *
 * @param record      The decrypted record.
 * @param i18nFields  Map of field name → `I18nTextDescriptor`.
 * @param locale      The requested locale (or `'raw'`).
 * @param fallback    Fallback chain (optional).
 */
export function applyI18nLocale(
  record: Record<string, unknown>,
  i18nFields: Record<string, I18nTextDescriptor>,
  locale: string,
  fallback?: string | readonly string[],
): Record<string, unknown> {
  const fieldNames = Object.keys(i18nFields)
  if (fieldNames.length === 0) return record

  const result = { ...record }

  for (const field of fieldNames) {
    const raw = result[field]
    if (raw === undefined || raw === null) continue
    if (typeof raw !== 'object' || Array.isArray(raw)) continue

    result[field] = resolveI18nText(
      raw as Record<string, string>,
      locale,
      fallback,
      field,
    )
  }

  return result
}
