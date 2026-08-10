/**
 * Introspection — `Vault.dumpSchema()` produces a structured
 * {@link VaultSchemaSnapshot} describing the vault's shape and (optional)
 * stats. Consumed by `noydb describe` for human-readable audit output.
 *
 * @see design-history/2026-05-22-schema-dump-design.md
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
// #843 C3b — the rest of the introspection cluster; C3a's barrel covered only
// `dumpVaultSchema`'s own types.
export type { SchemaIntrospection } from './types.js'
export type { FieldMeta, SemanticType } from './field-meta.js'
export type { CollectionDescription, DescribedField, DescribeOptions } from './describe.js'
// #1021 — the last symbol a describe/UI consumer needed that lived only on the
// root barrel. `/introspection` is the seam such a consumer binds (there is no
// `/ui` subpath and none is planned — #1002), so binding it should not force a
// second import from the whole-library root just for validation issues.
// Type-only re-export: no runtime surface, nothing to tree-shake.
export type { StandardSchemaV1Issue } from '../../kernel/schema.js'
export { applyListProjection } from './projection.js'
export type { ListProjectionOptions } from './projection.js'
// #947 Task 3 — `Vault.listBehaviors()`'s typed enumeration of the five
// behavior registries (guards/derivations/MVs/overlays/satellites).
export type {
  BehaviorSummary,
  GuardBehaviorEntry,
  DerivationBehaviorEntry,
  DerivationOutputEntry,
  MaterializedViewBehaviorEntry,
  OverlayBehaviorEntry,
  SatelliteBehaviorEntry,
} from './behaviors.js'
