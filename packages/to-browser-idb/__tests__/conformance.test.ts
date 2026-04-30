import { runStoreConformanceTests } from '@noy-db/test-adapter-conformance'
import { IDBFactory } from 'fake-indexeddb'
import { browserIdbStore } from '../src/index.js'

let counter = 0

// Run conformance suite against IndexedDB backend.
// Each factory call gets a fresh IDBFactory instance so databases
// are fully isolated between test runs.
runStoreConformanceTests(
  'store-browser-idb',
  async () => {
    // Replace the global with a fresh factory so the adapter's dbPromise
    // caches don't bleed between test runs.
    ;(globalThis as unknown as Record<string, unknown>).indexedDB = new IDBFactory()
    return browserIdbStore({ prefix: `test-${++counter}` })
  },
  async () => {
    // Reset to a fresh factory so the next factory call starts clean
    ;(globalThis as unknown as Record<string, unknown>).indexedDB = new IDBFactory()
  },
)
