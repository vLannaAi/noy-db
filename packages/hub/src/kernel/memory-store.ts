import type { NoydbStore, VaultSnapshot, EncryptedEnvelope, StoreTime, ListPageResult } from './types.js'
import { ConflictError } from './errors.js'

/**
 * Built-in in-memory store — the kernel's zero-config default.
 *
 * Nested `Map`s: `vault → collection → id → envelope`. Non-persistent
 * (data is lost on process exit). A conformant 6-method {@link NoydbStore}
 * with CAS atomicity and a monotonic store clock — the kernel version of
 * `@noy-db/to-memory`'s core, so `createNoydb()` works with no store package.
 *
 * Portable: imports only `types` + `errors` (no crypto primitive) — passes
 * the `stores-ciphertext-only` architecture guard.
 *
 * Implements the 6-method core only (no optional `listVaults`/`ping`/`tx`),
 * so `Noydb.listAccessibleVaults()` throws its documented capability error
 * rather than enumerating vaults under the default store.
 */
export function memoryStore(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  let clock = 0
  const epsilon = 0 // matches @noy-db/to-memory's default clockUncertainty; non-overlapping intervals

  const coll = (vault: string, collection: string): Map<string, EncryptedEnvelope> => {
    let comp = store.get(vault)
    if (!comp) { comp = new Map(); store.set(vault, comp) }
    let c = comp.get(collection)
    if (!c) { c = new Map(); comp.set(collection, c) }
    return c
  }

  return {
    name: 'memory',
    capabilities: { casAtomic: true, serverWriteTime: true, auth: { kind: 'none', required: false, flow: 'static' } },

    async getStoreTime(): Promise<StoreTime> {
      const now = ++clock
      return { earliest: now - epsilon, latest: now + epsilon }
    },

    async get(vault, collection, id) {
      return store.get(vault)?.get(collection)?.get(id) ?? null
    },

    async put(vault, collection, id, envelope, expectedVersion) {
      const c = coll(vault, collection)
      const existing = c.get(id)
      if (expectedVersion !== undefined && existing && existing._v !== expectedVersion) {
        throw new ConflictError(existing._v, `Version conflict: expected ${expectedVersion}, found ${existing._v}`)
      }
      c.set(id, envelope)
    },

    async delete(vault, collection, id) {
      store.get(vault)?.get(collection)?.delete(id)
    },

    async list(vault, collection) {
      const c = store.get(vault)?.get(collection)
      return c ? [...c.keys()] : []
    },

    async loadAll(vault): Promise<VaultSnapshot> {
      const comp = store.get(vault)
      const snapshot: VaultSnapshot = {}
      if (comp) {
        for (const [name, c] of comp) {
          if (name.startsWith('_')) continue // system collections hydrate lazily
          const records: Record<string, EncryptedEnvelope> = {}
          for (const [id, envelope] of c) records[id] = envelope
          snapshot[name] = records
        }
      }
      return snapshot
    },

    async saveAll(vault, data: VaultSnapshot) {
      const comp = store.get(vault)
      if (comp) for (const k of [...comp.keys()]) if (!k.startsWith('_')) comp.delete(k)
      for (const [name, records] of Object.entries(data)) {
        const c = coll(vault, name)
        for (const [id, envelope] of Object.entries(records)) c.set(id, envelope)
      }
    },

    async listPage(vault, collection, cursor, limit = 100): Promise<ListPageResult> {
      const c = store.get(vault)?.get(collection)
      if (!c) return { items: [], nextCursor: null }
      const ids = [...c.keys()].sort()
      const start = cursor ? parseInt(cursor, 10) : 0
      const end = Math.min(start + limit, ids.length)
      const items: Array<{ id: string; envelope: EncryptedEnvelope }> = []
      for (let i = start; i < end; i++) {
        const id = ids[i]!
        const envelope = c.get(id)
        if (envelope) items.push({ id, envelope })
      }
      return { items, nextCursor: end < ids.length ? String(end) : null }
    },
  }
}
