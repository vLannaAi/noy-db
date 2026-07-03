/**
 * Public envelope — owner-curated plaintext metadata, readable
 * before vault unlock or bundle decryption.
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
export type PublicEnvelopeText = string | Record<string, string>

/**
 * Persisted shape — both `_meta/public-envelope` and the bundle
 * header carry this. The version number is monotonic per vault and
 * helps cache invalidators detect change without hashing the JSON.
 */
export interface PublicEnvelope {
  readonly _noydb_public: 1
  readonly version: number
  readonly name?: PublicEnvelopeText
  readonly description?: PublicEnvelopeText
  /** Inline `data:` URL (`data:image/png;base64,…` or `data:image/svg+xml;base64,…`). */
  readonly icon?: string
  /** ISO-8601 timestamp; auto-set on first envelope write, immutable thereafter. */
  readonly createdAt?: string
  /** ISO-8601 timestamp; auto-updated on every `setPublicEnvelope` call. */
  readonly updatedAt?: string
  /** BCP-47 fallback locale for renderers when the user's locale isn't covered. */
  readonly defaultLocale?: string
}

/** Field names the developer can allow in `PublicEnvelopeSchema.fields`. */
export const PUBLIC_ENVELOPE_FIELDS = [
  'name',
  'description',
  'icon',
  'createdAt',
  'updatedAt',
  'defaultLocale',
] as const

export type PublicEnvelopeField = (typeof PUBLIC_ENVELOPE_FIELDS)[number]

/**
 * Build-time schema. The developer enables the feature and bounds
 * what the owner can set. `true` is shorthand for "all defaults" —
 * gives the owner the full field set with the standard caps.
 */
export interface PublicEnvelopeSchema {
  /**
   * Allowed field names. Setting `name`/`description`/`icon`/`defaultLocale` is
   * gated on the field being listed here. `createdAt` / `updatedAt` are managed
   * by the hub; including them is a no-op (the owner cannot set them
   * directly). Default: every field above.
   */
  readonly fields?: ReadonlyArray<PublicEnvelopeField>
  /**
   * Maximum icon size — measured as the length of the data-URL
   * string. Default 256 KB.
   */
  readonly maxIconBytes?: number
  /** Allowed icon MIME types. Default ['image/png', 'image/svg+xml']. */
  readonly iconMimeTypes?: ReadonlyArray<string>
  /** Maximum length of `name` / `description` per locale. Default 200. */
  readonly maxStringChars?: number
}

/** Default schema values; merged onto every developer-supplied schema. */
export const DEFAULT_PUBLIC_ENVELOPE_SCHEMA = {
  fields: PUBLIC_ENVELOPE_FIELDS,
  maxIconBytes: 256 * 1024,
  iconMimeTypes: ['image/png', 'image/svg+xml'] as const,
  maxStringChars: 200,
} as const satisfies Required<PublicEnvelopeSchema>

/** Resolved schema after merging developer override onto defaults. */
export interface ResolvedPublicEnvelopeSchema {
  readonly fields: ReadonlyArray<PublicEnvelopeField>
  readonly maxIconBytes: number
  readonly iconMimeTypes: ReadonlyArray<string>
  readonly maxStringChars: number
}

/**
 * Merge developer schema onto the defaults. The shorthand `true`
 * resolves to the full default schema; an explicit object only
 * overrides the keys it provides.
 */
export function resolveSchema(
  schema: true | PublicEnvelopeSchema | undefined,
): ResolvedPublicEnvelopeSchema | undefined {
  if (!schema) return undefined
  if (schema === true) {
    return {
      fields: DEFAULT_PUBLIC_ENVELOPE_SCHEMA.fields,
      maxIconBytes: DEFAULT_PUBLIC_ENVELOPE_SCHEMA.maxIconBytes,
      iconMimeTypes: DEFAULT_PUBLIC_ENVELOPE_SCHEMA.iconMimeTypes,
      maxStringChars: DEFAULT_PUBLIC_ENVELOPE_SCHEMA.maxStringChars,
    }
  }
  return {
    fields: schema.fields ?? DEFAULT_PUBLIC_ENVELOPE_SCHEMA.fields,
    maxIconBytes: schema.maxIconBytes ?? DEFAULT_PUBLIC_ENVELOPE_SCHEMA.maxIconBytes,
    iconMimeTypes: schema.iconMimeTypes ?? DEFAULT_PUBLIC_ENVELOPE_SCHEMA.iconMimeTypes,
    maxStringChars: schema.maxStringChars ?? DEFAULT_PUBLIC_ENVELOPE_SCHEMA.maxStringChars,
  }
}
