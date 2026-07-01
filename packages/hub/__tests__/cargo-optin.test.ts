/**
 * Gate test for the cargo capability (S4). The source-side, owner-level
 * partition operations that take a live Vault — `extractPartition(vault, …)`
 * and `diffVault(vault, …)` — throw `CargoNotEnabledError` unless
 * `cargoStrategy: withCargo()` is passed to createNoydb; opting in makes them
 * live.
 *
 * Carve-out (openSealedRecord/liberateVault mirror): the recipient-side
 * `adoptPartition` / `decryptExtractedPartition` free functions operate on raw
 * bundle bytes (no source instance) and stay ungated — not covered here.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, ConflictError, CargoNotEnabledError, withCargo } from '../src/index.js'
import { extractPartition } from '../src/with-cargo/extract-partition.js'
import { diffVault } from '../src/with-cargo/vault-diff.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/index.js'

interface Client { id: string; name: string }

function memory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const gc = (c: string, col: string): Map<string, EncryptedEnvelope> => {
    let comp = store.get(c); if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col); if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    name: 'memory',
    async get(c, col, id) { return store.get(c)?.get(col)?.get(id) ?? null },
    async put(c, col, id, env, ev) {
      const coll = gc(c, col); const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(c, col, id) { store.get(c)?.get(col)?.delete(id) },
    async list(c, col) { const coll = store.get(c)?.get(col); return coll ? [...coll.keys()] : [] },
    async loadAll(c) {
      const comp = store.get(c); const s: VaultSnapshot = {}
      if (comp) for (const [n, coll] of comp) if (!n.startsWith('_')) {
        const r: Record<string, EncryptedEnvelope> = {}; for (const [id, e] of coll) r[id] = e; s[n] = r
      }
      return s
    },
    async saveAll(c, data) {
      const comp = new Map<string, Map<string, EncryptedEnvelope>>()
      for (const [name, records] of Object.entries(data)) {
        const coll = new Map<string, EncryptedEnvelope>()
        for (const [id, env] of Object.entries(records)) coll.set(id, env)
        comp.set(name, coll)
      }
      const existing = store.get(c)
      if (existing) for (const [name, coll] of existing) if (name.startsWith('_')) comp.set(name, coll)
      store.set(c, comp)
    },
  }
}

describe('cargo opt-in gate (S4)', () => {
  it('throws CargoNotEnabledError for extractPartition / diffVault when not opted in', async () => {
    const db = await createNoydb({ store: memory(), user: 'alice', secret: 'test-passphrase-1234' })
    const v = await db.openVault('co')
    const clients = v.collection<Client>('clients')
    await clients.put('c-1', { id: 'c-1', name: 'Acme' })
    await expect(extractPartition(v, { seeds: { clients: (r) => r['id'] === 'c-1' } }))
      .rejects.toThrow(CargoNotEnabledError)
    await expect(diffVault(v, { clients: [{ id: 'c-1', name: 'Acme' }] }))
      .rejects.toThrow(CargoNotEnabledError)
  })

  it('works when opted in via withCargo()', async () => {
    const db = await createNoydb({ store: memory(), user: 'alice', secret: 'test-passphrase-1234', cargoStrategy: withCargo() })
    const v = await db.openVault('co')
    const clients = v.collection<Client>('clients')
    await clients.put('c-1', { id: 'c-1', name: 'Acme' })

    const extracted = await extractPartition(v, { seeds: { clients: (r) => r['id'] === 'c-1' } })
    expect(extracted.bundleBytes.byteLength).toBeGreaterThan(0)
    expect(extracted.transferKey.byteLength).toBe(32)

    const diff = await diffVault(v, { clients: [{ id: 'c-1', name: 'Acme' }] })
    expect(diff).toBeDefined()
  })
})
