/**
 * @noy-db/pinia — Pinia integration for noy-db.
 *
 * Two adoption paths:
 *
 * 1. **Greenfield** — `defineNoydbStore<T>(id, options)` creates a new
 *    Pinia store fully wired to a NOYDB collection.
 *
 * 2. **Augmentation** — `createNoydbPiniaPlugin(options)` lets existing
 *    `defineStore()` stores opt into NOYDB persistence by adding one
 *    `noydb:` option, with no component code changes.
 *
 * Plus a global instance binding for both paths:
 *   - `setActiveNoydb(instance)` / `getActiveNoydb()` / `resolveNoydb()`
 */

export { defineNoydbStore } from './defineNoydbStore.js'
export type {
  NoydbStoreOptions,
  NoydbStore,
  NoydbLiveQuery,
} from './defineNoydbStore.js'
export { setActiveNoydb, getActiveNoydb, resolveNoydb } from './context.js'
export { useNoydbI18n } from './useNoydbI18n.js'
export type { LocaleSyncable, SetLocaleOptions } from './useNoydbI18n.js'
export { useI18nField } from './useI18nField.js'
export type { UseI18nFieldOptions } from './useI18nField.js'
export { useDictLabel } from './useDictLabel.js'
export type { UseDictLabelOptions } from './useDictLabel.js'
export { createNoydbPiniaPlugin } from './plugin.js'
export type { StoreNoydbOptions, NoydbPiniaPluginOptions } from './plugin.js'
export {
  useCapabilityGrant,
  CAPABILITY_REQUESTS_COLLECTION,
} from './useCapabilityGrant.js'
export type {
  UseCapabilityGrantOptions,
  UseCapabilityGrantReturn,
  CapabilityGrantState,
  CapabilityGrantRecord,
} from './useCapabilityGrant.js'
