/**
 * @noy-db/hub/indexing — opt-in secondary-index subsystem.
 *
 * @category capability
 *
 * Groups every file whose reason-for-existing is secondary indexes:
 *   - `eager-indexes` (in-memory `CollectionIndexes` for eager-mode
 *     collections' `.where(f, '==', v)` fast-path)
 *   - `persisted-indexes` (lazy-mode `_idx/<field>/<recordId>`
 *     side-car mirror with composite / typed-value support)
 *   - `lazy-builder` (`LazyQuery<T>` chainable builder that
 *     dispatches through the persisted mirror)
 *
 * Hub's root barrel (`@noy-db/hub`) and the `@noy-db/hub/query`
 * subpath continue to re-export `CollectionIndexes` and `IndexDef`
 * for backward compatibility with consumers written before the
 * v0.24 relocation. New code should prefer this subpath so the
 * capability boundary is explicit in import statements.
 */

// Strategy factory — pass the result into createNoydb({ indexStrategy }).
export { withIndexing } from './active.js'
export type { IndexStrategy, IndexState } from './strategy.js'

// Eager-mode mirror — used by the Query builder's candidateRecords
// fast-path for `==` and `in` lookups on in-memory collections.
export { CollectionIndexes } from './eager-indexes.js'
export type { IndexDef, HashIndex } from './eager-indexes.js'

// Lazy-mode persisted mirror + side-car id helpers.
export {
  PersistedCollectionIndex,
  IDX_PREFIX,
  COMPOSITE_DELIMITER,
  encodeIdxId,
  decodeIdxId,
  isIdxId,
  compositeKey,
} from './persisted-indexes.js'
export type {
  OrderedEntry,
  IngestRow,
  PersistedIndexDef,
} from './persisted-indexes.js'

// Lazy query builder — the chainable API that backs
// `Collection.lazyQuery()` in lazy mode.
export { LazyQuery } from './lazy-builder.js'
export type { LazyQuerySource, LazyOrderBy } from './lazy-builder.js'
