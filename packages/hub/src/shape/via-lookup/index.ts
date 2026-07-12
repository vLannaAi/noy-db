/**
 * `shape/via-lookup/` barrel — the dict/enum-tier lookup engine (#650
 * Task 1 — via-lookup extraction, phase D of the Via port).
 *
 * Not a public package subpath yet (no `@noy-db/hub/lookup` entry) —
 * consumed today only through `port/with/lookup-strategy.ts` and, for the
 * existing `vault.dictionary()` surface, through `shape/via-i18n/active.ts`.
 */

export { LookupHandle, DictionaryHandle, DICT_COLLECTION_PREFIX, dictCollectionName, type DictEntry, type DictionaryOptions } from './handle.js'
export { enforceStaticDictOnPut, resolveDictSource, updateReferencingRecords, type DictReferencingCollection } from './registry.js'
export { withLookup } from './active.js'
// #650 Task 2 — the 'lookup' via binding + its three descriptor tiers.
export { lookup, enumOf, enumOf as enum, dict, type LookupDescriptor, type Vocabulary, type LookupBacking, type OnDelete } from './descriptor.js'
export { lookupBinding, linkLookupVia, type LookupViaConfig } from './binding.js'
// #650 Task 7 — the describeFragment payload shape (first-ever consumer: with-shape/introspection/describe.ts).
export type { LookupDescribeFragment, LookupDescribeFragmentEntry } from './binding.js'
