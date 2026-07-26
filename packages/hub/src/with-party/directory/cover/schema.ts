/**
 * Validate-on-write for the cover. Runs at every `setCover` call;
 * the developer's schema decides which fields are allowed and the
 * size caps that apply.
 *
 * @module
 */
import { ValidationError } from '../../../kernel/errors.js'
import { validateCustomInput } from './custom.js'
import type {
  Cover,
  CoverText,
  JsonValue,
  ResolvedCoverSchema,
  CoverField,
} from './types.js'

/** Owner-supplied input — the subset of {@link Cover} the owner can set. */
export interface SetCoverInput {
  readonly name?: CoverText
  readonly description?: CoverText
  readonly icon?: string
  readonly defaultLocale?: string
  /**
   * Namespace-level patch for the cover's `custom` slot (#800):
   * provided namespaces replace their previous value, absent
   * namespaces are preserved, an explicit `null` deletes that
   * namespace. Requires `'custom'` in the schema's `fields` list —
   * the `cover: true` shorthand does NOT enable it.
   */
  readonly custom?: Record<string, JsonValue>
}

const DATA_URL_PREFIX = /^data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+);base64,/

/**
 * Validate an owner-supplied cover input against the developer's
 * resolved schema. Throws `ValidationError` on the first violation;
 * returns void on success.
 *
 * The validator is deliberately strict: every fail mode is a hard
 * error rather than a silent drop, so the owner finds out immediately
 * which field they oversized rather than discovering a truncated
 * label months later.
 */
export function validateCoverInput(
  input: SetCoverInput,
  schema: ResolvedCoverSchema,
): void {
  const allowed = new Set<CoverField>(schema.fields)

  // Reject any key not in the schema's allowed-field list.
  for (const key of Object.keys(input)) {
    const known: CoverField | undefined =
      key === 'name' || key === 'description' || key === 'icon' || key === 'defaultLocale' || key === 'custom'
        ? key
        : undefined
    if (!known) {
      throw new ValidationError(
        `setCover: unknown field "${key}". ` +
          `Allowed fields: ${[...allowed].join(', ')}.`,
      )
    }
    if (!allowed.has(known)) {
      throw new ValidationError(
        `setCover: field "${known}" is not enabled in this vault's schema. ` +
          `Allowed fields: ${[...allowed].join(', ')}.`,
      )
    }
  }

  if (input.name !== undefined) {
    validateText(input.name, 'name', schema.maxStringChars)
  }
  if (input.description !== undefined) {
    validateText(input.description, 'description', schema.maxStringChars)
  }
  if (input.icon !== undefined) {
    validateIcon(input.icon, schema)
  }
  if (input.defaultLocale !== undefined && typeof input.defaultLocale !== 'string') {
    throw new ValidationError(
      `setCover: defaultLocale must be a string (BCP-47), got ${typeof input.defaultLocale}.`,
    )
  }
  if (input.custom !== undefined) {
    validateCustomInput(input.custom)
  }
}

function validateText(
  value: CoverText,
  field: string,
  maxChars: number,
): void {
  if (typeof value === 'string') {
    if (value.length > maxChars) {
      throw new ValidationError(
        `setCover: ${field} exceeds the ${maxChars}-character cap (got ${value.length}).`,
      )
    }
    return
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError(
      `setCover: ${field} must be a string or { [locale]: string } map, got ${typeof value}.`,
    )
  }
  // Locale map. Each value must be a non-empty string within the cap.
  for (const [locale, str] of Object.entries(value)) {
    if (typeof str !== 'string') {
      throw new ValidationError(
        `setCover: ${field}[${locale}] must be a string, got ${typeof str}.`,
      )
    }
    if (str.length > maxChars) {
      throw new ValidationError(
        `setCover: ${field}[${locale}] exceeds the ${maxChars}-character cap (got ${str.length}).`,
      )
    }
  }
}

function validateIcon(icon: string, schema: ResolvedCoverSchema): void {
  if (typeof icon !== 'string') {
    throw new ValidationError(
      `setCover: icon must be a data: URL string, got ${typeof icon}.`,
    )
  }
  if (icon.length > schema.maxIconBytes) {
    throw new ValidationError(
      `setCover: icon exceeds the ${schema.maxIconBytes}-byte cap (got ${icon.length}).`,
    )
  }
  const m = DATA_URL_PREFIX.exec(icon)
  if (!m) {
    throw new ValidationError(
      'setCover: icon must be a base64 data URL ' +
        '(`data:image/png;base64,…` or `data:image/svg+xml;base64,…`). ' +
        'External URLs are not supported in v1.',
    )
  }
  const mime = m[1]!
  if (!schema.iconMimeTypes.includes(mime)) {
    throw new ValidationError(
      `setCover: icon MIME type "${mime}" is not allowed. ` +
        `Permitted types: ${schema.iconMimeTypes.join(', ')}.`,
    )
  }
}

/**
 * Lightweight runtime predicate — used by the bundle header
 * validator to recognise a cover without requiring it. (The wire
 * discriminator keeps its frozen name: `_noydb_public: 1`.)
 */
export function isCover(x: unknown): x is Cover {
  if (x === null || typeof x !== 'object' || Array.isArray(x)) return false
  const obj = x as Record<string, unknown>
  return obj['_noydb_public'] === 1 && typeof obj['version'] === 'number'
}
