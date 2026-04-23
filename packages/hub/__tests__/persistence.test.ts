import { describe, it, expect, beforeEach } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/types.js'
import { ConflictError, InvalidKeyError } from '../src/errors.js'
import { createNoydb } from '../src/noydb.js'

/** Shared memory adapter — persists across createNoydb calls. */
function persistentMemory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function gc(c: string, col: string) {
    let comp = store.get(c); if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col); if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
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
      if (comp) for (const [n, coll] of comp) { if (!n.startsWith('_')) { const r: Record<string, EncryptedEnvelope> = {}; for (const [id, e] of coll) r[id] = e; s[n] = r } }
      return s
    },
    async saveAll(c, data) {
      for (const [n, recs] of Object.entries(data)) { const coll = gc(c, n); for (const [id, e] of Object.entries(recs)) coll.set(id, e) }
    },
  }
}

interface Invoice { amount: number; status: string }

describe('persistence round-trip (simulated page reload)', () => {
  const COMP = 'C101'
  const PASS = 'test-passphrase-2026'
  const USER = 'owner-01'

  it('second createNoydb with same adapter+passphrase loads existing keyring and reads records', async () => {
    const adapter = persistentMemory()

    // Session 1: create and write
    const db1 = await createNoydb({ store: adapter, user: USER, secret: PASS })
    const comp1 = await db1.openVault(COMP)
    await comp1.collection<Invoice>('invoices').put('inv-1', { amount: 5000, status: 'draft' })
    await comp1.collection<Invoice>('invoices').put('inv-2', { amount: 3000, status: 'paid' })
    db1.close()

    // Session 2: reopen with same credentials (simulates page reload)
    const db2 = await createNoydb({ store: adapter, user: USER, secret: PASS })
    const comp2 = await db2.openVault(COMP)
    const inv1 = await comp2.collection<Invoice>('invoices').get('inv-1')
    const inv2 = await comp2.collection<Invoice>('invoices').get('inv-2')

    expect(inv1).toEqual({ amount: 5000, status: 'draft' })
    expect(inv2).toEqual({ amount: 3000, status: 'paid' })
    db2.close()
  })

  it('second createNoydb with wrong passphrase throws InvalidKeyError', async () => {
    const adapter = persistentMemory()

    // Session 1: create keyring + add DEK via collection use
    const db1 = await createNoydb({ store: adapter, user: USER, secret: PASS })
    const comp1 = await db1.openVault(COMP)
    await comp1.collection<Invoice>('invoices').put('inv-1', { amount: 100, status: 'x' })
    db1.close()

    // Session 2: wrong passphrase — must throw, NOT silently create new keyring
    const db2 = await createNoydb({ store: adapter, user: USER, secret: 'wrong-passphrase' })
    await expect(db2.openVault(COMP)).rejects.toThrow(InvalidKeyError)
    db2.close()
  })

  it('third session after changeSecret uses new passphrase correctly', async () => {
    const adapter = persistentMemory()

    // Session 1: create and write
    const db1 = await createNoydb({ store: adapter, user: USER, secret: PASS })
    const comp1 = await db1.openVault(COMP)
    await comp1.collection<Invoice>('invoices').put('inv-1', { amount: 7000, status: 'sent' })
    await db1.changeSecret(COMP, 'new-passphrase')
    db1.close()

    // Session 2: old passphrase fails
    const db2 = await createNoydb({ store: adapter, user: USER, secret: PASS })
    await expect(db2.openVault(COMP)).rejects.toThrow()
    db2.close()

    // Session 3: new passphrase works and data is intact
    const db3 = await createNoydb({ store: adapter, user: USER, secret: 'new-passphrase' })
    const comp3 = await db3.openVault(COMP)
    const inv = await comp3.collection<Invoice>('invoices').get('inv-1')
    expect(inv).toEqual({ amount: 7000, status: 'sent' })
    db3.close()
  })

  it('count and list on fresh instance reflect adapter state', async () => {
    const adapter = persistentMemory()

    // Session 1
    const db1 = await createNoydb({ store: adapter, user: USER, secret: PASS })
    const comp1 = await db1.openVault(COMP)
    const invoices1 = comp1.collection<Invoice>('invoices')
    await invoices1.put('inv-1', { amount: 100, status: 'a' })
    await invoices1.put('inv-2', { amount: 200, status: 'b' })
    await invoices1.put('inv-3', { amount: 300, status: 'c' })
    await invoices1.delete('inv-2')
    db1.close()

    // Session 2: fresh instance must reflect the delete
    const db2 = await createNoydb({ store: adapter, user: USER, secret: PASS })
    const comp2 = await db2.openVault(COMP)
    const invoices2 = comp2.collection<Invoice>('invoices')
    const count = await invoices2.count()
    const list = await invoices2.list()
    expect(count).toBe(2)
    expect(list).toHaveLength(2)
    expect(list.find(i => i.status === 'b')).toBeUndefined()
    db2.close()
  })

  it('query() before await returns empty (documents sync cache dependency)', async () => {
    const adapter = persistentMemory()
    const db = await createNoydb({ store: adapter, user: USER, secret: PASS })
    const comp = await db.openVault(COMP)
    const invoices = comp.collection<Invoice>('invoices')
    await invoices.put('inv-1', { amount: 100, status: 'a' })
    db.close()

    // Fresh collection on same adapter — query before any await
    const db2 = await createNoydb({ store: adapter, user: USER, secret: PASS })
    const comp2 = await db2.openVault(COMP)
    const freshInvoices = comp2.collection<Invoice>('invoices')
    const syncResult = freshInvoices.query(() => true)
    expect(syncResult).toEqual([]) // cache not yet hydrated

    const asyncResult = await freshInvoices.list()
    expect(asyncResult).toHaveLength(1)

    const afterHydration = freshInvoices.query(() => true)
    expect(afterHydration).toHaveLength(1)
    db2.close()
  })
})
