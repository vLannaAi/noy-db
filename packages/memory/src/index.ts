import type { NoydbAdapter, EncryptedEnvelope, CompartmentSnapshot } from '@noy-db/core'
import { ConflictError } from '@noy-db/core'

/**
 * Create an in-memory adapter backed by nested Maps.
 * No persistence — data is lost when the process exits.
 * Intended for testing and development.
 */
export function memory(): NoydbAdapter {
  // compartment -> collection -> id -> envelope
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()

  function getCollection(compartment: string, collection: string): Map<string, EncryptedEnvelope> {
    let comp = store.get(compartment)
    if (!comp) {
      comp = new Map()
      store.set(compartment, comp)
    }
    let coll = comp.get(collection)
    if (!coll) {
      coll = new Map()
      comp.set(collection, coll)
    }
    return coll
  }

  return {
    async get(compartment, collection, id) {
      return store.get(compartment)?.get(collection)?.get(id) ?? null
    },

    async put(compartment, collection, id, envelope, expectedVersion) {
      const coll = getCollection(compartment, collection)
      const existing = coll.get(id)

      if (expectedVersion !== undefined && existing) {
        if (existing._v !== expectedVersion) {
          throw new ConflictError(existing._v, `Version conflict: expected ${expectedVersion}, found ${existing._v}`)
        }
      }

      coll.set(id, envelope)
    },

    async delete(compartment, collection, id) {
      store.get(compartment)?.get(collection)?.delete(id)
    },

    async list(compartment, collection) {
      const coll = store.get(compartment)?.get(collection)
      return coll ? [...coll.keys()] : []
    },

    async loadAll(compartment) {
      const comp = store.get(compartment)
      const snapshot: CompartmentSnapshot = {}
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

    async saveAll(compartment, data) {
      const comp = store.get(compartment)
      if (comp) {
        for (const key of [...comp.keys()]) {
          if (!key.startsWith('_')) {
            comp.delete(key)
          }
        }
      }

      for (const [collName, records] of Object.entries(data)) {
        const coll = getCollection(compartment, collName)
        for (const [id, envelope] of Object.entries(records)) {
          coll.set(id, envelope)
        }
      }
    },

    async ping() {
      return true
    },
  }
}
