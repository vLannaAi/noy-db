/**
 * i18n strategy seam (#623 Task 7 — moved out of `shape/via-i18n/strategy.ts`
 * and `shape/via-i18n/dictionary.ts`, precedent: `port/with/lazy-strategy.ts`).
 * Lives on the `/with` port (the one seam the kernel spine may import
 * statically) so `Collection`/`Vault` can hold the `NO_I18N` default and the
 * two reserved-name/brand predicates without a spine→service static import.
 *
 * Core imports `I18nStrategy` type-only + `NO_I18N` stub; real
 * `applyI18nLocale` / `validateI18nTextValue` / `DictionaryHandle` are only
 * reachable via `withI18n()` in `shape/via-i18n/active.ts`.
 *
 * Solo apps that don't use `i18nText()` fields, don't declare `dictKey()`
 * fields, and don't open a `vault.dictionary(...)` handle ship none of the
 * ~854 LOC behind this seam.
 *
 * Behavior under NO_I18N:
 *
 * - **applyI18nLocale** — returns the record unchanged. Apps without
 *   any i18n descriptors never observe a difference; apps that
 *   *did* declare i18nText/dictKey fields without opting into the
 *   strategy still get raw values back (locale resolution silently
 *   skipped). The validators below ensure the misconfiguration is
 *   caught at write time instead.
 * - **validateI18nTextValue** — throws when called. Only fires when
 *   a collection declared `i18nFields`; if you declared the field,
 *   you must opt in.
 * - **buildDictionaryHandle** — throws when called. Only fires when
 *   user code calls `vault.dictionary(...)`.
 *
 * @internal
 */

import type { NoydbStore } from '../../kernel/types.js'
import type { LedgerStore } from '../../with-commit/history/ledger/store.js'
import type { UnlockedKeyring } from '../../with-party/team/keyring.js'
import type { NoydbEventEmitter } from '../../kernel/events.js'
import type { I18nTextDescriptor } from '../../shape/via-i18n/core.js'
import type { Layer } from '../../shape/via-i18n/policy.js'
import type { ScriptWarning } from '../../shape/via-i18n/script.js'
import type { DictKeyDescriptor, DictionaryHandle, DictionaryOptions, StaticDictDescriptor } from '../../shape/via-i18n/dictionary.js'
import type { EnclaveKey } from '../../kernel/enclave/index.js'

/**
 * Options accepted by `I18nStrategy.buildDictionaryHandle`. Mirrors
 * the `DictionaryHandle` constructor verbatim — kept here so core
 * code never imports the dictionary module at runtime.
 *
 * @internal
 */
export interface BuildDictionaryHandleOptions<Keys extends string = string> {
  adapter: NoydbStore
  compartmentName: string
  dictionaryName: string
  keyring: UnlockedKeyring
  getDEK: (collectionName: string) => Promise<EnclaveKey>
  encrypted: boolean
  ledger: LedgerStore | undefined
  options: DictionaryOptions
  findAndUpdateReferences:
    | ((
        dictionaryName: string,
        oldKey: string,
        newKey: string,
      ) => Promise<void>)
    | undefined
  emitter: NoydbEventEmitter
  /**
   * Used by the active strategy to satisfy the generic-key parameter
   * on the returned handle. The NO_I18N stub never reads it.
   */
  // marker generic — runtime sees no value
  _keyMarker?: Keys
}

/**
 * @internal
 */
export interface I18nStrategy {
  /**
   * Resolve `i18nText` fields on a record to the requested locale and
   * return a new object. Returns the input unchanged under
   * `NO_I18N`.
   */
  applyI18nLocale(
    record: Record<string, unknown>,
    fields: Record<string, I18nTextDescriptor>,
    locale: string,
    fallback?: string | readonly string[],
    layer?: Layer,
  ): Record<string, unknown>

  /**
   * Validate that an i18nText field's value satisfies its descriptor
   * (required locales present, etc.). Throws under `NO_I18N` —
   * declaring i18nFields without opting in is a misconfiguration.
   */
  validateI18nTextValue(
    value: unknown,
    field: string,
    descriptor: I18nTextDescriptor,
  ): void

  /**
   * Enforce per-locale script constraints over an i18nText value map
   * (write-time). Returns the (possibly filtered) value plus any
   * non-fatal warnings. Returns the value unchanged when the field has
   * no `script` option, or under `NO_I18N`.
   */
  enforceScript(
    value: Record<string, unknown>,
    field: string,
    descriptor: I18nTextDescriptor,
    exempt?: ReadonlySet<string>,
  ): { value: Record<string, unknown>; warnings: ScriptWarning[] }

  /**
   * Per-field locales that are unchanged round-tripped densify fills (exempt
   * from write-time script enforcement). Empty under NO_I18N.
   */
  computeExemptFills(
    prior: Record<string, unknown> | undefined,
    incoming: Record<string, unknown>,
    fields: Record<string, I18nTextDescriptor>,
  ): Map<string, Set<string>>

  /**
   * Eager-fill empty i18n slots from each field's substitute chain and record
   * provenance in `record['_i18nFilled']`. Mutates `record`. No-op under
   * NO_I18N.
   */
  densify(
    record: Record<string, unknown>,
    prior: Record<string, unknown> | undefined,
    fields: Record<string, I18nTextDescriptor>,
  ): void

  /**
   * Construct a typed `DictionaryHandle` for the named dictionary.
   * Throws under `NO_I18N`.
   */
  buildDictionaryHandle<Keys extends string = string>(
    opts: BuildDictionaryHandleOptions<Keys>,
  ): DictionaryHandle<Keys>
}

function notEnabled(op: string): Error {
  return new Error(
    `${op} requires the i18n strategy. Import ` +
    '`{ withI18n }` from "@noy-db/hub/i18n" and pass it to ' +
    '`createNoydb({ i18nStrategy: withI18n() })`.',
  )
}

/**
 * No-i18n stub. Locale resolution is the identity; validation and
 * dictionary construction throw with an actionable pointer.
 *
 * @internal
 */
export const NO_I18N: I18nStrategy = {
  applyI18nLocale(record) { return record },
  validateI18nTextValue() { throw notEnabled('i18nText field validation') },
  enforceScript(value) { return { value, warnings: [] } },
  computeExemptFills() { return new Map<string, Set<string>>() },
  densify() {},
  buildDictionaryHandle() { throw notEnabled('vault.dictionary()') },
}

/**
 * Return true when a collection name is a reserved dictionary collection
 * (the `_dict_*` prefix). Mirrors `DICT_COLLECTION_PREFIX` in
 * `shape/via-i18n/dictionary.ts` — duplicated here (not imported) so this
 * port has no VALUE dependency back on the feature; keep the two in sync if
 * the prefix ever changes.
 */
export function isDictCollectionName(name: string): boolean {
  return name.startsWith('_dict_')
}

/** Runtime predicate for detecting a StaticDictDescriptor. */
export function isStaticDictDescriptor(x: unknown): x is StaticDictDescriptor {
  return (
    typeof x === 'object' &&
    x !== null &&
    (x as { _noydbStaticDict?: unknown })._noydbStaticDict === true
  )
}

/**
 * Runtime predicate for detecting an I18nTextDescriptor. Pure tag check —
 * moved here (#623 Task 11) alongside `isStaticDictDescriptor` so
 * `kernel/via-compose.ts` (`mergeViaFields`'s descriptor-shape classification)
 * can reach it through the port instead of importing `shape/via-i18n/core.js`
 * directly. Re-exported from that module for compat with existing importers.
 */
export function isI18nTextDescriptor(x: unknown): x is I18nTextDescriptor {
  return (
    typeof x === 'object' &&
    x !== null &&
    (x as { _noydbI18nText?: unknown })._noydbI18nText === true
  )
}

/**
 * Runtime predicate for detecting a DictKeyDescriptor. Pure tag check —
 * moved here (#623 Task 11) for the same reason as `isI18nTextDescriptor`
 * above. Re-exported from `shape/via-i18n/dictionary.js` for compat with
 * existing importers.
 */
export function isDictKeyDescriptor(x: unknown): x is DictKeyDescriptor {
  return (
    typeof x === 'object' &&
    x !== null &&
    (x as { _noydbDictKey?: unknown })._noydbDictKey === true
  )
}

/**
 * Type-only re-exports (#623 Task 8) — the kernel spine (collection.ts,
 * collection-config.ts, vault.ts, types.ts) imports these descriptor/handle
 * types through the port instead of reaching into `shape/via-i18n/*`
 * directly, so `src/kernel/**` carries no via-i18n specifier at all.
 * `isolatedModules: true` erases these at build time — no runtime coupling.
 */
export type { I18nTextDescriptor } from '../../shape/via-i18n/core.js'
export type { DictKeyDescriptor, DictionaryHandle, DictionaryOptions, StaticDictDescriptor } from '../../shape/via-i18n/dictionary.js'
export type { Layer } from '../../shape/via-i18n/policy.js'
export type { ScriptWarning } from '../../shape/via-i18n/script.js'
