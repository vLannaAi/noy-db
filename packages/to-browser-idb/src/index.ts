/**
 * **@noy-db/to-browser-idb** — IndexedDB-backed NOYDB store.
 *
 * The recommended browser store. Uses a single IndexedDB database
 * (`{prefix}_noydb`) with one object store (`records`). Composite string
 * keys (`{vault}:{collection}:{id}`) avoid the need for complex indexes.
 *
 * ## Why IndexedDB over localStorage
 *
 * - **Larger quota** — typically 50–80% of available disk vs. localStorage's
 *   5 MB hard cap.
 * - **True atomic CAS** — the compare-and-swap check and write happen inside
 *   a single `readwrite` IDB transaction, so concurrent writes from two tabs
 *   cannot interleave. (`casAtomic: true`.)
 * - **Async API** — doesn't block the main thread during large reads.
 *
 * ## Obfuscation mode
 *
 * Identical to `@noy-db/to-browser-local` — FNV-1a hashed keys + XOR-encoded
 * metadata. Envelope `_data` is always AES-GCM ciphertext regardless of this
 * setting.
 *
 * ## Capabilities
 *
 * | Capability | Value |
 * |---|---|
 * | `casAtomic` | `true` — single readwrite IDB transaction per put |
 * | `listPage` | ✓ — cursor-based pagination via `getAllKeys()` |
 * | `ping` | ✓ — `openDB()` round-trip |
 *
 * @packageDocumentation
 */

import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '@noy-db/hub'
import { ConflictError } from '@noy-db/hub'

/**
 * Options for `browserIdbStore()`.
 *
 * All NOYDB data is stored in a single IndexedDB database named
 * `{prefix}_noydb`, using composite string keys of the form
 * `{vault}:{collection}:{id}`. CAS checks and writes happen inside a
 * single `readwrite` IDB transaction, giving true atomic compare-and-swap
 * (`casAtomic: true`). Enable `obfuscate` to hash key components and
 * XOR-encode metadata — same obfuscation model as `browserLocalStore`.
 */
export interface BrowserIdbOptions {
  /** Storage key prefix. Default: 'noydb'. */
  prefix?: string
  /** Obfuscate storage keys so collection/record names are not readable. Default: false. */
  obfuscate?: boolean
}

/**
 * Create an IndexedDB-backed store adapter.
 *
 * Key scheme (normal):    `{vault}:{collection}:{id}`
 * Key scheme (obfuscated): `{hash}:{hash}:{hash}`
 *
 * StoreCapabilities:
 *   casAtomic: true  — CAS check + write happen inside a single readwrite IDB transaction
 *   auth: { kind: 'browser-origin', flow: 'implicit', required: false }
 */
export function browserIdbStore(options: BrowserIdbOptions = {}): NoydbStore {
  const prefix = options.prefix ?? 'noydb'
  const obfuscate = options.obfuscate ?? false
  const obfKey = obfuscate ? makeObfKey(prefix) : ''

  return createIndexedDBAdapter(prefix, obfuscate, obfKey)
}

// ─── Key Obfuscation ───────────────────────────────────────────────────

/**
 * FNV-1a 32-bit hash → 8-char hex string.
 * Not cryptographic — just makes keys opaque to casual inspection.
 */
function fnv1a(str: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function hashComponent(value: string, obfuscate: boolean): string {
  return obfuscate ? fnv1a(value) : value
}

// ─── XOR Encode/Decode (makes metadata unreadable in storage) ──────────

/** XOR-encode a string with a repeating key, return base64. */
function xorEncode(plaintext: string, key: string): string {
  const bytes = new TextEncoder().encode(plaintext)
  const keyBytes = new TextEncoder().encode(key)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = bytes[i]! ^ keyBytes[i % keyBytes.length]!
  }
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!)
  }
  return btoa(binary)
}

/** Decode a base64 XOR-encoded string. */
function xorDecode(encoded: string, key: string): string {
  const binary = atob(encoded)
  const bytes = new Uint8Array(binary.length)
  const keyBytes = new TextEncoder().encode(key)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i) ^ keyBytes[i % keyBytes.length]!
  }
  return new TextDecoder().decode(bytes)
}

/** Stored value wraps envelope + encoded original key parts. */
interface StoredValue {
  /** Encoded original record ID. */
  _oi: string
  /** Encoded original collection name. */
  _oc: string
  /** The encrypted envelope. */
  _e: EncryptedEnvelope
}

function makeObfKey(prefix: string): string {
  return prefix + ':noydb-obf-key'
}

// ─── IndexedDB Backend ─────────────────────────────────────────────────

function createIndexedDBAdapter(prefix: string, obfuscate: boolean, obfKey: string): NoydbStore {
  const DB_NAME = `${prefix}_noydb`
  const STORE_NAME = 'records'
  let dbPromise: Promise<IDBDatabase> | null = null

  function openDB(): Promise<IDBDatabase> {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1)
        request.onupgradeneeded = () => {
          const db = request.result
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            db.createObjectStore(STORE_NAME)
          }
        }
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
    }
    return dbPromise
  }

  function key(vault: string, collection: string, id: string): string {
    return `${hashComponent(vault, obfuscate)}:${hashComponent(collection, obfuscate)}:${hashComponent(id, obfuscate)}`
  }

  function tx(mode: IDBTransactionMode): Promise<{ store: IDBObjectStore; complete: Promise<void> }> {
    return openDB().then(db => {
      const transaction = db.transaction(STORE_NAME, mode)
      const store = transaction.objectStore(STORE_NAME)
      const complete = new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error)
      })
      return { store, complete }
    })
  }

  function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  }

  return {
    name: 'browser:indexedDB',

    async get(vault, collection, id) {
      const { store } = await tx('readonly')
      const raw = await idbRequest(store.get(key(vault, collection, id)))
      if (!raw) return null
      if (obfuscate && typeof raw === 'object' && '_e' in (raw as StoredValue)) {
        return (raw as StoredValue)._e
      }
      return raw as EncryptedEnvelope
    },

    async put(vault, collection, id, envelope, expectedVersion) {
      const k = key(vault, collection, id)

      const { store, complete } = await tx('readwrite')
      if (expectedVersion !== undefined) {
        const existing = await idbRequest(store.get(k))
        if (existing) {
          const env = obfuscate && '_e' in (existing as StoredValue) ? (existing as StoredValue)._e : existing as EncryptedEnvelope
          if (env._v !== expectedVersion) {
            throw new ConflictError(env._v, `Version conflict: expected ${expectedVersion}, found ${env._v}`)
          }
        }
      }

      const value = obfuscate ? { _oi: xorEncode(id, obfKey), _oc: xorEncode(collection, obfKey), _e: envelope } : envelope
      store.put(value, k)
      await complete
    },

    async delete(vault, collection, id) {
      const { store, complete } = await tx('readwrite')
      store.delete(key(vault, collection, id))
      await complete
    },

    async list(vault, collection) {
      const pfx = `${hashComponent(vault, obfuscate)}:${hashComponent(collection, obfuscate)}:`
      const { store } = await tx('readonly')
      const allKeys = await idbRequest(store.getAllKeys()) as string[]

      if (!obfuscate) {
        return allKeys
          .filter(k => typeof k === 'string' && k.startsWith(pfx))
          .map(k => k.slice(pfx.length))
      }

      // Obfuscated: need to read values for original IDs
      const ids: string[] = []
      for (const k of allKeys) {
        if (typeof k !== 'string' || !k.startsWith(pfx)) continue
        const raw = await idbRequest(store.get(k))
        if (raw && typeof raw === 'object' && '_oi' in (raw as StoredValue)) {
          ids.push(xorDecode((raw as StoredValue)._oi, obfKey))
        }
      }
      return ids
    },

    async loadAll(vault) {
      const pfx = `${hashComponent(vault, obfuscate)}:`
      const { store } = await tx('readonly')
      const allKeys = await idbRequest(store.getAllKeys()) as string[]
      const snapshot: VaultSnapshot = {}

      for (const k of allKeys) {
        if (typeof k !== 'string' || !k.startsWith(pfx)) continue

        const raw = await idbRequest(store.get(k))
        if (!raw) continue

        let collection: string
        let id: string
        let envelope: EncryptedEnvelope

        if (obfuscate && typeof raw === 'object' && '_e' in (raw as StoredValue)) {
          const stored = raw as StoredValue
          collection = xorDecode(stored._oc, obfKey)
          id = xorDecode(stored._oi, obfKey)
          envelope = stored._e
        } else {
          const rest = k.slice(pfx.length)
          const colonIdx = rest.indexOf(':')
          if (colonIdx < 0) continue
          collection = rest.slice(0, colonIdx)
          id = rest.slice(colonIdx + 1)
          envelope = raw as EncryptedEnvelope
        }

        if (collection.startsWith('_')) continue
        if (!snapshot[collection]) snapshot[collection] = {}
        snapshot[collection]![id] = envelope
      }

      return snapshot
    },

    async saveAll(vault, data) {
      const { store, complete } = await tx('readwrite')
      for (const [collection, records] of Object.entries(data)) {
        for (const [id, envelope] of Object.entries(records)) {
          const value = obfuscate ? { _oi: xorEncode(id, obfKey), _oc: xorEncode(collection, obfKey), _e: envelope } : envelope
          store.put(value, key(vault, collection, id))
        }
      }
      await complete
    },

    async ping() {
      try {
        await openDB()
        return true
      } catch {
        return false
      }
    },

    /**
     * Paginate over a collection backed by IndexedDB.
     *
     * Strategy: read every key in the prefix once (sorted), then slice
     * by cursor offset. IndexedDB's `getAllKeys()` returns sorted keys
     * efficiently for the modern browsers we target (Chrome 87+,
     * Firefox 78+, Safari 14+, Edge 88+ — same baseline as the rest of
     * the build target).
     */
    async listPage(vault, collection, cursor, limit = 100) {
      const pfx = `${hashComponent(vault, obfuscate)}:${hashComponent(collection, obfuscate)}:`
      const { store } = await tx('readonly')
      const allKeys = await idbRequest(store.getAllKeys()) as string[]
      const matchedKeys = allKeys
        .filter(k => typeof k === 'string' && k.startsWith(pfx))
        .sort()

      const start = cursor ? parseInt(cursor, 10) : 0
      const end = Math.min(start + limit, matchedKeys.length)

      const items: Array<{ id: string; envelope: EncryptedEnvelope }> = []
      for (let i = start; i < end; i++) {
        const k = matchedKeys[i]!
        const raw = await idbRequest(store.get(k))
        if (!raw) continue

        let envelope: EncryptedEnvelope
        let id: string
        if (obfuscate && typeof raw === 'object' && '_e' in (raw as StoredValue)) {
          const stored = raw as StoredValue
          envelope = stored._e
          id = xorDecode(stored._oi, obfKey)
        } else {
          envelope = raw as EncryptedEnvelope
          id = k.slice(pfx.length)
        }
        items.push({ id, envelope })
      }

      return {
        items,
        nextCursor: end < matchedKeys.length ? String(end) : null,
      }
    },
  }
}
