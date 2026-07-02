/**
 * @noy-db/hub/describe — DEPRECATED alias for `@noy-db/hub/ui`.
 *
 * @deprecated Prefer `@noy-db/hub/ui`. This file exists only so
 * `dist/describe/index.js` (the pre-existing `./describe` subpath) keeps
 * resolving; `/describe` used to be built from the same source file as
 * `/ui` via a dual tsup entry — this explicit barrel makes the alias
 * visible code instead.
 */
export type {
  CollectionDescription,
  DescribedField,
  DescribeOptions,
  CollectionMeta,
  FieldMeta,
  SemanticType,
} from '../port/ui/index.js'
