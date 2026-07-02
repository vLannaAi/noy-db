/**
 * **@noy-db/hub/ui** — the narrow, stable seam for the `collection.describe()`
 * output contract that `@noy-db/ui` (and `@noy-db/ui-nuxt`) bind to *instead of* the
 * whole `@noy-db/hub` root barrel.
 *
 * It re-exports ONLY the describe()-output type contract: the `CollectionDescription`
 * envelope, its `DescribedField` element, the async `DescribeOptions`, and the
 * descriptive-metadata building blocks (`CollectionMeta`, `FieldMeta`, `SemanticType`).
 * Type-only — `describe()` itself is a method on `Collection`, reached via the root
 * barrel / `/kernel`. These same names also remain exported from the root barrel
 * (this subpath is purely additive); ui can migrate to the narrow seam on its own
 * schedule. Treat it as a contract — additive changes only; removals are breaking.
 *
 * ALIASING (S5 family doors): this file is `src/kernel/ui/index.ts`, the relocated
 * `src/describe.ts` (moved via `git mv`). It is built under TWO tsup entries that
 * point at this SAME source file — `'ui/index'` (→ `dist/ui/index.js`, the `./ui`
 * subpath) and `'describe/index'` (→ `dist/describe/index.js`, the pre-existing
 * `./describe` subpath, now a deprecated alias). Both `package.json` exports map
 * to their respective dist output; there is no separate stub file for `/describe`.
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
