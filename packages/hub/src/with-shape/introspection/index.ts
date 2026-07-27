/**
 * Introspection — `Vault.dumpSchema()` produces a structured
 * {@link VaultSchemaSnapshot} describing the vault's shape and (optional)
 * stats. Consumed by `noydb describe` for human-readable audit output.
 *
 * @see docs/superpowers/specs/2026-05-22-schema-dump-design.md
 *
 * @module
 */

export type {
  VaultSchemaSnapshot,
  DumpSchemaOptions,
  CollectionDescriptor,
  CollectionConfig,
  CollectionStats,
  FieldDescriptor,
  FieldSource,
  MaterializedViewDescriptor,
  OverlayViewDescriptor,
  DerivationDescriptor,
  InternalCollectionStats,
} from './types.js'
export { dumpVaultSchema } from './walk.js'
// #843 C3a — `dumpVaultSchema`'s vault parameter names it, so `@noy-db/hub/introspection`
// must be able to name it too.
export type { VaultIntrospectState } from './walk.js'
export { jsonSchemaToFields } from './fields.js'
