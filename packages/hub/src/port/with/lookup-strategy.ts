/**
 * Lookup strategy seam (#650 Task 1 — via-lookup extraction, phase D of the
 * Via port; precedent: `port/with/i18n-strategy.ts`). Lives on the `/with`
 * port (the one seam the kernel spine may import statically) so `Vault` can
 * reach the dict-registry pure helpers and the `LookupHandle`/`NO_LOOKUP`
 * types without a spine→`shape/` static import (Check 14 via-layering bans
 * that; `port/with/` is always allowed, Check 9's sanctioned exception).
 *
 * `kernel/vault.ts` imports ONLY this module for lookup — never
 * `shape/via-lookup/*` directly.
 *
 * This task (#650 Task 1) is a pure move: `Vault.dictionary()` still
 * constructs its handle through `i18nStrategy.buildDictionaryHandle`
 * (`port/with/i18n-strategy.ts`), which now internally delegates to
 * `withLookup().buildLookupHandle` (same handle, new home). `LookupStrategy`
 * / `NO_LOOKUP` / `isLookupCollectionName` here are the seam later phase-D
 * tasks bind `vault.collection()`'s lookup fields onto — unused by Task 1's
 * wiring, but their exact shapes are frozen now so later tasks don't
 * re-litigate them.
 */

import type { NoydbStore } from '../../kernel/types.js'
import type { LedgerStore } from '../../with-commit/history/ledger/store.js'
import type { UnlockedKeyring } from '../../with-party/team/keyring.js'
import type { NoydbEventEmitter } from '../../kernel/events.js'
import type { ViaCryptoCtx } from '../../kernel/via.js'
import type { LookupHandle, DictionaryOptions } from '../../shape/via-lookup/handle.js'
import {
  enforceStaticDictOnPut,
  resolveDictSource,
  updateReferencingRecords,
  resolveLabelFromMap,
  collectLookupDictCompat,
  lookupToStaticDictCompat,
  type DictReferencingCollection,
  type LookupDictCompat,
} from '../../shape/via-lookup/registry.js'
import type { LookupDescriptor } from '../../shape/via-lookup/descriptor.js'

/**
 * Backing options for `LookupStrategy.buildLookupHandle` — same shape as
 * `DictionaryOptions` (kept as a distinct alias since the "lookup" name is
 * the forward-looking one; `DictionaryOptions` stays the dict-tier name).
 */
export type LookupBackingOptions = DictionaryOptions

/**
 * Options accepted by `LookupStrategy.buildLookupHandle`. Mirrors the
 * `LookupHandle` constructor verbatim, plus the two choke-point
 * participation hooks (`onDirty`/`onRecordMutated`) #647 (Task 4) wires —
 * both `undefined` in this task (pure move, no new call sites).
 */
export interface BuildLookupHandleOptions<Keys extends string = string> {
  readonly adapter: NoydbStore
  readonly compartmentName: string
  readonly dimensionName: string
  readonly keyring: UnlockedKeyring
  /**
   * The `reservedEnvelopes('_dict_')` capability (#629 Task 4) — the
   * handle's sanctioned crypto door onto its `_dict_<name>` collection.
   * Bound by the Vault to its own `getDEK`, the same per-collection-name
   * DEK resolver every other collection uses.
   */
  readonly reservedEnvelopes: ReturnType<ViaCryptoCtx['reservedEnvelopes']>
  readonly encrypted: boolean
  readonly ledger: LedgerStore | undefined
  readonly options: LookupBackingOptions
  readonly findAndUpdateReferences:
    | ((dimension: string, oldKey: string, newKey: string) => Promise<void>)
    | undefined
  readonly emitter: NoydbEventEmitter
  /** #647 (Task 4) — choke-point participation hooks; undefined in this task (pure move). */
  readonly onDirty?: (collection: string, id: string, action: 'put' | 'delete', version: number) => Promise<void>
  readonly onRecordMutated?: (collection: string, id: string, action: 'put' | 'delete', version: number) => Promise<void>
  /**
   * Used by the active strategy to satisfy the generic-key parameter on the
   * returned handle. The NO_LOOKUP stub never reads it. Mirrors
   * `BuildDictionaryHandleOptions._keyMarker` (`port/with/i18n-strategy.ts`).
   */
  // marker generic — runtime sees no value
  _keyMarker?: Keys
}

export interface LookupStrategy {
  /**
   * Construct a typed `LookupHandle` for the named dimension. Throws under
   * `NO_LOOKUP`.
   */
  buildLookupHandle<Keys extends string = string>(
    opts: BuildLookupHandleOptions<Keys>,
  ): LookupHandle<Keys>
}

function notEnabled(op: string): Error {
  return new Error(
    `${op} requires the lookup strategy. Pass \`lookupStrategy: withLookup()\` to ` +
    '`createNoydb({ ... })` (import `withLookup` from `@noy-db/hub`\'s via-lookup module).',
  )
}

/**
 * No-lookup stub. Construction throws with an actionable pointer — mirrors
 * `NO_I18N.buildDictionaryHandle`.
 */
export const NO_LOOKUP: LookupStrategy = {
  buildLookupHandle() {
    throw notEnabled('vault.dictionary()')
  },
}

/** `_dict_*` (legacy dict tier) and `_lookup_*` (the phase-D reserved backing). */
export const LOOKUP_COLLECTION_PREFIXES = ['_dict_', '_lookup_'] as const

/** Return true when a collection name is a reserved lookup-backing collection. */
export function isLookupCollectionName(name: string): boolean {
  return LOOKUP_COLLECTION_PREFIXES.some((prefix) => name.startsWith(prefix))
}

// Re-exported pure registry helpers (#650 Task 1) — `kernel/vault.ts`'s
// thin delegators call these directly; small always-on functions, not
// behind the tree-shake seam (same bundling class as `isLookupCollectionName`
// above, just too large to duplicate inline like that one is).
export { enforceStaticDictOnPut, resolveDictSource, updateReferencingRecords }
export type { DictReferencingCollection }

// #650 Task 2 — the alias-equivalence bridge (`resolveLabelFromMap` +
// `collectLookupDictCompat`/`lookupToStaticDictCompat`) + the runtime
// brand/shape predicates `via-compose.ts` needs to route `'lookup'`-branded
// descriptors, mirroring `isI18nTextDescriptor`/`isDictKeyDescriptor` below.
export { resolveLabelFromMap, collectLookupDictCompat, lookupToStaticDictCompat }
export type { LookupDictCompat }

/** Runtime predicate for detecting a `LookupDescriptor` (any of the three tiers). */
export function isLookupDescriptor(x: unknown): x is LookupDescriptor {
  return (
    typeof x === 'object' &&
    x !== null &&
    (x as { _viaBrand?: unknown })._viaBrand === 'lookup'
  )
}

/** Runtime predicate for the bare enum tier (`backing:'static'`, no in-code `table` — no label source). */
export function isEnumDescriptor(x: unknown): x is LookupDescriptor {
  return isLookupDescriptor(x) && x.backing === 'static' && x.table === undefined
}

/**
 * Type-only re-exports — the kernel spine imports these descriptor/handle
 * types through the port instead of reaching into `shape/via-lookup/*` or
 * `shape/via-i18n/*` directly. `isolatedModules: true` erases these at
 * build time — no runtime coupling.
 */
export type { LookupHandle, DictEntry, DictionaryOptions } from '../../shape/via-lookup/handle.js'
export type { LookupDescriptor, Vocabulary, LookupBacking, OnDelete } from '../../shape/via-lookup/descriptor.js'
export type { LookupViaConfig } from '../../shape/via-lookup/binding.js'
export type { DictKeyDescriptor, StaticDictDescriptor } from '../../shape/via-i18n/dictionary.js'
