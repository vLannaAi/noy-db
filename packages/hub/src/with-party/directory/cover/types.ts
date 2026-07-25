/**
 * Cover — owner-curated plaintext metadata, readable before vault
 * unlock or bundle decryption. Like a book's cover: title, cover
 * art, back-cover blurb — readable on the shelf without opening
 * the book, and never trusted as the book's contents.
 *
 * (Formerly "public envelope" — the wire keeps that name: the
 * record still lives at `_meta/public-envelope` and carries the
 * `_noydb_public: 1` discriminator.)
 *
 * @see https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/services/public-envelope.md
 *
 * @module
 */

/**
 * Either a single string (used when the developer's app is
 * single-locale) or a locale → string map for i18n. Mirrors the
 * shape `@noy-db/hub/i18n` already uses for record fields, so the
 * existing `resolveI18nText` resolver applies.
 */
export type CoverText = string | Record<string, string>

/**
 * A JSON-serializable value — what a `custom` namespace payload may
 * hold. No functions, `undefined`, symbols, bigints, or cycles; the
 * validator additionally caps nesting depth at 8 levels.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

/**
 * Persisted shape — both `_meta/public-envelope` (the frozen wire
 * name) and the bundle header carry this. The version number is
 * monotonic per vault and helps cache invalidators detect change
 * without hashing the JSON.
 */
export interface Cover {
  readonly _noydb_public: 1
  readonly version: number
  readonly name?: CoverText
  readonly description?: CoverText
  /** Inline `data:` URL (`data:image/png;base64,…` or `data:image/svg+xml;base64,…`). */
  readonly icon?: string
  /** ISO-8601 timestamp; auto-set on first cover write, immutable thereafter. */
  readonly createdAt?: string
  /** ISO-8601 timestamp; auto-updated on every `setCover` call. */
  readonly updatedAt?: string
  /** BCP-47 fallback locale for renderers when the user's locale isn't covered. */
  readonly defaultLocale?: string
  /**
   * Namespaced integrator slot (#800) — e.g.
   * `{ 'noydb.viewer': { defaultCollection: 'invoices' } }`. Keys must
   * be reverse-DNS / package-style (`noydb.viewer`, `com.acme.registry`).
   * Like everything on the cover it is plaintext, public, and
   * unauthenticated — payloads are hints, never authority. Opt-in:
   * excluded from `DEFAULT_COVER_SCHEMA.fields`, so `cover: true`
   * does NOT enable it.
   */
  readonly custom?: Record<string, JsonValue>
}

/** Field names the developer can allow in `CoverSchema.fields`. */
export const COVER_FIELDS = [
  'name',
  'description',
  'icon',
  'createdAt',
  'updatedAt',
  'defaultLocale',
  'custom',
] as const

export type CoverField = (typeof COVER_FIELDS)[number]

/**
 * Build-time schema. The developer enables the feature and bounds
 * what the owner can set. `true` is shorthand for "all defaults" —
 * gives the owner the full field set with the standard caps.
 */
export interface CoverSchema {
  /**
   * Allowed field names. Setting `name`/`description`/`icon`/`defaultLocale` is
   * gated on the field being listed here. `createdAt` / `updatedAt` are managed
   * by the hub; including them is a no-op (the owner cannot set them
   * directly). Default: every field above.
   */
  readonly fields?: ReadonlyArray<CoverField>
  /**
   * Maximum icon size — measured as the length of the data-URL
   * string. Default 256 KB.
   */
  readonly maxIconBytes?: number
  /** Allowed icon MIME types. Default ['image/png', 'image/svg+xml']. */
  readonly iconMimeTypes?: ReadonlyArray<string>
  /** Maximum length of `name` / `description` per locale. Default 200. */
  readonly maxStringChars?: number
  /**
   * Maximum serialized size (`JSON.stringify` length) of the whole
   * would-be-persisted `custom` object, measured AFTER the namespace
   * patch merge. Default 8 KB.
   */
  readonly maxCustomBytes?: number
  /**
   * Maximum serialized size of the ENTIRE would-be-persisted cover
   * document. The consumer-protection cap — bounds what a pre-auth
   * reader must fetch and parse, and closes the unbounded locale-map
   * key-count hole for `name` / `description`. Default 300 KB
   * (headroom over the 256 KB icon cap + text fields).
   */
  readonly maxCoverBytes?: number
}

/**
 * Default schema values; merged onto every developer-supplied schema.
 * NOTE: `fields` is the six display fields, deliberately NOT
 * {@link COVER_FIELDS} — the opt-in `'custom'` slot is excluded, so
 * the `cover: true` shorthand never exposes it by accident.
 */
export const DEFAULT_COVER_SCHEMA = {
  fields: ['name', 'description', 'icon', 'createdAt', 'updatedAt', 'defaultLocale'],
  maxIconBytes: 256 * 1024,
  iconMimeTypes: ['image/png', 'image/svg+xml'] as const,
  maxStringChars: 200,
  maxCustomBytes: 8 * 1024,
  maxCoverBytes: 300 * 1024,
} as const satisfies Required<CoverSchema>

/** Resolved schema after merging developer override onto defaults. */
export interface ResolvedCoverSchema {
  readonly fields: ReadonlyArray<CoverField>
  readonly maxIconBytes: number
  readonly iconMimeTypes: ReadonlyArray<string>
  readonly maxStringChars: number
  readonly maxCustomBytes: number
  readonly maxCoverBytes: number
}

/**
 * Merge developer schema onto the defaults. The shorthand `true`
 * resolves to the full default schema; an explicit object only
 * overrides the keys it provides.
 */
export function resolveSchema(
  schema: true | CoverSchema | undefined,
): ResolvedCoverSchema | undefined {
  if (!schema) return undefined
  if (schema === true) {
    return {
      fields: DEFAULT_COVER_SCHEMA.fields,
      maxIconBytes: DEFAULT_COVER_SCHEMA.maxIconBytes,
      iconMimeTypes: DEFAULT_COVER_SCHEMA.iconMimeTypes,
      maxStringChars: DEFAULT_COVER_SCHEMA.maxStringChars,
      maxCustomBytes: DEFAULT_COVER_SCHEMA.maxCustomBytes,
      maxCoverBytes: DEFAULT_COVER_SCHEMA.maxCoverBytes,
    }
  }
  return {
    fields: schema.fields ?? DEFAULT_COVER_SCHEMA.fields,
    maxIconBytes: schema.maxIconBytes ?? DEFAULT_COVER_SCHEMA.maxIconBytes,
    iconMimeTypes: schema.iconMimeTypes ?? DEFAULT_COVER_SCHEMA.iconMimeTypes,
    maxStringChars: schema.maxStringChars ?? DEFAULT_COVER_SCHEMA.maxStringChars,
    maxCustomBytes: schema.maxCustomBytes ?? DEFAULT_COVER_SCHEMA.maxCustomBytes,
    maxCoverBytes: schema.maxCoverBytes ?? DEFAULT_COVER_SCHEMA.maxCoverBytes,
  }
}

// ─── Deprecated aliases (#799 public-envelope → cover; remove after one pre-release window) ───

/** @deprecated Use {@link Cover}. */
export type PublicEnvelope = Cover
/** @deprecated Use {@link CoverText}. */
export type PublicEnvelopeText = CoverText
/** @deprecated Use {@link CoverField}. */
export type PublicEnvelopeField = CoverField
/** @deprecated Use {@link CoverSchema}. */
export type PublicEnvelopeSchema = CoverSchema
/** @deprecated Use {@link ResolvedCoverSchema}. */
export type ResolvedPublicEnvelopeSchema = ResolvedCoverSchema
/** @deprecated Use {@link COVER_FIELDS}. */
export const PUBLIC_ENVELOPE_FIELDS = COVER_FIELDS
/** @deprecated Use {@link DEFAULT_COVER_SCHEMA}. */
export const DEFAULT_PUBLIC_ENVELOPE_SCHEMA = DEFAULT_COVER_SCHEMA
