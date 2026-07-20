/**
 * Lookup strategy seam (#650 Task 1 — via-lookup extraction, phase D of the
 * Via port; precedent: `port/with/i18n-strategy.ts`). Lives on the `/with`
 * port (the one seam the kernel spine may import statically) so `Vault` can
 * reach the dict-registry pure helpers and the `LookupHandle`/`NO_LOOKUP`
 * types without a spine→`via/` static import (Check 14 via-layering bans
 * that; `port/with/` is always allowed, Check 9's sanctioned exception).
 *
 * `kernel/vault.ts` imports ONLY this module for lookup — never
 * `via/lookup/*` directly.
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

import type { NoydbStore, EncryptedEnvelope } from '../../kernel/types.js'
import type { LedgerStore } from '../../with-commit/history/ledger/store.js'
import type { UnlockedKeyring } from '../../with-party/team/keyring.js'
import type { NoydbEventEmitter } from '../../kernel/events.js'
import type { ViaCryptoCtx } from '../../kernel/via/index.js'
import type { LookupHandle, DictionaryOptions } from '../../via/lookup/handle.js'
import {
  enforceStaticDictOnPut,
  resolveDictSource,
  updateReferencingRecords,
  resolveLabelFromMap,
  collectLookupDictCompat,
  lookupToStaticDictCompat,
  reservedDictDepsOf,
  materializeBackingTable,
  checkLookupMembership,
  buildLookupAltIndex,
  registerLookupRefEdges,
  buildLookupSnapshotRows,
  coerceLookupKey,
  resolveBackingRowKey,
  matchesReferencingValue,
  type DictReferencingCollection,
  type LookupDictCompat,
  type MaterializedBacking,
} from '../../via/lookup/registry.js'
import { buildPresentForJoin } from '../../via/lookup/snapshot.js'
import type { LookupDescriptor } from '../../via/lookup/descriptor.js'

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
  /**
   * #647 fix wave 1 — mints a version-ordered delete-marker envelope. Bound by the Vault to the
   * real `kernel/enclave` `buildDeleteMarker` function — `LookupHandle` (`via/lookup/**`)
   * may not import `kernel/enclave/` itself (Check 11/15), so this capability is injected the
   * same way `reservedEnvelopes` above is.
   */
  readonly buildDeleteMarker: (version: number, actor: string) => EncryptedEnvelope
  /** #650 Task 4 (#647) — choke-point participation hooks. */
  readonly onDirty?: ((collection: string, id: string, action: 'put' | 'delete', version: number) => Promise<void>) | undefined
  readonly onRecordMutated?: ((collection: string, id: string, action: 'put' | 'delete', version: number) => Promise<void>) | undefined
  /**
   * #650 Task 5 (#648) — the real reference check `LookupHandle.delete()`'s strict branch calls:
   * restrict throws `DictKeyInUseError` naming the referencing collection, cascade/nullify apply
   * their propagation. Bound by the Vault (never a `Collection`/keyring/DEK reach-around); a
   * no-op when the dimension has no declared lookup-referencing edges (today's dangling behavior
   * for undeclared refs is unaffected). Return value is discarded by the handle — callers who
   * need cascade/nullify counts (forget) go through `VaultLinks` directly.
   */
  readonly checkReferencesOnDelete?: ((key: string) => Promise<unknown>) | undefined
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
    `${op}: the NO_LOOKUP stub was reached, which should be unreachable today — there is no ` +
    '`lookupStrategy` `createNoydb({ ... })` option yet to select this stub over the real one; ' +
    '`vault.dictionary()` always resolves through `withLookup()` (see `via/i18n/active.ts`\'s ' +
    'delegation). This is forward scaffolding for a later task (mirrors `NO_I18N`\'s shape) — if you ' +
    'hit this, it indicates a bug, not a missing opt-in.',
  )
}

/**
 * No-lookup stub. Mirrors `NO_I18N.buildDictionaryHandle`'s shape, but unlike `NO_I18N` (wired as
 * `vault.ts`'s `opts.i18nStrategy ?? NO_I18N` default), nothing selects this stub today — there is
 * no `lookupStrategy` option on `createNoydb()`; `vault.dictionary()`'s only construction path
 * (`Vault.i18nStrategy.buildDictionaryHandle` → `withLookup().buildLookupHandle`) never reaches
 * here. Kept as forward scaffolding for a later task that wires an independent lookup opt-in.
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

// #650 Task 4 (#647) — the reserved-collection naming helper `vault.ts`'s sync-registry
// bookkeeping needs (mapping a declared dimension name to its `_dict_<name>` collection name).
export { dictCollectionName } from '../../via/lookup/handle.js'

// #650 Task 2 — the alias-equivalence bridge (`resolveLabelFromMap` +
// `collectLookupDictCompat`/`lookupToStaticDictCompat`) + the runtime
// brand/shape predicates `via/compose.ts` needs to route `'lookup'`-branded
// descriptors, mirroring `isI18nTextDescriptor`/`isDictKeyDescriptor` below.
export { resolveLabelFromMap, collectLookupDictCompat, lookupToStaticDictCompat }
export type { LookupDictCompat }

// #653 — partial-sync reserved-dict expansion: maps a set of named collections to the
// one-hop `_dict_*` deps their lookup fields reference, off `dictKeyFieldRegistry`.
export { reservedDictDepsOf }

// #650 Task 3 — altKeys ingest normalization + open/closed vocabulary
// governance: the declare/warm-time altIndex builder + the membership test
// vault.ts's `membership`/`getAltIndex` closures delegate to.
export { materializeBackingTable, checkLookupMembership, buildLookupAltIndex }
export type { MaterializedBacking }

// #650 Task 5 — registers a collection's lookup-fields' cross-collection 'ref' graph edges.
export { registerLookupRefEdges }

// #650 Task 6 — the sync snapshot+locale seam (#626 retirement, spec §5):
// `snapshotFor`'s vault-built row source + the combined presentForJoin
// builder `kernel/collection-config.ts` calls to build the
// `JoinableSource.presentForJoin` hook `kernel/query/join.ts` consumes.
export { buildLookupSnapshotRows, buildPresentForJoin }
export type { LookupSnapshot } from '../../via/lookup/snapshot.js'

// #651 Task 3 — the ONE descriptor-keyed key-resolution core (guarded coercion +
// backing-row-key resolve + referencing-value match) — every consumer (vault.ts,
// with-shape/links/vault-facade.ts, kernel/via/dispatch.ts) routes through here,
// never a bare `String()`, ending the dm12 dialect drift.
export { coerceLookupKey, resolveBackingRowKey, matchesReferencingValue }

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
 * types through the port instead of reaching into `via/lookup/*` or
 * `via/i18n/*` directly. `isolatedModules: true` erases these at
 * build time — no runtime coupling.
 */
export type { LookupHandle, DictEntry, DictionaryOptions } from '../../via/lookup/handle.js'
export type { LookupDescriptor, Vocabulary, LookupBacking, OnDelete } from '../../via/lookup/descriptor.js'
export type { LookupViaConfig } from '../../via/lookup/binding.js'
export type { DictKeyDescriptor, StaticDictDescriptor } from '../../via/i18n/dictionary.js'
