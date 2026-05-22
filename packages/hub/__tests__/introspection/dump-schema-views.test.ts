import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../../src/types.js'
import { ConflictError } from '../../src/errors.js'
import { createNoydb, withMaterializedView, sum } from '../../src/index.js'
import { withAggregate } from '../../src/aggregate/index.js'

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

interface Invoice extends Record<string, unknown> { id: string; client_id: string; amount: number }

describe('vault.dumpSchema() — materialized views', () => {
  it('emits an empty materializedViews map when none are registered', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'alice', secret: 'pw' })
    const vault = await db.openVault('acme')
    const snap = await vault.dumpSchema()
    expect(snap.materializedViews).toEqual({})
    expect(snap.subsystems.materializedViews).toBe(false)
  })

  it('describes a registered query-form MV with sources + refresh', async () => {
    const totals = withMaterializedView<{ client_id: string; total: number }>({
      name: 'invoice-totals',
      sources: ['invoices'],
      query: (db) => db.collection<Invoice>('invoices').query()
        .groupBy('client_id').aggregate({ total: sum('amount') }),
      rowKey: (r) => r.client_id,
      refresh: 'eager',
    })

    const db = await createNoydb({
      store: inlineMemory(),
      user: 'alice',
      secret: 'pw',
      aggregateStrategy: withAggregate(),
      materializedViewStrategies: [totals],
    })
    const vault = await db.openVault('acme')
    await vault.collection<Invoice>('invoices').put('i1', { id: 'i1', client_id: 'c1', amount: 100 })

    const snap = await vault.dumpSchema()
    expect(snap.subsystems.materializedViews).toBe(true)
    const mv = snap.materializedViews['invoice-totals']
    expect(mv).toBeDefined()
    expect(mv!.sources).toContain('invoices')
    expect(mv!.refresh).toBe('eager')
  })

  it('describes a registered UNION MV with sources, groupBy, aggregate', async () => {
    const monthlyVat = withMaterializedView<{ client_id: string; period: string; vat: number }>({
      name: 'monthly-vat',
      unionSources: [
        { collection: 'receipts', map: (r: Record<string, unknown>) => ({
          client_id: r.client_id as string, period: r.period as string, vat: r.vat as number,
        }) },
        { collection: 'credit-notes', map: (r: Record<string, unknown>) => ({
          client_id: r.client_id as string, period: r.period as string, vat: -(r.vat as number),
        }) },
      ],
      groupBy: ['client_id', 'period'],
      aggregate: { vat: sum('vat') },
      rowKey: (r) => `${r.client_id}|${r.period}`,
      refresh: 'eager',
    })

    const db = await createNoydb({
      store: inlineMemory(),
      user: 'alice',
      secret: 'pw',
      aggregateStrategy: withAggregate(),
      materializedViewStrategies: [monthlyVat],
    })
    const vault = await db.openVault('acme')

    const snap = await vault.dumpSchema()
    const mv = snap.materializedViews['monthly-vat']
    expect(mv).toBeDefined()
    expect(mv!.sources.sort()).toEqual(['credit-notes', 'receipts'])
    expect(mv!.groupBy).toEqual(['client_id', 'period'])
    expect(mv!.aggregate).toBeDefined()
    expect(typeof mv!.aggregate!.vat).toBe('string')
  })
})
