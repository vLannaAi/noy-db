/**
 * Persisted JSON Schema — opt-in encrypted per-collection schema snapshot.
 *
 * Enable per collection via `vault.collection(name, { schema, persistJsonSchema: true })`.
 * The derived JSON Schema is written to a `_schemas/<collection>` envelope
 * encrypted with the collection's DEK; the next opening of the vault
 * re-derives, hashes, and skips the write when nothing has changed.
 *
 * v0 supports Zod via the optional `zod-to-json-schema` peer-dep. Other
 * Standard Schema validators (Valibot, ArkType, Effect Schema) write a
 * stub envelope flagging the kind without a JSON Schema body.
 *
 * @see docs/superpowers/specs/2026-05-22-schema-dump-design.md
 *
 * @module
 */

export type { PersistedSchemaEnvelope, PersistedSchemaKind } from './types.js'
export { derivePersistedSchema, isZodSchema } from './derive.js'
export {
  SCHEMAS_COLLECTION,
  loadPersistedSchema,
  savePersistedSchema,
} from './storage.js'
export { persistSchemaIfNeeded } from './register.js'
export type { PersistSchemaResult } from './register.js'
