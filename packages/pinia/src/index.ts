/**
 * @noy-db/pinia — Pinia integration for noy-db.
 *
 * Public API:
 *   - `defineNoydbStore<T>(id, options)` — drop-in defineStore that wires
 *     a Pinia store to a NOYDB compartment + collection
 *   - `setActiveNoydb(instance)` — bind a Noydb instance globally so stores
 *     don't have to pass `noydb:` explicitly
 *   - `getActiveNoydb()` — read the globally bound instance
 *
 * The augmentation plugin (`createNoydbPiniaPlugin`) lands in #11.
 */

export { defineNoydbStore } from './defineNoydbStore.js'
export type { NoydbStoreOptions, NoydbStore } from './defineNoydbStore.js'
export { setActiveNoydb, getActiveNoydb, resolveNoydb } from './context.js'
