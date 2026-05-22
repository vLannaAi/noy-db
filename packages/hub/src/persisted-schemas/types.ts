/**
 * Persisted-schema envelope shape.
 *
 * Stored encrypted under `_schemas/<collection>` with the same DEK as the
 * collection's records. Auditors who can unlock the collection's data can
 * also read its schema; nothing more.
 *
 * @see docs/superpowers/specs/2026-05-22-schema-dump-design.md
 *
 * @module
 */

/** Family of Standard Schema v1 validator the persisted snapshot was derived from. */
export type PersistedSchemaKind = 'Zod' | 'Valibot' | 'ArkType' | 'Effect' | 'Unknown'

/**
 * Plaintext payload encrypted into the `_data` field of the
 * `_schemas/<collection>` envelope. The wrapper `EncryptedEnvelope` adds
 * `_noydb`, `_v`, `_ts`, `_iv`, `_data` per the standard noy-db record
 * format.
 */
export interface PersistedSchemaEnvelope {
  readonly _noydb_schema: 1
  /** Detected validator family. */
  readonly kind: PersistedSchemaKind
  /**
   * JSON Schema (Draft 2020-12) derived from the validator. Null when
   * derivation isn't yet supported for `kind`; in that case `reason` is
   * populated.
   */
  readonly jsonSchema: object | null
  /** SHA-256 (hex) of the canonicalised JSON Schema, or null when unavailable. */
  readonly hash: string | null
  /** Human-readable reason when `jsonSchema` is null. */
  readonly reason?: string
  /** ISO-8601 timestamp of the most recent derivation write. */
  readonly derivedAt: string
}
