import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/noydb.js'
import { withIndexing } from '../src/indexing/index.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/types.js'
import { IndexRequiredError } from '../src/errors.js'

function memory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function col(c: string, n: string): Map<string, EncryptedEnvelope> {
    let comp = store.get(c); if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(n); if (!coll) { coll = new Map(); comp.set(n, coll) }
    return coll
  }
  return {
    name: 'memory',
    async get(c, n, id) { return store.get(c)?.get(n)?.get(id) ?? null },
    async put(c, n, id, env) { col(c, n).set(id, env) },
    async delete(c, n, id) { store.get(c)?.get(n)?.delete(id) },
    async list(c, n) { const coll = store.get(c)?.get(n); return coll ? [...coll.keys()] : [] },
    async loadAll(c) {
      const comp = store.get(c); const s: VaultSnapshot = {}
      if (comp) for (const [k, coll] of comp) {
        if (!k.startsWith('_')) {
          const r: Record<string, EncryptedEnvelope> = {}
          for (const [id, e] of coll) r[id] = e
          s[k] = r
        }
      }
      return s
    },
    async saveAll(c, data) {
      const comp = new Map<string, Map<string, EncryptedEnvelope>>()
      for (const [n, recs] of Object.entries(data)) {
        const coll = new Map<string, EncryptedEnvelope>()
        for (const [id, env] of Object.entries(recs)) coll.set(id, env)
        comp.set(n, coll)
      }
      const existing = store.get(c)
      if (existing) for (const [n, coll] of existing) if (n.startsWith('_')) comp.set(n, coll)
      store.set(c, comp)
    },
  }
}

interface Disbursement {
  id: string
  clientId: string
  period: string
  amount: number
}

const LAZY = { prefetch: false as const, cache: { maxRecords: 100 } }
const SECRET = 'lazy-indexes-passphrase-2026'

async function openLazy(indexes: string[] = ['clientId', 'period']) {
  const adapter = memory()
  const db = await createNoydb({ store: adapter, user: 'owner', secret: SECRET, indexStrategy: withIndexing() })
  const vault = await db.openVault('ACME')
  const coll = vault.collection<Disbursement>('disbursements', {
    ...LAZY,
    indexes,
  })
  return { adapter, db, vault, coll }
}

describe('lazy-mode indexes — write path (#266)', () => {
  it('writes _idx/<field>/<recordId> side-cars on put', async () => {
    const { adapter, coll } = await openLazy()
    await coll.put('d-1', { id: 'd-1', clientId: 'c-A', period: '2026-Q1', amount: 100 })

    const ids = await adapter.list('ACME', 'disbursements')
    expect(ids).toContain('d-1')
    expect(ids).toContain('_idx/clientId/d-1')
    expect(ids).toContain('_idx/period/d-1')
  })

  it('removes side-cars on delete', async () => {
    const { adapter, coll } = await openLazy()
    await coll.put('d-1', { id: 'd-1', clientId: 'c-A', period: '2026-Q1', amount: 100 })
    await coll.delete('d-1')

    const ids = await adapter.list('ACME', 'disbursements')
    expect(ids).not.toContain('d-1')
    expect(ids).not.toContain('_idx/clientId/d-1')
    expect(ids).not.toContain('_idx/period/d-1')
  })

  it('replaces side-car body on update (in-memory mirror moves buckets)', async () => {
    const { coll } = await openLazy()
    await coll.put('d-1', { id: 'd-1', clientId: 'c-A', period: '2026-Q1', amount: 100 })
    await coll.put('d-1', { id: 'd-1', clientId: 'c-B', period: '2026-Q1', amount: 100 })

    const found = await coll.lazyQuery().where('clientId', '==', 'c-B').toArray()
    expect(found).toHaveLength(1)
    expect(found[0]!.id).toBe('d-1')

    const old = await coll.lazyQuery().where('clientId', '==', 'c-A').toArray()
    expect(old).toHaveLength(0)
  })

  it('does not index null/undefined field values', async () => {
    const { adapter, coll } = await openLazy(['clientId'])
    // @ts-expect-error — deliberately leaving clientId absent to exercise the
    // null-skip path. The runtime behavior is the test target.
    await coll.put('d-1', { id: 'd-1', period: '2026-Q1', amount: 50 })

    const ids = await adapter.list('ACME', 'disbursements')
    expect(ids).toContain('d-1')
    expect(ids).not.toContain('_idx/clientId/d-1')
  })
})

describe('lazy-mode indexes — equality dispatch (#267)', () => {
  it('returns matching records for where(field, ==, value)', async () => {
    const { coll } = await openLazy()
    await coll.put('d-1', { id: 'd-1', clientId: 'c-A', period: '2026-Q1', amount: 100 })
    await coll.put('d-2', { id: 'd-2', clientId: 'c-B', period: '2026-Q1', amount: 200 })
    await coll.put('d-3', { id: 'd-3', clientId: 'c-A', period: '2026-Q2', amount: 300 })

    const rows = await coll.lazyQuery().where('clientId', '==', 'c-A').toArray()
    expect(rows.map(r => r.id).sort()).toEqual(['d-1', 'd-3'])
  })

  it('returns matching records for where(field, in, values)', async () => {
    const { coll } = await openLazy()
    await coll.put('d-1', { id: 'd-1', clientId: 'c-A', period: '2026-Q1', amount: 100 })
    await coll.put('d-2', { id: 'd-2', clientId: 'c-B', period: '2026-Q1', amount: 200 })
    await coll.put('d-3', { id: 'd-3', clientId: 'c-C', period: '2026-Q2', amount: 300 })

    const rows = await coll.lazyQuery().where('clientId', 'in', ['c-A', 'c-C']).toArray()
    expect(rows.map(r => r.id).sort()).toEqual(['d-1', 'd-3'])
  })

  it('throws IndexRequiredError when a touched field is not indexed', async () => {
    const { coll } = await openLazy(['clientId'])
    await coll.put('d-1', { id: 'd-1', clientId: 'c-A', period: '2026-Q1', amount: 100 })

    await expect(
      coll.lazyQuery().where('period', '==', '2026-Q1').toArray(),
    ).rejects.toThrow(IndexRequiredError)
  })

  it('applies a secondary non-indexed filter via evaluateClause over the candidate set', async () => {
    // The executor scopes by the indexed == clause, then still evaluates
    // the `amount > 150` clause against each decrypted candidate. Both
    // fields are declared so the missing-index check passes.
    const { coll } = await openLazy(['clientId', 'amount'])
    await coll.put('d-1', { id: 'd-1', clientId: 'c-A', period: '2026-Q1', amount: 100 })
    await coll.put('d-2', { id: 'd-2', clientId: 'c-A', period: '2026-Q2', amount: 200 })
    await coll.put('d-3', { id: 'd-3', clientId: 'c-B', period: '2026-Q1', amount: 500 })

    const rows = await coll.lazyQuery()
      .where('clientId', '==', 'c-A')
      .where('amount', '>', 150)
      .toArray()
    expect(rows.map(r => r.id)).toEqual(['d-2'])
  })

  it('count() returns the number of matches without re-running the query twice', async () => {
    const { coll } = await openLazy()
    await coll.put('d-1', { id: 'd-1', clientId: 'c-A', period: '2026-Q1', amount: 100 })
    await coll.put('d-2', { id: 'd-2', clientId: 'c-A', period: '2026-Q2', amount: 200 })
    await coll.put('d-3', { id: 'd-3', clientId: 'c-B', period: '2026-Q1', amount: 300 })

    expect(await coll.lazyQuery().where('clientId', '==', 'c-A').count()).toBe(2)
  })

  it('first() returns null when no record matches', async () => {
    const { coll } = await openLazy()
    await coll.put('d-1', { id: 'd-1', clientId: 'c-A', period: '2026-Q1', amount: 100 })
    expect(await coll.lazyQuery().where('clientId', '==', 'nobody').first()).toBeNull()
  })
})

describe('lazy-mode indexes — orderBy dispatch (#268)', () => {
  it('orders records via orderedBy when no == clause pins the candidate set', async () => {
    const { coll } = await openLazy(['amount'])
    await coll.put('d-1', { id: 'd-1', clientId: 'c-A', period: '2026-Q1', amount: 300 })
    await coll.put('d-2', { id: 'd-2', clientId: 'c-A', period: '2026-Q1', amount: 100 })
    await coll.put('d-3', { id: 'd-3', clientId: 'c-A', period: '2026-Q1', amount: 200 })

    // PersistedCollectionIndex.orderedBy sorts lexicographically on the
    // bucket-key string. That is lexicographic-on-String(n) — deliberately
    // left as-is here because the final in-memory sort over the decrypted
    // records (line 116 of lazy-builder.ts) applies the typed numeric
    // comparator. This test pins the typed comparator.
    const rows = await coll.lazyQuery().orderBy('amount', 'asc').toArray()
    expect(rows.map(r => r.amount)).toEqual([100, 200, 300])
  })

  it('applies limit + offset on the sorted result', async () => {
    const { coll } = await openLazy(['amount'])
    await coll.put('d-1', { id: 'd-1', clientId: 'c-A', period: '2026-Q1', amount: 300 })
    await coll.put('d-2', { id: 'd-2', clientId: 'c-A', period: '2026-Q1', amount: 100 })
    await coll.put('d-3', { id: 'd-3', clientId: 'c-A', period: '2026-Q1', amount: 200 })
    await coll.put('d-4', { id: 'd-4', clientId: 'c-A', period: '2026-Q1', amount: 400 })

    const page = await coll.lazyQuery()
      .orderBy('amount', 'asc')
      .offset(1)
      .limit(2)
      .toArray()
    expect(page.map(r => r.amount)).toEqual([200, 300])
  })
})

describe('lazy-mode indexes — bulk-load from pre-existing side-cars', () => {
  it('rebuilds the in-memory mirror from _idx side-cars on first query', async () => {
    // Seed via a first lazy collection (which writes side-cars), then
    // open a second Noydb pointed at the SAME adapter. The second
    // collection has no prior mirror state — it must bulk-load from
    // `_idx/*` on first query.
    const adapter = memory()
    const db1 = await createNoydb({ store: adapter, user: 'owner', secret: SECRET, indexStrategy: withIndexing() })
    const v1 = await db1.openVault('ACME')
    const c1 = v1.collection<Disbursement>('disbursements', { ...LAZY, indexes: ['clientId'] })
    await c1.put('d-1', { id: 'd-1', clientId: 'c-A', period: '2026-Q1', amount: 100 })
    await c1.put('d-2', { id: 'd-2', clientId: 'c-A', period: '2026-Q2', amount: 200 })
    await c1.put('d-3', { id: 'd-3', clientId: 'c-B', period: '2026-Q1', amount: 300 })

    const db2 = await createNoydb({ store: adapter, user: 'owner', secret: SECRET, indexStrategy: withIndexing() })
    const v2 = await db2.openVault('ACME')
    const c2 = v2.collection<Disbursement>('disbursements', { ...LAZY, indexes: ['clientId'] })

    const rows = await c2.lazyQuery().where('clientId', '==', 'c-A').toArray()
    expect(rows.map(r => r.id).sort()).toEqual(['d-1', 'd-2'])
  })
})

describe('lazy-mode indexes — rebuildIndexes + reconcileIndex (#269)', () => {
  it('rebuildIndexes() backfills side-cars when a new field is added after records exist', async () => {
    const adapter = memory()

    // Phase 1: write records with only clientId declared.
    const db1 = await createNoydb({ store: adapter, user: 'owner', secret: SECRET, indexStrategy: withIndexing() })
    const v1 = await db1.openVault('ACME')
    const c1 = v1.collection<Disbursement>('disbursements', { ...LAZY, indexes: ['clientId'] })
    await c1.put('d-1', { id: 'd-1', clientId: 'c-A', period: '2026-Q1', amount: 100 })
    await c1.put('d-2', { id: 'd-2', clientId: 'c-B', period: '2026-Q2', amount: 200 })

    // Phase 2: reopen with a NEW indexed field `period`. No side-cars
    // exist for it yet — a query on `period` would fail until rebuild.
    const db2 = await createNoydb({ store: adapter, user: 'owner', secret: SECRET, indexStrategy: withIndexing() })
    const v2 = await db2.openVault('ACME')
    const c2 = v2.collection<Disbursement>('disbursements', {
      ...LAZY,
      indexes: ['clientId', 'period'],
    })

    await c2.rebuildIndexes()

    const rows = await c2.lazyQuery().where('period', '==', '2026-Q1').toArray()
    expect(rows.map(r => r.id)).toEqual(['d-1'])

    // Both fields still resolve — rebuild didn't drop anything.
    const aRows = await c2.lazyQuery().where('clientId', '==', 'c-B').toArray()
    expect(aRows.map(r => r.id)).toEqual(['d-2'])
  })

  it('reconcileIndex() detects missing side-cars and repairs them when dryRun is false', async () => {
    const { adapter, coll } = await openLazy(['clientId'])
    await coll.put('d-1', { id: 'd-1', clientId: 'c-A', period: '2026-Q1', amount: 100 })
    await coll.put('d-2', { id: 'd-2', clientId: 'c-B', period: '2026-Q1', amount: 200 })

    // Simulate a missed side-car by deleting one manually.
    await adapter.delete('ACME', 'disbursements', '_idx/clientId/d-2')

    const report = await coll.reconcileIndex('clientId', { dryRun: true })
    expect(report.field).toBe('clientId')
    expect(report.missing).toEqual(['d-2'])
    expect(report.applied).toBe(0)

    const applied = await coll.reconcileIndex('clientId')
    expect(applied.missing).toEqual(['d-2'])
    expect(applied.applied).toBe(1)

    // After repair, the side-car is back and queries find it.
    const rows = await coll.lazyQuery().where('clientId', '==', 'c-B').toArray()
    expect(rows.map(r => r.id)).toEqual(['d-2'])
  })

  it('reconcileIndex() detects stale side-cars pointing at deleted records', async () => {
    const { adapter, coll } = await openLazy(['clientId'])
    await coll.put('d-1', { id: 'd-1', clientId: 'c-A', period: '2026-Q1', amount: 100 })

    // Delete the canonical record directly so the side-car is now orphaned.
    await adapter.delete('ACME', 'disbursements', 'd-1')

    const report = await coll.reconcileIndex('clientId')
    expect(report.stale).toEqual(['_idx/clientId/d-1'])
    expect(report.applied).toBe(1)

    const remaining = await adapter.list('ACME', 'disbursements')
    expect(remaining).not.toContain('_idx/clientId/d-1')
  })

  it('reconcileIndex() rejects eager-mode collections with a helpful error', async () => {
    const db = await createNoydb({ store: memory(), user: 'owner', secret: SECRET, indexStrategy: withIndexing() })
    const vault = await db.openVault('ACME')
    const eager = vault.collection<Disbursement>('disbursements', { indexes: ['clientId'] })
    await expect(eager.reconcileIndex('clientId')).rejects.toThrow(/only meaningful in lazy mode/)
  })

  it('reconcileIndex() rejects fields that are not declared', async () => {
    const { coll } = await openLazy(['clientId'])
    await expect(coll.reconcileIndex('amount')).rejects.toThrow(/not declared in indexes/)
  })
})

describe('lazy-mode indexes — query() preconditions', () => {
  it('throws a helpful error when lazyQuery() is called with no indexes declared', async () => {
    const { coll } = await openLazy([])
    expect(() => coll.lazyQuery()).toThrow(/at least one field declared/)
  })

  it('refuses query() in lazy mode and points at lazyQuery()', async () => {
    const { coll } = await openLazy()
    expect(() => coll.query()).toThrow(/lazyQuery\(\)/)
  })
})
