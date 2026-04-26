/**
 * Strategy seam for the optional i18n (multi-locale + dictionary)
 * subsystem. Core imports `I18nStrategy` type-only + `NO_I18N` stub;
 * real `applyI18nLocale` / `validateI18nTextValue` /
 * `DictionaryHandle` are only reachable via `withI18n()` in
 * `./active.ts`.
 *
 * Solo apps that don't use `i18nText()` fields, don't declare
 * `dictKey()` fields, and don't open a `vault.dictionary(...)` handle
 * ship none of the ~854 LOC behind this seam.
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

import type { NoydbStore } from '../types.js'
import type { LedgerStore } from '../history/ledger/store.js'
import type { UnlockedKeyring } from '../team/keyring.js'
import type { NoydbEventEmitter } from '../events.js'
import type { I18nTextDescriptor } from './core.js'
import type { DictionaryHandle, DictionaryOptions } from './dictionary.js'

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
  getDEK: (collectionName: string) => Promise<CryptoKey>
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
  buildDictionaryHandle() { throw notEnabled('vault.dictionary()') },
}
