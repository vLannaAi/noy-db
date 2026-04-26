import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'

// Polyfill IndexedDB for test environment (Node.js doesn't include it)
Object.assign(globalThis, { indexedDB: new IDBFactory(), IDBKeyRange })
