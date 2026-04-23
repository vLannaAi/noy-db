/**
 * **@noy-db/to-memory** — in-memory store for NOYDB (testing and development).
 *
 * Backed by nested `Map` objects: `vault → collection → id → envelope`.
 * Data is lost when the process exits — this store is intentionally
 * non-persistent.
 *
 * ## When to use
 *
 * - **Unit tests** — fast, zero I/O, works in any environment.
 * - **In-memory caching layer** — pair with `routeStore` to keep a hot
 *   copy of frequently-read collections in memory while persisting to
 *   a durable backend.
 * - **REPL / prototyping** — explore the NOYDB API without setting up
 *   a backend.
 *
 * ## Capabilities
 *
 * | Capability | Value |
 * |---|---|
 * | `casAtomic` | `true` — Map operations are synchronous and inherently atomic |
 * | `txAtomic` | `true` — multi-record `tx()` applies every op in a single synchronous burst |
 * | `listVaults` | ✓ — iterates outer Map keys |
 * | `listPage` | ✓ — cursor-based pagination over sorted id list |
 * | `ping` | ✓ — always returns `true` |
 *
 * @packageDocumentation
 */

import type { NoydbStore, EncryptedEnvelope, VaultSnapshot, TxOp } from '@noy-db/hub'
import { ConflictError } from '@noy-db/hub'

/**
 * Create an in-memory adapter backed by nested Maps.
 * No persistence — data is lost when the process exits.
 * Intended for testing and development.
 */
export function memory(): NoydbStore {
  // vault -> collection -> id -> envelope
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()

  function getCollection(vault: string, collection: string): Map<string, EncryptedEnvelope> {
    let comp = store.get(vault)
    if (!comp) {
      comp = new Map()
      store.set(vault, comp)
    }
    let coll = comp.get(collection)
    if (!coll) {
      coll = new Map()
      comp.set(collection, coll)
    }
    return coll
  }

  return {
    name: 'memory',

    async get(vault, collection, id) {
      return store.get(vault)?.get(collection)?.get(id) ?? null
    },

    async put(vault, collection, id, envelope, expectedVersion) {
      const coll = getCollection(vault, collection)
      const existing = coll.get(id)

      if (expectedVersion !== undefined && existing) {
        if (existing._v !== expectedVersion) {
          throw new ConflictError(existing._v, `Version conflict: expected ${expectedVersion}, found ${existing._v}`)
        }
      }

      coll.set(id, envelope)
    },

    async delete(vault, collection, id) {
      store.get(vault)?.get(collection)?.delete(id)
    },

    async list(vault, collection) {
      const coll = store.get(vault)?.get(collection)
      return coll ? [...coll.keys()] : []
    },

    async loadAll(vault) {
      const comp = store.get(vault)
      const snapshot: VaultSnapshot = {}
      if (comp) {
        for (const [collName, coll] of comp) {
          if (collName.startsWith('_')) continue
          const records: Record<string, EncryptedEnvelope> = {}
          for (const [id, envelope] of coll) {
            records[id] = envelope
          }
          snapshot[collName] = records
        }
      }
      return snapshot
    },

    async saveAll(vault, data) {
      const comp = store.get(vault)
      if (comp) {
        for (const key of [...comp.keys()]) {
          if (!key.startsWith('_')) {
            comp.delete(key)
          }
        }
      }

      for (const [collName, records] of Object.entries(data)) {
        const coll = getCollection(vault, collName)
        for (const [id, envelope] of Object.entries(records)) {
          coll.set(id, envelope)
        }
      }
    },

    async ping() {
      return true
    },

    /**
     * Enumerate every top-level vault held by this in-memory
     * store. Used by `Noydb.listAccessibleVaults()` (v0.5 #63)
     * to get the universe of compartments before filtering down to
     * the ones the calling principal can unwrap.
     *
     * Returns the outer Map's keys directly — O(compartments) and
     * cheap. The result is intentionally unsorted; consumers that
     * want a stable order should sort themselves.
     */
    async listVaults() {
      return [...store.keys()]
    },

    /**
     * Multi-record atomic transaction (v0.16 #240).
     *
     * Validates every op's `expectedVersion` against the current Map
     * state, throws `ConflictError` on the first mismatch (nothing
     * written), then applies every put/delete in one synchronous burst
     * — the Map mutations are single-threaded in the JS event loop so
     * no concurrent writer can interleave. Truly atomic.
     */
    async tx(ops: readonly TxOp[]) {
      // Phase 1 — validate every expectedVersion against current state.
      // We read the state ONCE up front; subsequent ops that target the
      // same (vault, coll, id) see the same snapshot, matching the
      // atomicity guarantee callers expect from a storage-layer tx.
      for (const op of ops) {
        if (op.expectedVersion === undefined) continue
        const existing = store.get(op.vault)?.get(op.collection)?.get(op.id)
        const actual = existing?._v ?? 0
        if (actual !== op.expectedVersion) {
          throw new ConflictError(
            actual,
            `tx: ${op.vault}/${op.collection}/${op.id} expected v${op.expectedVersion}, found v${actual}`,
          )
        }
      }
      // Phase 2 — apply every op synchronously. No await between ops =
      // no interleave window.
      for (const op of ops) {
        if (op.type === 'put') {
          if (!op.envelope) {
            throw new Error(`tx: put op for ${op.id} is missing envelope`)
          }
          getCollection(op.vault, op.collection).set(op.id, op.envelope)
        } else {
          store.get(op.vault)?.get(op.collection)?.delete(op.id)
        }
      }
    },

    /**
     * Paginate over a collection. Cursor is a numeric offset (as a string)
     * into the sorted id list — same ordering on every call so pages are
     * stable across runs.
     *
     * The default `limit` is 100. Final page returns `nextCursor: null`.
     */
    async listPage(vault, collection, cursor, limit = 100) {
      const coll = store.get(vault)?.get(collection)
      if (!coll) return { items: [], nextCursor: null }

      // Sorted ids for stable pagination — Map preserves insertion order
      // but tests rely on lexicographic order across different inserts.
      const ids = [...coll.keys()].sort()
      const start = cursor ? parseInt(cursor, 10) : 0
      const end = Math.min(start + limit, ids.length)

      const items: Array<{ id: string; envelope: EncryptedEnvelope }> = []
      for (let i = start; i < end; i++) {
        const id = ids[i]!
        const envelope = coll.get(id)
        if (envelope) items.push({ id, envelope })
      }

      return {
        items,
        nextCursor: end < ids.length ? String(end) : null,
      }
    },
  }
}
