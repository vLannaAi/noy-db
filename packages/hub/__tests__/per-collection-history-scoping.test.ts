// Per-collection history / tamper-ledger scoping (#361).
//
// `withHistory()` enables per-record snapshots AND the hash-chained tamper
// ledger vault-wide. These tests cover the per-collection override that lets a
// caller confine snapshots + tamper-evidence to the collections where they
// carry weight (e.g. RD-filed legal records) without paying snapshot +
// ledger-entry-per-write across operational / derived collections.
//
//   • `historyConfig: { enabled: false }`  → no per-record snapshots
//   • `historyConfig: { ledger: false }`   → no ledger entries (chain stays valid)
//   • the override scopes to that collection only; siblings are unaffected

import { describe, it, expect, beforeEach } from 'vitest'
import { createNoydb } from '../src/noydb.js'
import type { Noydb } from '../src/noydb.js'
import { withHistory } from '../src/with-commit/history/index.js'
import { ConflictError } from '../src/errors.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/types.js'

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
      for (const [name, records] of Object.entries(data)) {
        const coll = getCollection(c, name)
        for (const [id, env] of Object.entries(records)) coll.set(id, env)
      }
    },
  }
}

interface Rec { id: string; v: number }

describe('per-collection history scoping (#361)', () => {
  let db: Noydb

  beforeEach(async () => {
    db = await createNoydb({
      store: memory(),
      user: 'owner-01',
      historyStrategy: withHistory(),
      encrypt: false,
      history: { enabled: true },
    })
  })

  describe('part 1 — per-collection historyConfig (snapshots)', () => {
    it('historyConfig.enabled:false suppresses snapshots for that collection only', async () => {
      const vault = await db.openVault('co')
      const legal = vault.collection<Rec>('legal')
      const ops = vault.collection<Rec>('ops', { historyConfig: { enabled: false } })

      // two puts each → a default collection records one snapshot per record
      await legal.put('a', { id: 'a', v: 1 })
      await legal.put('a', { id: 'a', v: 2 })
      await ops.put('b', { id: 'b', v: 1 })
      await ops.put('b', { id: 'b', v: 2 })

      expect(await legal.history('a')).toHaveLength(1)
      expect(await ops.history('b')).toHaveLength(0)
    })

    it('a per-call historyConfig overrides the vault-wide config wholesale', async () => {
      // vault-wide enabled:true, but this collection opts out
      const vault = await db.openVault('co')
      const ops = vault.collection<Rec>('ops', { historyConfig: { enabled: false } })
      await ops.put('b', { id: 'b', v: 1 })
      await ops.put('b', { id: 'b', v: 2 })
      expect(await ops.history('b')).toHaveLength(0)
    })
  })

  describe('part 2 — per-collection ledger opt-out', () => {
    it('historyConfig.ledger:false excludes the collection from the tamper chain', async () => {
      const vault = await db.openVault('co')
      const legal = vault.collection<Rec>('legal')
      const ops = vault.collection<Rec>('ops', { historyConfig: { ledger: false } })

      await legal.put('a', { id: 'a', v: 1 })
      await ops.put('b', { id: 'b', v: 1 })
      await ops.put('b', { id: 'b', v: 2 })
      await legal.put('a', { id: 'a', v: 2 })

      const entries = await vault.ledger().entries()
      // only legal's two writes appear; ops is absent entirely
      expect(entries).toHaveLength(2)
      expect(entries.every((e) => e.collection === 'legal')).toBe(true)
      expect(entries.some((e) => e.collection === 'ops')).toBe(false)
    })

    it('the chain still verifies after a collection opts out', async () => {
      const vault = await db.openVault('co')
      const legal = vault.collection<Rec>('legal')
      const ops = vault.collection<Rec>('ops', { historyConfig: { ledger: false } })

      await ops.put('b', { id: 'b', v: 1 })
      await legal.put('a', { id: 'a', v: 1 })
      await ops.delete('b')
      await legal.put('a', { id: 'a', v: 2 })

      const result = await vault.ledger().verify()
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.length).toBe(2) // both legal writes only
    })

    it('opting one collection out leaves siblings appending normally', async () => {
      const vault = await db.openVault('co')
      const a = vault.collection<Rec>('a')
      const b = vault.collection<Rec>('b', { historyConfig: { ledger: false } })
      const c = vault.collection<Rec>('c')

      await a.put('x', { id: 'x', v: 1 })
      await b.put('y', { id: 'y', v: 1 })
      await c.put('z', { id: 'z', v: 1 })

      const cols = (await vault.ledger().entries()).map((e) => e.collection).sort()
      expect(cols).toEqual(['a', 'c'])
    })

    it('ledger.entries() still works when an opted-out collection deletes', async () => {
      const vault = await db.openVault('co')
      const ops = vault.collection<Rec>('ops', { historyConfig: { ledger: false } })
      await ops.put('b', { id: 'b', v: 1 })
      await ops.delete('b')
      expect(await vault.ledger().entries()).toHaveLength(0)
    })
  })

  describe('combined — legal records auditable, operational collections quiet', () => {
    it('legal collection gets snapshots + ledger; operational gets neither', async () => {
      const vault = await db.openVault('firm')
      const receipts = vault.collection<Rec>('receipts') // default: full audit
      const scratch = vault.collection<Rec>('scratch', {
        historyConfig: { enabled: false, ledger: false },
      })

      await receipts.put('r1', { id: 'r1', v: 1 })
      await receipts.put('r1', { id: 'r1', v: 2 })
      await scratch.put('s1', { id: 's1', v: 1 })
      await scratch.put('s1', { id: 's1', v: 2 })

      expect(await receipts.history('r1')).toHaveLength(1)
      expect(await scratch.history('s1')).toHaveLength(0)

      const entries = await vault.ledger().entries()
      expect(entries.every((e) => e.collection === 'receipts')).toBe(true)
      expect(entries).toHaveLength(2)
    })
  })
})
