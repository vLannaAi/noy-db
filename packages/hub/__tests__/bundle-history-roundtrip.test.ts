/**
 * Bundle-includes-history round-trip tests.
 *
 * Regression guard for the consumer gap where `vault.dump()` / the `.noydb`
 * bundle excluded the `_history` collection: the ledger + deltas travelled,
 * but the full-snapshot version history did not — so on a restored vault
 * `collection.history()` / `getVersion()` / `diff()` saw none of the
 * pre-bundle versions (the Item-family history panel rendered empty).
 *
 * The fix is dump-side only: `dump()` now enumerates `_history` alongside
 * the ledger/schema/sequence/blob internals. `load()` already restores
 * `backup._internal` generically.
 *
 * Setup mirrors bundle-blobs-roundtrip.test.ts (realistic store whose
 * loadAll filters underscore collections) and verifiable-backup.test.ts
 * (dump/load + history + fresh-vault restore).
 */

import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { withHistory } from '../src/with-commit/history/index.js'
import { ConflictError } from '../src/kernel/errors.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'

// Realistic in-memory store: `loadAll` filters out underscore-prefixed
// (internal) collections, exactly like the real adapters — so dump()'s
// explicit enumeration of `_history` is what makes it travel.
function memory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function getCollection(c: string, col: string) {
    let comp = store.get(c)
    if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col)
    if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    name: 'memory',
    async get(c, col, id) { return store.get(c)?.get(col)?.get(id) ?? null },
    async put(c, col, id, env, ev) {
      const coll = getCollection(c, col)
      const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(c, col, id) { store.get(c)?.get(col)?.delete(id) },
    async list(c, col) { const coll = store.get(c)?.get(col); return coll ? [...coll.keys()] : [] },
    async loadAll(c) {
      const comp = store.get(c); const s: VaultSnapshot = {}
      if (comp) for (const [n, coll] of comp) {
        if (!n.startsWith('_')) {
          const r: Record<string, EncryptedEnvelope> = {}
          for (const [id, e] of coll) r[id] = e
          s[n] = r
        }
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
      if (existing) {
        for (const [name, coll] of existing) {
          if (name.startsWith('_')) comp.set(name, coll)
        }
      }
      store.set(c, comp)
    },
  }
}

const SECRET = 'correct-horse-battery-staple-long-enough'

interface Item { id: string; name: string; qty: number }

describe('bundle includes history (dump → load round-trip)', () => {
  it('history(), getVersion() and diff() survive dump → fresh-vault load', async () => {
    const sourceDb = await createNoydb({
      store: memory(), user: 'owner', secret: SECRET, historyStrategy: withHistory(),
    })
    const sourceVault = await sourceDb.openVault('demo-co')
    const col = sourceVault.collection<Item>('items')
    await col.put('i1', { id: 'i1', name: 'first', qty: 1 })
    await col.put('i1', { id: 'i1', name: 'renamed', qty: 1 })
    await col.put('i1', { id: 'i1', name: 'renamed', qty: 2 })
    // history() archives PREVIOUS versions; the current (v3) lives in the collection
    expect(await col.history('i1')).toHaveLength(2)

    const backupJson = await sourceVault.dump()
    // dump-side assertion: the _history collection travels in the bundle
    expect(JSON.parse(backupJson)._internal?._history).toBeDefined()

    const targetDb = await createNoydb({
      store: memory(), user: 'owner', secret: SECRET, historyStrategy: withHistory(),
    })
    const targetVault = await targetDb.openVault('demo-co')
    await targetVault.load(backupJson)
    const col2 = targetVault.collection<Item>('items')

    const entries = await col2.history('i1')
    expect(entries).toHaveLength(2) // newest first: v2, v1
    expect(entries[0]!.version).toBe(2)
    expect(entries[0]!.record.name).toBe('renamed')
    expect(entries[1]!.record.name).toBe('first')
    expect((await col2.getVersion('i1', 1))!.name).toBe('first')
    const changes = await col2.diff('i1', 1, 2)
    expect(changes).toEqual([{ path: 'name', type: 'changed', from: 'first', to: 'renamed' }])
    // versionB omitted → compare an archived version against the live current record
    const vsCurrent = await col2.diff('i1', 2)
    expect(vsCurrent).toEqual([{ path: 'qty', type: 'changed', from: 1, to: 2 }])
  })
})
