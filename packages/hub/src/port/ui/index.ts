/**
 * **@noy-db/hub/ui** — the narrow, stable seam for the `collection.describe()`
 * output contract that `@noy-db/ui` (and `@noy-db/ui-nuxt`) bind to *instead of* the
 * whole `@noy-db/hub` root barrel.
 *
 * It re-exports ONLY the describe()-output type contract: the `CollectionDescription`
 * envelope, its `DescribedField` element, the async `DescribeOptions`, and the
 * descriptive-metadata building blocks (`CollectionMeta`, `FieldMeta`, `SemanticType`).
 * Type-only — `describe()` itself is a method on `Collection`, reached via the root
 * barrel / `/cargo`. These same names also remain exported from the root barrel
 * (this subpath is purely additive); ui can migrate to the narrow seam on its own
 * schedule. Treat it as a contract — additive changes only; removals are breaking.
 *
 * The pre-existing `./describe` subpath has been retired (coordinated removal;
 * consumers migrated to `/ui`).
 *
 * @packageDocumentation
 */

export type {
  CollectionDescription,
  DescribedField,
  DescribeOptions,
} from '../../with-shape/introspection/describe.js'
export type { CollectionMeta } from '../../with-shape/introspection/meta.js'
export type { FieldMeta, SemanticType } from '../../with-shape/introspection/field-meta.js'
