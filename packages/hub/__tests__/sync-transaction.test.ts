import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/types.js'
import { ConflictError } from '../src/errors.js'
import { createNoydb } from '../src/noydb.js'
import { SyncTransaction } from '../src/team/sync-transaction.js'

// ─── Inline memory adapter ─────────────────────────────────────────────────

function inlineMemory(): NoydbStore {
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
interface Payment { amount: number; method: string }

const COMP = 'COMP-TX'

describe('SyncTransaction (v0.9 #135)', () => {
  it('db.transaction() returns a SyncTransaction instance', async () => {
    const local = inlineMemory()
    const remote = inlineMemory()
    const db = await createNoydb({ store: local, sync: remote, user: 'u', encrypt: false })
    await db.openVault(COMP)

    const tx = db.transaction(COMP)
    expect(tx).toBeInstanceOf(SyncTransaction)
  })

  it('throws if vault is not open', async () => {
    const local = inlineMemory()
    const remote = inlineMemory()
    const db = await createNoydb({ store: local, sync: remote, user: 'u', encrypt: false })

    expect(() => db.transaction(COMP)).toThrow(/not open/)
  })

  it('throws if no sync adapter is configured', async () => {
    const local = inlineMemory()
    const db = await createNoydb({ store: local, user: 'u', encrypt: false })
    await db.openVault(COMP)

    expect(() => db.transaction(COMP)).toThrow(/No sync adapter/)
  })

  it('stages puts and commits them atomically', async () => {
    const local = inlineMemory()
    const remote = inlineMemory()
    const db = await createNoydb({ store: local, sync: remote, user: 'u', encrypt: false })
    await db.openVault(COMP)

    const tx = db.transaction(COMP)
    tx.put('invoices', 'inv-1', { amount: 100, status: 'draft' } as Invoice)
    tx.put('payments', 'pay-1', { amount: 50, method: 'card' } as Payment)

    const result = await tx.commit()

    expect(result.status).toBe('committed')
    expect(result.pushed).toBe(2)
    expect(result.conflicts).toHaveLength(0)

    // Both records are on remote
    expect(await remote.get(COMP, 'invoices', 'inv-1')).not.toBeNull()
    expect(await remote.get(COMP, 'payments', 'pay-1')).not.toBeNull()
  })

  it('stages deletes and commits them', async () => {
    const local = inlineMemory()
    const remote = inlineMemory()
    const db = await createNoydb({ store: local, sync: remote, user: 'u', encrypt: false })
    const comp = await db.openVault(COMP)

    // Seed a record
    await comp.collection<Invoice>('invoices').put('inv-del', { amount: 1, status: 'x' })
    await db.push(COMP)

    const tx = db.transaction(COMP)
    tx.delete('invoices', 'inv-del')
    const result = await tx.commit()

    expect(result.status).toBe('committed')
    expect(await remote.get(COMP, 'invoices', 'inv-del')).toBeNull()
  })

  it('is chainable: put().put().delete()', async () => {
    const local = inlineMemory()
    const remote = inlineMemory()
    const db = await createNoydb({ store: local, sync: remote, user: 'u', encrypt: false })
    await db.openVault(COMP)

    const result = await db.transaction(COMP)
      .put('invoices', 'inv-1', { amount: 1, status: 'a' } as Invoice)
      .put('invoices', 'inv-2', { amount: 2, status: 'b' } as Invoice)
      .commit()

    expect(result.pushed).toBe(2)
  })

  it('reports conflict status when push conflicts', async () => {
    const local = inlineMemory()
    const remote = inlineMemory()
    const db = await createNoydb({ store: local, sync: remote, user: 'u', encrypt: false })
    await db.openVault(COMP)

    // Pre-seed remote with a higher version to cause a conflict
    await remote.put(COMP, 'invoices', 'inv-1', {
      _noydb: 1, _v: 10, _ts: new Date().toISOString(), _iv: '', _data: '{"amount":999,"status":"remote"}',
    })

    const tx = db.transaction(COMP)
    tx.put('invoices', 'inv-1', { amount: 1, status: 'local' } as Invoice)

    const result = await tx.commit()
    expect(result.status).toBe('conflict')
    expect(result.conflicts).toHaveLength(1)
  })

  it('does not push records outside the transaction', async () => {
    const local = inlineMemory()
    const remote = inlineMemory()
    const db = await createNoydb({ store: local, sync: remote, user: 'u', encrypt: false })
    const comp = await db.openVault(COMP)

    // Dirty record outside the transaction
    await comp.collection<Invoice>('payments').put('pay-outside', { amount: 99, status: 'pending' })
    expect(db.syncStatus(COMP).dirty).toBe(1)

    // Transaction only touches invoices
    const tx = db.transaction(COMP)
    tx.put('invoices', 'inv-1', { amount: 1, status: 'x' } as Invoice)
    const result = await tx.commit()

    expect(result.pushed).toBe(1)

    // outside payment still NOT on remote
    expect(await remote.get(COMP, 'payments', 'pay-outside')).toBeNull()
    // still dirty (not part of the tx)
    expect(db.syncStatus(COMP).dirty).toBe(1)
  })
})
