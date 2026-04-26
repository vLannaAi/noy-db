/**
 * **@noy-db/to-browser-local** — `localStorage`-backed NOYDB store.
 *
 * All data is stored under `localStorage` with keys of the form
 * `{prefix}:{vault}:{collection}:{id}`. CAS checks are synchronous and
 * inherently atomic within a single JS thread.
 *
 * ## When to use
 *
 * Use `@noy-db/to-browser-idb` for most browser applications — it supports
 * larger storage quotas and true atomic transactions. Prefer this store only
 * when IndexedDB is unavailable (rare) or when you need storage that survives
 * across `sessionStorage` clears but is inspectable without DevTools.
 *
 * ## Obfuscation mode
 *
 * Setting `obfuscate: true` replaces each key component with an FNV-1a hash
 * and XOR-encodes metadata (vault name, collection name, record ID, `_by`
 * attribution) so that the logical structure of the data is not visible to
 * browser extensions or DevTools. This is **not** encryption — the envelope
 * `_data` field is always AES-GCM ciphertext regardless of this setting.
 *
 * ## Capabilities
 *
 * | Capability | Value |
 * |---|---|
 * | `casAtomic` | `true` — synchronous single-threaded JS |
 * | `listPage` | ✓ — cursor-based pagination |
 * | `ping` | ✓ — round-trips a sentinel key |
 *
 * @packageDocumentation
 */

import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '@noy-db/hub'
import { ConflictError } from '@noy-db/hub'

/**
 * Options for `browserLocalStore()`.
 *
 * All NOYDB data is stored in `localStorage` under `{prefix}:{vault}:{collection}:{id}`.
 * Enable `obfuscate` to replace each path component with an FNV-1a hash and
 * XOR-encode metadata so vault/collection/record names are not visible to
 * browser extensions or DevTools inspecting `localStorage`.
 */
export interface BrowserLocalOptions {
  /** Storage key prefix. Default: 'noydb'. */
  prefix?: string
  /** Obfuscate storage keys so collection/record names are not readable. Default: false. */
  obfuscate?: boolean
}

/**
 * Create a localStorage-backed store adapter.
 *
 * Key scheme (normal):    `{prefix}:{vault}:{collection}:{id}`
 * Key scheme (obfuscated): `{prefix}:{hash}:{hash}:{hash}`
 *
 * StoreCapabilities:
 *   casAtomic: true  — localStorage ops are synchronous and inherently atomic
 *   auth: { kind: 'browser-origin', flow: 'implicit', required: false }
 */
export function browserLocalStore(options: BrowserLocalOptions = {}): NoydbStore {
  const prefix = options.prefix ?? 'noydb'
  const obfuscate = options.obfuscate ?? false
  const obfKey = obfuscate ? makeObfKey(prefix) : ''

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

function createLocalStorageAdapter(prefix: string, obfuscate: boolean, obfKey: string): NoydbStore {
  function key(vault: string, collection: string, id: string): string {
    return `${prefix}:${hashComponent(vault, obfuscate)}:${hashComponent(collection, obfuscate)}:${hashComponent(id, obfuscate)}`
  }

  function collectionPrefix(vault: string, collection: string): string {
    return `${prefix}:${hashComponent(vault, obfuscate)}:${hashComponent(collection, obfuscate)}:`
  }

  function compartmentPrefix(vault: string): string {
    return `${prefix}:${hashComponent(vault, obfuscate)}:`
  }

  return {
    name: 'browser:localStorage',

    async get(vault, collection, id) {
      const data = localStorage.getItem(key(vault, collection, id))
      if (!data) return null
      return unwrapValue(data, obfuscate, obfKey).envelope
    },

    async put(vault, collection, id, envelope, expectedVersion) {
      const k = key(vault, collection, id)

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

    async delete(vault, collection, id) {
      localStorage.removeItem(key(vault, collection, id))
    },

    async list(vault, collection) {
      const pfx = collectionPrefix(vault, collection)
      const ids: string[] = []
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)
        if (!k?.startsWith(pfx)) continue

        if (obfuscate) {
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

    async loadAll(vault) {
      const pfx = compartmentPrefix(vault)
      const snapshot: VaultSnapshot = {}

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

    async saveAll(vault, data) {
      for (const [collection, records] of Object.entries(data)) {
        for (const [id, envelope] of Object.entries(records)) {
          localStorage.setItem(
            key(vault, collection, id),
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
    async listPage(vault, collection, cursor, limit = 100) {
      const pfx = collectionPrefix(vault, collection)
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
