import { describe, it, expect } from 'vitest'
import { createNoydb, withMaterializedView, sum } from '../../src/index.js'
import { withAggregate } from '../../src/with-lookup/aggregate/index.js'
import type { NoydbStore, EncryptedEnvelope } from '../../src/kernel/types.js'

function memory(): NoydbStore {
  const data = new Map<string, EncryptedEnvelope>()
  const k = (v: string, c: string, i: string) => `${v}/${c}/${i}`
  return {
    capabilities: { casAtomic: true, auth: { kind: 'none', required: false, flow: 'static' } },
    async get(v, c, i) { return data.get(k(v, c, i)) ?? null },
    async put(v, c, i, env) { data.set(k(v, c, i), env) },
    async delete(v, c, i) { data.delete(k(v, c, i)) },
    async list(v, c) {
      const prefix = `${v}/${c}/`
      return [...data.keys()].filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length))
    },
    async loadAll(v) {
      const out: Record<string, Record<string, EncryptedEnvelope>> = {}
      for (const [key, env] of data) {
        const [vname, cname, id] = key.split('/')
        if (vname === v) {
          out[cname!] = out[cname!] ?? {}
          out[cname!]![id!] = env
        }
      }
      return out
    },
    async saveAll(v, payload) {
      for (const c of Object.keys(payload)) {
        for (const i of Object.keys(payload[c]!)) {
          data.set(k(v, c, i), payload[c]![i]!)
        }
      }
    },
  }
}

interface TaxReceipt extends Record<string, unknown> {
  id: string
  issuedAt: string
  paidServicesVat: number
}

interface CreditNote extends Record<string, unknown> {
  id: string
  issuedAt: string
  paidServicesVat: number
}

interface MonthlyVatRow extends Record<string, unknown> {
  period: string
  vat: number
}

interface ArmRowA extends Record<string, unknown> {
  id: string
  k: string
  n: number
}

interface ArmRowB extends Record<string, unknown> {
  id: string
  k: string
  n: number
}

interface TotalsRow extends Record<string, unknown> {
  k: string
  n: number
}

describe('UNION MV — basic 2-source (#165)', () => {
  it('reads from both arms, maps, groupBy, aggregate', async () => {
    const monthlyVat = withMaterializedView<MonthlyVatRow>({
      name: 'monthlyVat',
      unionSources: [
        {
          collection: 'taxReceipts',
          map: r => {
            const tr = r as unknown as TaxReceipt
            return { period: tr.issuedAt.slice(0, 7), vat: tr.paidServicesVat }
          },
        },
        {
          collection: 'creditNotes',
          map: r => {
            const cn = r as unknown as CreditNote
            return { period: cn.issuedAt.slice(0, 7), vat: -cn.paidServicesVat }
          },
        },
      ],
      groupBy: 'period',
      aggregate: { vat: sum('vat') },
      rowKey: row => row.period,
      refresh: 'eager',
    })

    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'mv-union-basic-passphrase-2026',
      materializedViewStrategies: [monthlyVat],
      aggregateStrategy: withAggregate(),
    })
    const vault = await db.openVault('demo')

    const receipts = vault.collection<TaxReceipt>('taxReceipts')
    const notes = vault.collection<CreditNote>('creditNotes')

    await receipts.put('r-1', { id: 'r-1', issuedAt: '2026-05-15', paidServicesVat: 100 })
    await receipts.put('r-2', { id: 'r-2', issuedAt: '2026-05-20', paidServicesVat: 50 })
    await notes.put('cn-1', { id: 'cn-1', issuedAt: '2026-05-25', paidServicesVat: 30 })

    const out = vault.collection<MonthlyVatRow & { _materializedFrom?: unknown }>('monthlyVat')
    const row = await out.get('2026-05')
    expect(row).not.toBeNull()
    expect(row?.period).toBe('2026-05')
    expect(row?.vat).toBe(120) // 100 + 50 - 30
  })

  it('refreshes on writes to either arm independently', async () => {
    const totals = withMaterializedView<TotalsRow>({
      name: 'totals',
      unionSources: [
        {
          collection: 'a',
          map: r => {
            const row = r as unknown as ArmRowA
            return { k: row.k, n: row.n }
          },
        },
        {
          collection: 'b',
          map: r => {
            const row = r as unknown as ArmRowB
            return { k: row.k, n: row.n }
          },
        },
      ],
      groupBy: 'k',
      aggregate: { n: sum('n') },
      rowKey: row => row.k,
      refresh: 'eager',
    })

    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'mv-union-arms-independent-passphrase-2026',
      materializedViewStrategies: [totals],
      aggregateStrategy: withAggregate(),
    })
    const vault = await db.openVault('demo')

    const a = vault.collection<ArmRowA>('a')
    const b = vault.collection<ArmRowB>('b')
    const out = vault.collection<TotalsRow & { _materializedFrom?: unknown }>('totals')

    // Write to arm A first.
    await a.put('a-1', { id: 'a-1', k: 'x', n: 10 })
    let row = await out.get('x')
    expect(row).not.toBeNull()
    expect(row?.n).toBe(10)

    // Write to arm B — MV must refresh from the B-arm write too.
    await b.put('b-1', { id: 'b-1', k: 'x', n: 5 })
    row = await out.get('x')
    expect(row).not.toBeNull()
    expect(row?.n).toBe(15)
  })
})

describe('UNION MV — combined with multi-key groupBy (#165 + #166)', () => {
  it('niwat canonical monthly-VAT shape: union(taxReceipts, creditNotes) + groupBy(clientId, period)', async () => {
    interface NiwatTaxReceipt extends Record<string, unknown> {
      id: string
      clientId: string
      issuedAt: string
      paidServicesVat: number
    }
    interface NiwatCreditNote extends Record<string, unknown> {
      id: string
      clientId: string
      issuedAt: string
      paidServicesVat: number
    }
    interface NiwatMonthlyVatRow extends Record<string, unknown> {
      clientId: string
      period: string
      vat: number
    }

    const monthlyOutputVat = withMaterializedView<NiwatMonthlyVatRow>({
      name: 'monthlyOutputVat',
      unionSources: [
        {
          collection: 'taxReceipts',
          map: r => {
            const tr = r as unknown as NiwatTaxReceipt
            return {
              clientId: tr.clientId,
              period: tr.issuedAt.slice(0, 7),
              vat: tr.paidServicesVat,
            }
          },
        },
        {
          collection: 'creditNotes',
          map: r => {
            const cn = r as unknown as NiwatCreditNote
            return {
              clientId: cn.clientId,
              period: cn.issuedAt.slice(0, 7),
              vat: -cn.paidServicesVat,
            }
          },
        },
      ],
      groupBy: ['clientId', 'period'],
      aggregate: { vat: sum('vat') },
      rowKey: row => `${row.clientId}|${row.period}`,
      refresh: 'eager',
    })

    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'mv-union-multikey-niwat-passphrase-2026',
      materializedViewStrategies: [monthlyOutputVat],
      aggregateStrategy: withAggregate(),
    })
    const vault = await db.openVault('demo')

    const receipts = vault.collection<NiwatTaxReceipt>('taxReceipts')
    const notes = vault.collection<NiwatCreditNote>('creditNotes')

    await receipts.put('r1', { id: 'r1', clientId: 'c1', issuedAt: '2026-05-01', paidServicesVat: 100 })
    await receipts.put('r2', { id: 'r2', clientId: 'c1', issuedAt: '2026-05-15', paidServicesVat: 50 })
    await receipts.put('r3', { id: 'r3', clientId: 'c2', issuedAt: '2026-05-10', paidServicesVat: 70 })
    await notes.put('n1', { id: 'n1', clientId: 'c1', issuedAt: '2026-05-20', paidServicesVat: 20 })

    const out = vault.collection<NiwatMonthlyVatRow & { _materializedFrom?: unknown }>('monthlyOutputVat')
    const rows = await out.list()
    expect(rows).toHaveLength(2)

    const c1May = await out.get('c1|2026-05')
    expect(c1May).not.toBeNull()
    expect(c1May?.clientId).toBe('c1')
    expect(c1May?.period).toBe('2026-05')
    expect(c1May?.vat).toBe(130) // 100 + 50 - 20

    const c2May = await out.get('c2|2026-05')
    expect(c2May).not.toBeNull()
    expect(c2May?.clientId).toBe('c2')
    expect(c2May?.period).toBe('2026-05')
    expect(c2May?.vat).toBe(70)
  })
})

describe('UNION MV — edges (#165)', () => {
  it('three-source UNION sums correctly', async () => {
    interface ThreeArmRow extends Record<string, unknown> {
      id: string
      k: string
      n: number
    }

    const totals = withMaterializedView<TotalsRow>({
      name: 'totals',
      unionSources: [
        {
          collection: 'a',
          map: r => {
            const row = r as unknown as ThreeArmRow
            return { k: row.k, n: row.n }
          },
        },
        {
          collection: 'b',
          map: r => {
            const row = r as unknown as ThreeArmRow
            return { k: row.k, n: row.n }
          },
        },
        {
          collection: 'c',
          map: r => {
            const row = r as unknown as ThreeArmRow
            return { k: row.k, n: row.n }
          },
        },
      ],
      groupBy: 'k',
      aggregate: { n: sum('n') },
      rowKey: row => row.k,
      refresh: 'eager',
    })

    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'mv-union-three-source-passphrase-2026',
      materializedViewStrategies: [totals],
      aggregateStrategy: withAggregate(),
    })
    const vault = await db.openVault('demo')

    const a = vault.collection<ThreeArmRow>('a')
    const b = vault.collection<ThreeArmRow>('b')
    const c = vault.collection<ThreeArmRow>('c')

    await a.put('a-1', { id: 'a-1', k: 'x', n: 1 })
    await b.put('b-1', { id: 'b-1', k: 'x', n: 2 })
    await c.put('c-1', { id: 'c-1', k: 'x', n: 4 })

    const out = vault.collection<TotalsRow & { _materializedFrom?: unknown }>('totals')
    const row = await out.get('x')
    expect(row).not.toBeNull()
    expect(row?.n).toBe(7)
  })

  // Fix for #181: `Collection._doDelete` now calls
  // `dispatchMaterializedViews` (mirroring put), so source deletes
  // trigger eager MV refresh automatically. The internal=true path
  // (used by MV refresh tombstoning itself) still skips dispatch to
  // avoid recursion. Affects ANY MV with `onEmpty: 'delete'` (the
  // default), not just UNION-form. The manual-refresh variant below
  // remains as a separate proof that the executor is correct in
  // isolation.
  it('onEmpty: delete tombstones MV row automatically when source rows are deleted (#181)', async () => {
    const totals = withMaterializedView<TotalsRow>({
      name: 'totals',
      unionSources: [
        {
          collection: 'a',
          map: r => {
            const row = r as unknown as ArmRowA
            return { k: row.k, n: row.n }
          },
        },
        {
          collection: 'b',
          map: r => {
            const row = r as unknown as ArmRowB
            return { k: row.k, n: row.n }
          },
        },
      ],
      groupBy: 'k',
      aggregate: { n: sum('n') },
      rowKey: row => row.k,
      refresh: 'eager',
      onEmpty: 'delete',
    })

    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'mv-union-onempty-auto-tombstone-passphrase-2026',
      materializedViewStrategies: [totals],
      aggregateStrategy: withAggregate(),
    })
    const vault = await db.openVault('demo')
    const a = vault.collection<ArmRowA>('a')
    const b = vault.collection<ArmRowB>('b')
    const out = vault.collection<TotalsRow & { _materializedFrom?: unknown }>('totals')

    await a.put('a-1', { id: 'a-1', k: 'x', n: 1 })
    await b.put('b-1', { id: 'b-1', k: 'x', n: 2 })
    expect((await out.list())).toHaveLength(1)

    // Delete both contributing source rows — the auto-dispatch from
    // `_doDelete` should run the executor, listOutputIds finds the
    // now-orphan 'x' row, and `onEmpty: 'delete'` tombstones it.
    // NO `vault.refreshView('totals')` call here — that's the point.
    await a.delete('a-1')
    await b.delete('b-1')

    expect((await out.list())).toHaveLength(0)
  })

  it('onEmpty: delete (default) tombstones MV row when all contributing source rows are deleted (manual refresh)', async () => {
    const totals = withMaterializedView<TotalsRow>({
      name: 'totals',
      unionSources: [
        {
          collection: 'a',
          map: r => {
            const row = r as unknown as ArmRowA
            return { k: row.k, n: row.n }
          },
        },
        {
          collection: 'b',
          map: r => {
            const row = r as unknown as ArmRowB
            return { k: row.k, n: row.n }
          },
        },
      ],
      groupBy: 'k',
      aggregate: { n: sum('n') },
      rowKey: row => row.k,
      refresh: 'eager',
      onEmpty: 'delete',
    })

    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'mv-union-onempty-tombstone-passphrase-2026',
      materializedViewStrategies: [totals],
      aggregateStrategy: withAggregate(),
    })
    const vault = await db.openVault('demo')

    const a = vault.collection<ArmRowA>('a')
    const b = vault.collection<ArmRowB>('b')
    const out = vault.collection<TotalsRow & { _materializedFrom?: unknown }>('totals')

    await a.put('a-1', { id: 'a-1', k: 'x', n: 1 })
    await b.put('b-1', { id: 'b-1', k: 'x', n: 2 })

    let rows = await out.list()
    expect(rows).toHaveLength(1)
    const row = await out.get('x')
    expect(row?.n).toBe(3)

    // Delete both contributing source rows — MV row should tombstone.
    await a.delete('a-1')
    await b.delete('b-1')

    // Probe: manual refresh DOES tombstone, proving executor + listOutputIds
    // are correct — the gap is purely that `_doDelete` doesn't dispatch.
    await vault.refreshView('totals')

    rows = await out.list()
    expect(rows).toHaveLength(0)
  })
})

describe('UNION MV — queryHash sensitivity (#165 niwat review)', () => {
  it('reordering unionSources arms produces a different queryHash (declaration order is semantically meaningful)', async () => {
    // Strategy A — arm "a" first, arm "b" second
    const stratA = withMaterializedView<{ k: string; n: number }>({
      name: 'order-sensitive',
      unionSources: [
        { collection: 'a', map: (r: Record<string, unknown>) => ({ k: r.k as string, n: r.n as number }) },
        { collection: 'b', map: (r: Record<string, unknown>) => ({ k: r.k as string, n: r.n as number }) },
      ],
      groupBy: 'k',
      // no aggregate — dedup-only path; first-seen row wins per composite key
      rowKey: row => row.k,
      refresh: 'eager',
    })
    // Strategy B — same fields, arms reversed
    const stratB = withMaterializedView<{ k: string; n: number }>({
      name: 'order-sensitive',
      unionSources: [
        { collection: 'b', map: (r: Record<string, unknown>) => ({ k: r.k as string, n: r.n as number }) },
        { collection: 'a', map: (r: Record<string, unknown>) => ({ k: r.k as string, n: r.n as number }) },
      ],
      groupBy: 'k',
      rowKey: row => row.k,
      refresh: 'eager',
    })

    // Import summarizeUnionPlan directly to compare hashes
    const { summarizeUnionPlan } = await import('../../src/with-formula/materialized-views/dependency-analyzer.js')
    const planA = summarizeUnionPlan(stratA.spec)
    const planB = summarizeUnionPlan(stratB.spec)
    expect(planA).not.toBe(planB)
    expect(planA).toContain('union(a,b)')
    expect(planB).toContain('union(b,a)')
  })

  it('reordering groupBy fields does NOT change queryHash (multi-key groupBy is commutative)', async () => {
    const stratA = withMaterializedView<{ a: string; b: string; n: number }>({
      name: 'commutative-groupby',
      unionSources: [
        { collection: 'x', map: (r: Record<string, unknown>) => ({ a: r.a as string, b: r.b as string, n: r.n as number }) },
        { collection: 'y', map: (r: Record<string, unknown>) => ({ a: r.a as string, b: r.b as string, n: r.n as number }) },
      ],
      groupBy: ['a', 'b'],
      aggregate: { total: sum('n') },
      rowKey: row => `${row.a}|${row.b}`,
      refresh: 'eager',
    })
    const stratB = withMaterializedView<{ a: string; b: string; n: number }>({
      name: 'commutative-groupby',
      unionSources: [
        { collection: 'x', map: (r: Record<string, unknown>) => ({ a: r.a as string, b: r.b as string, n: r.n as number }) },
        { collection: 'y', map: (r: Record<string, unknown>) => ({ a: r.a as string, b: r.b as string, n: r.n as number }) },
      ],
      groupBy: ['b', 'a'], // reversed
      aggregate: { total: sum('n') },
      rowKey: row => `${row.a}|${row.b}`,
      refresh: 'eager',
    })
    const { summarizeUnionPlan } = await import('../../src/with-formula/materialized-views/dependency-analyzer.js')
    expect(summarizeUnionPlan(stratA.spec)).toBe(summarizeUnionPlan(stratB.spec))
  })
})
