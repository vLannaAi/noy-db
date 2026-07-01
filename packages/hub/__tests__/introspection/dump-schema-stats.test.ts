import { describe, it, expect, beforeEach } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../../src/kernel/types.js'
import { ConflictError } from '../../src/kernel/errors.js'
import { createNoydb } from '../../src/noydb.js'
import type { Noydb } from '../../src/noydb.js'

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

interface Invoice { id: string; amount: number }

describe('vault.dumpSchema({ withStats: true })', () => {
  const COMP = 'acme'
  let adapter: NoydbStore
  let db: Noydb

  beforeEach(async () => {
    adapter = inlineMemory()
    db = await createNoydb({ store: adapter, user: 'owner-01', secret: 'owner-pass' })
  })

  it('omits stats when withStats is not set', async () => {
    const comp = await db.openVault(COMP)
    comp.collection<Invoice>('invoices')
    await comp.collection<Invoice>('invoices').put('i1', { id: 'i1', amount: 100 })
    const snap = await comp.dumpSchema()
    expect(snap.collections.invoices?.stats).toBeUndefined()
    expect(snap.internal).toBeUndefined()
  })

  it('computes records + bytes + bytesAvg/Min/Max + oldest/newest per collection', async () => {
    const comp = await db.openVault(COMP)
    const invoices = comp.collection<Invoice>('invoices')
    await invoices.put('i1', { id: 'i1', amount: 100 })
    await invoices.put('i2', { id: 'i2', amount: 200 })
    await invoices.put('i3', { id: 'i3', amount: 300 })

    const snap = await comp.dumpSchema({ withStats: true })
    const stats = snap.collections.invoices?.stats
    expect(stats).toBeDefined()
    expect(stats!.records).toBe(3)
    expect(stats!.bytes).toBeGreaterThan(0)
    expect(stats!.bytesAvg).toBeGreaterThan(0)
    expect(stats!.bytesMin).toBeLessThanOrEqual(stats!.bytesAvg)
    expect(stats!.bytesMax).toBeGreaterThanOrEqual(stats!.bytesAvg)
    expect(stats!.oldest).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(stats!.newest).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(stats!.oldest <= stats!.newest).toBe(true)
  })

  it('zero-record collection emits stats with all zeros + empty timestamps', async () => {
    const comp = await db.openVault(COMP)
    comp.collection<Invoice>('invoices')
    const snap = await comp.dumpSchema({ withStats: true })
    const stats = snap.collections.invoices?.stats
    expect(stats).toEqual({
      records: 0, bytes: 0, bytesAvg: 0, bytesMin: 0, bytesMax: 0,
      oldest: '', newest: '',
    })
  })

  it('reports internal collections under `internal:` block when withStats=true', async () => {
    const comp = await db.openVault(COMP)
    const invoices = comp.collection<Invoice>('invoices')
    await invoices.put('i1', { id: 'i1', amount: 100 })

    const snap = await comp.dumpSchema({ withStats: true })
    expect(snap.internal).toBeDefined()
    // _keyring always populated for any vault opened with credentials
    expect(snap.internal!._keyring).toBeDefined()
    expect(snap.internal!._keyring!.records).toBeGreaterThan(0)
    expect(snap.internal!._keyring!.bytes).toBeGreaterThan(0)
  })
})
