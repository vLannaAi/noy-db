/**
 * i18nText schema type —
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
 * merging.
 */

import { MissingTranslationError, LocaleNotSpecifiedError } from '../errors.js'
import type { OnMissing, OnMissingPolicy } from './policy.js'

// ─── i18nText descriptor ───────────────────────────────────────────────

/**
 * Options for `i18nText()`.
 *
 * `languages` declares the full set of supported locales. `required`
 * controls which must be present on every `put()`.
 *
 * `autoTranslate` is the per-field opt-in for the `plaintextTranslator`
 * hook. When `true` and a `plaintextTranslator` is configured
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
   * Per-field opt-in for the `plaintextTranslator` hook.
   * When `true`, missing required translations are auto-generated
   * before `put()` if a translator is configured. Default: `false`.
   */
  readonly autoTranslate?: boolean
  /**
   * What to do when this field is resolved to a locale that is absent.
   * A single policy, or a per-layer map (read/guard/join/mv/derivation/
   * export). Default `'throw'` — today's behavior, zero breaking change.
   * See {@link OnMissingPolicy}.
   */
  readonly onMissing?: OnMissingPolicy
  /**
   * Ordered preferred-substitute locales used when `onMissing` resolves
   * to `'substitute'` and the target locale is absent. `'any'` as an
   * element means "first non-empty value". A caller-supplied `fallback`
   * at read time takes precedence over this declared list.
   */
  readonly substitute?: readonly string[]
  /**
   * Per-locale script enforcement (write-time). `'auto'` infers the
   * allowed Unicode scripts per locale (asymmetric Latin tolerance); an
   * object overrides per slot. Absent ⇒ no check. See `./script.ts`.
   */
  readonly script?: 'auto' | Partial<Record<string, readonly string[]>>
  /**
   * What to do when a slot's value contains characters outside its
   * allowed script set. Default `'reject'`.
   */
  readonly onScriptViolation?: 'reject' | 'filter' | 'warn'
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
/** Options for the policy-aware form of {@link resolveI18nText}. */
export interface ResolveI18nOptions {
  /** Effective policy for the resolution layer. Default `'throw'`. */
  readonly policy?: OnMissing
  /** Declared substitute chain; applied only under policy `'substitute'`. */
  readonly substitute?: readonly string[]
}

/** Normalize a single-or-list fallback into an array. */
function toChain(fallback: string | readonly string[] | undefined): readonly string[] {
  return Array.isArray(fallback) ? fallback : fallback ? [fallback as string] : []
}

/** Walk a chain, returning the first non-empty value (or `'any'` match). */
function pickFromChain(
  value: Record<string, string>,
  chain: readonly string[],
): string | undefined {
  for (const fb of chain) {
    if (fb === 'any') {
      const any = Object.values(value).find((v) => v !== '')
      if (any !== undefined) return any
    } else if (value[fb] !== undefined && value[fb] !== '') {
      return value[fb]
    }
  }
  return undefined
}

// Legacy 4-arg form: can only throw or return — never null. Keeps every
// existing call site's type unchanged (default policy is 'throw').
export function resolveI18nText(
  value: Record<string, string>,
  locale: string,
  fallback?: string | readonly string[],
  field?: string,
): string | Record<string, string>
// Policy-aware form: may return null under 'null'/'substitute' policies.
export function resolveI18nText(
  value: Record<string, string>,
  locale: string,
  fallback: string | readonly string[] | undefined,
  field: string | undefined,
  opts: ResolveI18nOptions,
): string | Record<string, string> | null
export function resolveI18nText(
  value: Record<string, string>,
  locale: string,
  fallback?: string | readonly string[],
  field?: string,
  opts?: ResolveI18nOptions,
): string | Record<string, string> | null {
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

  const policy: OnMissing = opts?.policy ?? 'throw'

  // Caller-supplied fallback ALWAYS applies first (backward compat +
  // explicit read-time override), regardless of policy.
  const callerChain = toChain(fallback)
  const callerHit = pickFromChain(value, callerChain)
  if (callerHit !== undefined) return callerHit

  // Declared substitute applies ONLY under policy 'substitute'.
  if (policy === 'substitute') {
    const subHit = pickFromChain(value, toChain(opts?.substitute))
    if (subHit !== undefined) return subHit
  }

  // Exhausted.
  if (policy === 'throw') {
    throw new LocaleNotSpecifiedError(
      field ?? '<unknown>',
      `No translation available for locale "${locale}"` +
        (callerChain.length > 0 ? ` or fallback chain [${callerChain.join(', ')}]` : '') +
        '.',
    )
  }
  return null
}

// ─── Path helpers (nested i18nFields like 'address.lineOne') ──────────

/**
 * Return all leaf values at `path`, expanding `[].` array wildcards.
 *
 * - `'name'`              → `[obj.name]`
 * - `'address.lineOne'`   → `[obj.address.lineOne]`
 * - `'contacts[].title'`  → `[obj.contacts[0].title, obj.contacts[1].title, …]`
 *
 * Returns an empty array when the path does not resolve (missing key,
 * wrong type, etc.). Used by `enforceI18nOnPut` to validate nested fields.
 */
export function getAtPath(obj: Record<string, unknown>, path: string): unknown[] {
  const arrayIdx = path.indexOf('[].')
  if (arrayIdx !== -1) {
    const arrayKey = path.slice(0, arrayIdx)
    const restPath = path.slice(arrayIdx + 3)
    const arr = obj[arrayKey]
    if (!Array.isArray(arr)) return []
    return arr.flatMap(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return []
      return getAtPath(item as Record<string, unknown>, restPath)
    })
  }
  const dotIdx = path.indexOf('.')
  if (dotIdx !== -1) {
    const head = path.slice(0, dotIdx)
    const rest = path.slice(dotIdx + 1)
    const nested = obj[head]
    if (!nested || typeof nested !== 'object' || Array.isArray(nested)) return []
    return getAtPath(nested as Record<string, unknown>, rest)
  }
  const val = obj[path]
  return val !== undefined ? [val] : []
}

/**
 * Mutate `obj` in-place, setting `value` at the nested `path`.
 * Supports dot notation (`'address.lineOne'`) but not array wildcards —
 * auto-translate on `contacts[].title` style paths is not supported.
 */
export function setAtPathInPlace(
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const dotIdx = path.indexOf('.')
  if (dotIdx !== -1) {
    const head = path.slice(0, dotIdx)
    const rest = path.slice(dotIdx + 1)
    const nested = obj[head]
    if (!nested || typeof nested !== 'object' || Array.isArray(nested)) return
    setAtPathInPlace(nested as Record<string, unknown>, rest, value)
    return
  }
  obj[path] = value
}

/** Recursively resolve i18nText at a single path within a record copy. */
function applyAtPath(
  obj: Record<string, unknown>,
  path: string,
  locale: string,
  fallback: string | readonly string[] | undefined,
): Record<string, unknown> {
  const arrayIdx = path.indexOf('[].')
  if (arrayIdx !== -1) {
    const arrayKey = path.slice(0, arrayIdx)
    const restPath = path.slice(arrayIdx + 3)
    const arr = obj[arrayKey]
    if (!Array.isArray(arr)) return obj
    return {
      ...obj,
      [arrayKey]: arr.map(item => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return item
        return applyAtPath(item as Record<string, unknown>, restPath, locale, fallback)
      }),
    }
  }
  const dotIdx = path.indexOf('.')
  if (dotIdx !== -1) {
    const head = path.slice(0, dotIdx)
    const rest = path.slice(dotIdx + 1)
    const nested = obj[head]
    if (!nested || typeof nested !== 'object' || Array.isArray(nested)) return obj
    return {
      ...obj,
      [head]: applyAtPath(nested as Record<string, unknown>, rest, locale, fallback),
    }
  }
  const raw = obj[path]
  if (raw === undefined || raw === null) return obj
  if (typeof raw !== 'object' || Array.isArray(raw)) return obj
  return {
    ...obj,
    [path]: resolveI18nText(raw as Record<string, string>, locale, fallback, path),
  }
}

/**
 * Apply locale resolution to a single record, returning a new copy.
 *
 * For each field registered as an `i18nText` descriptor:
 * - If `locale === 'raw'`, the field value is left as the stored map.
 * - Otherwise, the field value is replaced with the resolved string.
 *
 * Field paths support dot notation (`'address.lineOne'`) and array
 * wildcards (`'contacts[].title'`). Top-level fields work as before.
 *
 * @param record      The decrypted record.
 * @param i18nFields  Map of field path → `I18nTextDescriptor`.
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

  let result = record

  for (const field of fieldNames) {
    result = applyAtPath(result, field, locale, fallback)
  }

  return result
}
