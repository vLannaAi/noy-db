import type { NoydbAdapter, EncryptedEnvelope, CompartmentSnapshot } from '@noy-db/core'
import { ConflictError } from '@noy-db/core'

export interface BrowserOptions {
  /** Storage key prefix. Default: 'noydb'. */
  prefix?: string
  /** Force a specific storage backend. Default: auto-detect. */
  backend?: 'localStorage' | 'indexedDB'
  /** Obfuscate storage keys so collection/record names are not readable. Default: false. */
  obfuscate?: boolean
}

/**
 * Create a browser storage adapter.
 * Uses localStorage for small datasets (<5MB) or IndexedDB for larger ones.
 *
 * Key scheme (normal):    `{prefix}:{compartment}:{collection}:{id}`
 * Key scheme (obfuscated): `{prefix}:{hash}:{hash}:{hash}`
 */
export function browser(options: BrowserOptions = {}): NoydbAdapter {
  const prefix = options.prefix ?? 'noydb'
  const obfuscate = options.obfuscate ?? false

  const obfKey = obfuscate ? makeObfKey(prefix) : ''

  const useIndexedDB = options.backend === 'indexedDB' ||
    (options.backend !== 'localStorage' && typeof indexedDB !== 'undefined')

  if (useIndexedDB && typeof indexedDB !== 'undefined') {
    return createIndexedDBAdapter(prefix, obfuscate, obfKey)
  }

  return createLocalStorageAdapter(prefix, obfuscate, obfKey)
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

function wrapValue(envelope: EncryptedEnvelope, collection: string, id: string, obfuscate: boolean, obfKey: string): string {
  if (!obfuscate) return JSON.stringify(envelope)

  // Encode plaintext metadata that could leak information
  let safeEnvelope = envelope

  // If _data is plaintext (e.g. keyring: _iv is empty), XOR-encode it
  if (!envelope._iv && envelope._data) {
    safeEnvelope = { ...safeEnvelope, _data: xorEncode(envelope._data, obfKey) }
  }

  // XOR-encode _by (user attribution) if present
  if (envelope._by) {
    safeEnvelope = { ...safeEnvelope, _by: xorEncode(envelope._by, obfKey) }
  }

  const stored: StoredValue = {
    _oi: xorEncode(id, obfKey),
    _oc: xorEncode(collection, obfKey),
    _e: safeEnvelope,
  }
  return JSON.stringify(stored)
}

function unwrapValue(raw: string, obfuscate: boolean, obfKey: string): { envelope: EncryptedEnvelope; origId: string; origCol: string } {
  const parsed = JSON.parse(raw) as StoredValue | EncryptedEnvelope
  if (!obfuscate || !('_e' in parsed)) {
    const env = parsed as EncryptedEnvelope
    return { envelope: env, origId: '', origCol: '' }
  }

  let envelope = parsed._e
  // Decode _data if it was XOR-encoded (keyring entries with empty _iv)
  if (!envelope._iv && envelope._data) {
    envelope = { ...envelope, _data: xorDecode(envelope._data, obfKey) }
  }
  // Decode _by if it was XOR-encoded
  if (envelope._by) {
    envelope = { ...envelope, _by: xorDecode(envelope._by, obfKey) }
  }

  return {
    envelope,
    origId: xorDecode(parsed._oi, obfKey),
    origCol: xorDecode(parsed._oc, obfKey),
  }
}

// ─── localStorage Backend ──────────────────────────────────────────────

function createLocalStorageAdapter(prefix: string, obfuscate: boolean, obfKey: string): NoydbAdapter {
  function key(compartment: string, collection: string, id: string): string {
    return `${prefix}:${hashComponent(compartment, obfuscate)}:${hashComponent(collection, obfuscate)}:${hashComponent(id, obfuscate)}`
  }

  function collectionPrefix(compartment: string, collection: string): string {
    return `${prefix}:${hashComponent(compartment, obfuscate)}:${hashComponent(collection, obfuscate)}:`
  }

  function compartmentPrefix(compartment: string): string {
    return `${prefix}:${hashComponent(compartment, obfuscate)}:`
  }

  return {
    name: 'browser:localStorage',

    async get(compartment, collection, id) {
      const data = localStorage.getItem(key(compartment, collection, id))
      if (!data) return null
      return unwrapValue(data, obfuscate, obfKey).envelope
    },

    async put(compartment, collection, id, envelope, expectedVersion) {
      const k = key(compartment, collection, id)

      if (expectedVersion !== undefined) {
        const existing = localStorage.getItem(k)
        if (existing) {
          const current = unwrapValue(existing, obfuscate, obfKey).envelope
          if (current._v !== expectedVersion) {
            throw new ConflictError(current._v, `Version conflict: expected ${expectedVersion}, found ${current._v}`)
          }
        }
      }

      localStorage.setItem(k, wrapValue(envelope, collection, id, obfuscate, obfKey))
    },

    async delete(compartment, collection, id) {
      localStorage.removeItem(key(compartment, collection, id))
    },

    async list(compartment, collection) {
      const pfx = collectionPrefix(compartment, collection)
      const ids: string[] = []
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)
        if (!k?.startsWith(pfx)) continue

        if (obfuscate) {
          // Read stored value to get original ID
          const raw = localStorage.getItem(k)
          if (raw) {
            const { origId } = unwrapValue(raw, true, obfKey)
            ids.push(origId)
          }
        } else {
          ids.push(k.slice(pfx.length))
        }
      }
      return ids
    },

    async loadAll(compartment) {
      const pfx = compartmentPrefix(compartment)
      const snapshot: CompartmentSnapshot = {}

      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)
        if (!k?.startsWith(pfx)) continue

        const raw = localStorage.getItem(k)
        if (!raw) continue

        let collection: string
        let id: string

        if (obfuscate) {
          const { envelope, origId, origCol } = unwrapValue(raw, true, obfKey)
          if (origCol.startsWith('_')) continue
          collection = origCol
          id = origId
          if (!snapshot[collection]) snapshot[collection] = {}
          snapshot[collection]![id] = envelope
        } else {
          const rest = k.slice(pfx.length)
          const colonIdx = rest.indexOf(':')
          if (colonIdx < 0) continue
          collection = rest.slice(0, colonIdx)
          id = rest.slice(colonIdx + 1)
          if (collection.startsWith('_')) continue
          if (!snapshot[collection]) snapshot[collection] = {}
          snapshot[collection]![id] = JSON.parse(raw) as EncryptedEnvelope
        }
      }

      return snapshot
    },

    async saveAll(compartment, data) {
      for (const [collection, records] of Object.entries(data)) {
        for (const [id, envelope] of Object.entries(records)) {
          localStorage.setItem(
            key(compartment, collection, id),
            wrapValue(envelope, collection, id, obfuscate, obfKey),
          )
        }
      }
    },

    async ping() {
      try {
        const testKey = `${prefix}:__ping__`
        localStorage.setItem(testKey, '1')
        localStorage.removeItem(testKey)
        return true
      } catch {
        return false
      }
    },

    /**
     * Paginate over a collection. Cursor is a numeric offset (as a string)
     * into the sorted localStorage key list. Sorting by key gives stable
     * ordering across page fetches even when other code is mutating
     * unrelated keys in the same prefix.
     *
     * Note: localStorage's `length` and `key(i)` are O(N) per call in some
     * browsers, so listing the matching keys upfront is faster than
     * iterating in slices.
     */
    async listPage(compartment, collection, cursor, limit = 100) {
      const pfx = collectionPrefix(compartment, collection)
      const matchedKeys: string[] = []
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)
        if (k?.startsWith(pfx)) matchedKeys.push(k)
      }
      matchedKeys.sort()

      const start = cursor ? parseInt(cursor, 10) : 0
      const end = Math.min(start + limit, matchedKeys.length)

      const items: Array<{ id: string; envelope: EncryptedEnvelope }> = []
      for (let i = start; i < end; i++) {
        const k = matchedKeys[i]!
        const raw = localStorage.getItem(k)
        if (!raw) continue
        const { envelope, origId } = unwrapValue(raw, obfuscate, obfKey)
        const id = obfuscate ? origId : k.slice(pfx.length)
        items.push({ id, envelope })
      }

      return {
        items,
        nextCursor: end < matchedKeys.length ? String(end) : null,
      }
    },
  }
}

// ─── IndexedDB Backend ─────────────────────────────────────────────────

function createIndexedDBAdapter(prefix: string, obfuscate: boolean, obfKey: string): NoydbAdapter {
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

  function key(compartment: string, collection: string, id: string): string {
    return `${hashComponent(compartment, obfuscate)}:${hashComponent(collection, obfuscate)}:${hashComponent(id, obfuscate)}`
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

    async get(compartment, collection, id) {
      const { store } = await tx('readonly')
      const raw = await idbRequest(store.get(key(compartment, collection, id)))
      if (!raw) return null
      if (obfuscate && typeof raw === 'object' && '_e' in (raw as StoredValue)) {
        return (raw as StoredValue)._e
      }
      return raw as EncryptedEnvelope
    },

    async put(compartment, collection, id, envelope, expectedVersion) {
      const k = key(compartment, collection, id)

      if (expectedVersion !== undefined) {
        const { store: readStore } = await tx('readonly')
        const existing = await idbRequest(readStore.get(k))
        if (existing) {
          const env = obfuscate && '_e' in (existing as StoredValue) ? (existing as StoredValue)._e : existing as EncryptedEnvelope
          if (env._v !== expectedVersion) {
            throw new ConflictError(env._v, `Version conflict: expected ${expectedVersion}, found ${env._v}`)
          }
        }
      }

      const value = obfuscate ? { _oi: xorEncode(id, obfKey), _oc: xorEncode(collection, obfKey), _e: envelope } : envelope
      const { store, complete } = await tx('readwrite')
      store.put(value, k)
      await complete
    },

    async delete(compartment, collection, id) {
      const { store, complete } = await tx('readwrite')
      store.delete(key(compartment, collection, id))
      await complete
    },

    async list(compartment, collection) {
      const pfx = `${hashComponent(compartment, obfuscate)}:${hashComponent(collection, obfuscate)}:`
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

    async loadAll(compartment) {
      const pfx = `${hashComponent(compartment, obfuscate)}:`
      const { store } = await tx('readonly')
      const allKeys = await idbRequest(store.getAllKeys()) as string[]
      const snapshot: CompartmentSnapshot = {}

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

    async saveAll(compartment, data) {
      const { store, complete } = await tx('readwrite')
      for (const [collection, records] of Object.entries(data)) {
        for (const [id, envelope] of Object.entries(records)) {
          const value = obfuscate ? { _oi: xorEncode(id, obfKey), _oc: xorEncode(collection, obfKey), _e: envelope } : envelope
          store.put(value, key(compartment, collection, id))
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
     * the v0.3 build target).
     */
    async listPage(compartment, collection, cursor, limit = 100) {
      const pfx = `${hashComponent(compartment, obfuscate)}:${hashComponent(collection, obfuscate)}:`
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
