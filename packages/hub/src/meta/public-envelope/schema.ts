/**
 * Validate-on-write for the public envelope. Runs at every
 * `setPublicEnvelope` call; the developer's schema decides which
 * fields are allowed and the size caps that apply.
 *
 * @module
 */
import { ValidationError } from '../../errors.js'
import type {
  PublicEnvelope,
  PublicEnvelopeText,
  ResolvedPublicEnvelopeSchema,
  PublicEnvelopeField,
} from './types.js'

/** Owner-supplied input — the subset of {@link PublicEnvelope} the owner can set. */
export interface SetPublicEnvelopeInput {
  readonly name?: PublicEnvelopeText
  readonly description?: PublicEnvelopeText
  readonly icon?: string
  readonly defaultLocale?: string
}

const DATA_URL_PREFIX = /^data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+);base64,/

/**
 * Validate an owner-supplied envelope input against the developer's
 * resolved schema. Throws `ValidationError` on the first violation;
 * returns void on success.
 *
 * The validator is deliberately strict: every fail mode is a hard
 * error rather than a silent drop, so the owner finds out immediately
 * which field they oversized rather than discovering a truncated
 * label months later.
 */
export function validatePublicEnvelopeInput(
  input: SetPublicEnvelopeInput,
  schema: ResolvedPublicEnvelopeSchema,
): void {
  const allowed = new Set<PublicEnvelopeField>(schema.fields)

  // Reject any key not in the schema's allowed-field list.
  for (const key of Object.keys(input)) {
    const known: PublicEnvelopeField | undefined =
      key === 'name' || key === 'description' || key === 'icon' || key === 'defaultLocale'
        ? key
        : undefined
    if (!known) {
      throw new ValidationError(
        `setPublicEnvelope: unknown field "${key}". ` +
          `Allowed fields: ${[...allowed].join(', ')}.`,
      )
    }
    if (!allowed.has(known)) {
      throw new ValidationError(
        `setPublicEnvelope: field "${known}" is not enabled in this vault's schema. ` +
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
      `setPublicEnvelope: defaultLocale must be a string (BCP-47), got ${typeof input.defaultLocale}.`,
    )
  }
}

function validateText(
  value: PublicEnvelopeText,
  field: string,
  maxChars: number,
): void {
  if (typeof value === 'string') {
    if (value.length > maxChars) {
      throw new ValidationError(
        `setPublicEnvelope: ${field} exceeds the ${maxChars}-character cap (got ${value.length}).`,
      )
    }
    return
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError(
      `setPublicEnvelope: ${field} must be a string or { [locale]: string } map, got ${typeof value}.`,
    )
  }
  // Locale map. Each value must be a non-empty string within the cap.
  for (const [locale, str] of Object.entries(value)) {
    if (typeof str !== 'string') {
      throw new ValidationError(
        `setPublicEnvelope: ${field}[${locale}] must be a string, got ${typeof str}.`,
      )
    }
    if (str.length > maxChars) {
      throw new ValidationError(
        `setPublicEnvelope: ${field}[${locale}] exceeds the ${maxChars}-character cap (got ${str.length}).`,
      )
    }
  }
}

function validateIcon(icon: string, schema: ResolvedPublicEnvelopeSchema): void {
  if (typeof icon !== 'string') {
    throw new ValidationError(
      `setPublicEnvelope: icon must be a data: URL string, got ${typeof icon}.`,
    )
  }
  if (icon.length > schema.maxIconBytes) {
    throw new ValidationError(
      `setPublicEnvelope: icon exceeds the ${schema.maxIconBytes}-byte cap (got ${icon.length}).`,
    )
  }
  const m = DATA_URL_PREFIX.exec(icon)
  if (!m) {
    throw new ValidationError(
      'setPublicEnvelope: icon must be a base64 data URL ' +
        '(`data:image/png;base64,…` or `data:image/svg+xml;base64,…`). ' +
        'External URLs are not supported in v1.',
    )
  }
  const mime = m[1]!
  if (!schema.iconMimeTypes.includes(mime)) {
    throw new ValidationError(
      `setPublicEnvelope: icon MIME type "${mime}" is not allowed. ` +
        `Permitted types: ${schema.iconMimeTypes.join(', ')}.`,
    )
  }
}

/**
 * Lightweight runtime predicate — used by the bundle header
 * validator to recognise a public envelope without requiring it.
 */
export function isPublicEnvelope(x: unknown): x is PublicEnvelope {
  if (x === null || typeof x !== 'object' || Array.isArray(x)) return false
  const obj = x as Record<string, unknown>
  return obj['_noydb_public'] === 1 && typeof obj['version'] === 'number'
}
