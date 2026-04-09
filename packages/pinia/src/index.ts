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
export type { NoydbStoreOptions, NoydbStore } from './defineNoydbStore.js'
export { setActiveNoydb, getActiveNoydb, resolveNoydb } from './context.js'
export { createNoydbPiniaPlugin } from './plugin.js'
export type { StoreNoydbOptions, NoydbPiniaPluginOptions } from './plugin.js'
