import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/noydb.js'
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

interface Row {
  id: string
  clientId: string
  period: string
  amount: number
  submittedAt?: string
}

const LAZY = { prefetch: false as const, cache: { maxRecords: 100 } }
const SECRET = 'lazy-range-composite-2026'

async function openLazy(indexes: (string | readonly string[] | { fields: readonly string[] })[]) {
  const adapter = memory()
  const db = await createNoydb({ store: adapter, user: 'owner', secret: SECRET })
  const vault = await db.openVault('ACME')
  const coll = vault.collection<Row>('records', { ...LAZY, indexes })
  return { adapter, coll }
}

describe('range predicates on indexed fields (#275)', () => {
  it('filters with `<` numerically, not lexicographically', async () => {
    const { coll } = await openLazy(['amount'])
    await coll.put('r-1', { id: 'r-1', clientId: 'c-A', period: '2026-Q1', amount: 2 })
    await coll.put('r-2', { id: 'r-2', clientId: 'c-A', period: '2026-Q1', amount: 10 })
    await coll.put('r-3', { id: 'r-3', clientId: 'c-A', period: '2026-Q1', amount: 20 })

    // With a String(n) comparator, '10' < '2' would wrongly include r-2.
    const rows = await coll.lazyQuery().where('amount', '<', 10).toArray()
    expect(rows.map(r => r.id).sort()).toEqual(['r-1'])
  })

  it('filters with `>=` and `<=` (between) correctly', async () => {
    const { coll } = await openLazy(['amount'])
    await coll.put('r-1', { id: 'r-1', clientId: 'c-A', period: '2026-Q1', amount: 5 })
    await coll.put('r-2', { id: 'r-2', clientId: 'c-A', period: '2026-Q1', amount: 15 })
    await coll.put('r-3', { id: 'r-3', clientId: 'c-A', period: '2026-Q1', amount: 25 })
    await coll.put('r-4', { id: 'r-4', clientId: 'c-A', period: '2026-Q1', amount: 35 })

    const between = await coll.lazyQuery().where('amount', 'between', [10, 30]).toArray()
    expect(between.map(r => r.id).sort()).toEqual(['r-2', 'r-3'])
  })

  it('filters on Date fields correctly via ISO-8601 string ordering', async () => {
    const { coll } = await openLazy(['submittedAt'])
    await coll.put('r-1', { id: 'r-1', clientId: 'c-A', period: '2026-Q1', amount: 1, submittedAt: '2026-01-02T00:00:00.000Z' })
    await coll.put('r-2', { id: 'r-2', clientId: 'c-A', period: '2026-Q1', amount: 2, submittedAt: '2026-01-10T00:00:00.000Z' })
    await coll.put('r-3', { id: 'r-3', clientId: 'c-A', period: '2026-Q1', amount: 3, submittedAt: '2026-02-01T00:00:00.000Z' })

    const rows = await coll.lazyQuery()
      .where('submittedAt', '>=', '2026-01-10T00:00:00.000Z')
      .toArray()
    expect(rows.map(r => r.id).sort()).toEqual(['r-2', 'r-3'])
  })

  it('orderBy sorts numeric values numerically (#275 typed-value fix)', async () => {
    const { coll } = await openLazy(['amount'])
    await coll.put('r-1', { id: 'r-1', clientId: 'c-A', period: '2026-Q1', amount: 100 })
    await coll.put('r-2', { id: 'r-2', clientId: 'c-A', period: '2026-Q1', amount: 2 })
    await coll.put('r-3', { id: 'r-3', clientId: 'c-A', period: '2026-Q1', amount: 20 })
    await coll.put('r-4', { id: 'r-4', clientId: 'c-A', period: '2026-Q1', amount: 9 })

    const rows = await coll.lazyQuery().orderBy('amount', 'asc').toArray()
    expect(rows.map(r => r.amount)).toEqual([2, 9, 20, 100])
  })

  it('range on an unindexed field throws IndexRequiredError', async () => {
    const { coll } = await openLazy(['clientId'])
    await coll.put('r-1', { id: 'r-1', clientId: 'c-A', period: '2026-Q1', amount: 100 })
    await expect(coll.lazyQuery().where('amount', '<', 10).toArray()).rejects.toThrow(IndexRequiredError)
  })
})

describe('composite (multi-field) indexes (#276)', () => {
  it('accepts a tuple declaration and dispatches covering queries to the composite', async () => {
    const { coll } = await openLazy([['clientId', 'period']])
    await coll.put('r-1', { id: 'r-1', clientId: 'c-A', period: '2026-Q1', amount: 100 })
    await coll.put('r-2', { id: 'r-2', clientId: 'c-A', period: '2026-Q2', amount: 200 })
    await coll.put('r-3', { id: 'r-3', clientId: 'c-B', period: '2026-Q1', amount: 300 })

    const rows = await coll.lazyQuery()
      .where('clientId', '==', 'c-A')
      .where('period', '==', '2026-Q1')
      .toArray()
    expect(rows.map(r => r.id)).toEqual(['r-1'])
  })

  it('accepts the { fields: [...] } object form equivalently', async () => {
    const { coll } = await openLazy([{ fields: ['clientId', 'period'] }])
    await coll.put('r-1', { id: 'r-1', clientId: 'c-A', period: '2026-Q1', amount: 100 })
    await coll.put('r-2', { id: 'r-2', clientId: 'c-A', period: '2026-Q2', amount: 200 })

    const rows = await coll.lazyQuery()
      .where('clientId', '==', 'c-A')
      .where('period', '==', '2026-Q2')
      .toArray()
    expect(rows.map(r => r.id)).toEqual(['r-2'])
  })

  it('skips records whose tuple has any null component', async () => {
    const { adapter, coll } = await openLazy([['clientId', 'period']])
    // Row type marks `period` optional — no @ts-expect-error needed.
    await coll.put('r-1', { id: 'r-1', clientId: 'c-A', amount: 10 } as Row)
    await coll.put('r-2', { id: 'r-2', clientId: 'c-A', period: '2026-Q1', amount: 20 })

    const ids = await adapter.list('ACME', 'records')
    expect(ids).toContain('_idx/clientId|period/r-2')
    // r-1 has no period, so no composite side-car should exist.
    expect(ids).not.toContain('_idx/clientId|period/r-1')
  })

  it('composite coverage satisfies the field-indexed check even when a component is not individually indexed', async () => {
    // Only the composite is declared. A where on `clientId` alone
    // still passes the missing-field gate because the field appears
    // in the composite declaration — the dispatcher falls through to
    // the decrypted-candidate post-filter.
    const { coll } = await openLazy([['clientId', 'period']])
    await coll.put('r-1', { id: 'r-1', clientId: 'c-A', period: '2026-Q1', amount: 10 })
    await coll.put('r-2', { id: 'r-2', clientId: 'c-B', period: '2026-Q1', amount: 20 })

    // This particular call-site lacks an indexable driver (no
    // composite-covering equality, no orderBy), so it surfaces
    // IndexRequiredError — but only because of the no-driver guard,
    // not because `clientId` was rejected as unindexed.
    await expect(
      coll.lazyQuery().where('clientId', '==', 'c-A').toArray(),
    ).rejects.toThrow(IndexRequiredError)
  })

  it('rejects composite declaration where a field name contains the `|` delimiter', async () => {
    await expect(openLazy([['has|pipe', 'period']])).rejects.toThrow(/composite delimiter/)
  })

  it('rejects empty composite declaration', async () => {
    await expect(openLazy([{ fields: [] }])).rejects.toThrow(/non-empty/)
  })
})
