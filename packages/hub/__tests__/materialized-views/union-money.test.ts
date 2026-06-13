import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { createNoydb, withMaterializedView } from '../../src/index.js'
import { withAggregate } from '../../src/aggregate/index.js'
import { sum, min, max } from '../../src/aggregate/reducers.js'
import { money } from '../../src/money/descriptor.js'
import type { NoydbStore, EncryptedEnvelope } from '../../src/types.js'

function memory(): NoydbStore {
  const data = new Map<string, EncryptedEnvelope>()
  const k = (v: string, c: string, i: string) => `${v}/${c}/${i}`
  return {
    capabilities: { casAtomic: true, auth: { kind: 'none' } },
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
        if (vname === v) { out[cname] = out[cname] ?? {}; out[cname][id] = env }
      }
      return out
    },
    async saveAll(v, payload) {
      for (const c of Object.keys(payload)) {
        for (const i of Object.keys(payload[c])) { data.set(k(v, c, i), payload[c][i]) }
      }
    },
  }
}

interface MoneyLine extends Record<string, unknown> {
  id: string
  period: string
  amount: number | string
}

interface MoneyRollupRow extends Record<string, unknown> {
  period: string
  total: number | string
}

describe('UNION MV — money-aware aggregation (#350)', () => {
  it('fixed-mode sum via union MV with string-passthrough map yields the exact decimal (not 0)', async () => {
    const rollup = withMaterializedView<MoneyRollupRow>({
      name: 'periodTotals',
      unionSources: [
        {
          collection: 'receipts',
          // Pass the decoded canonical decimal string THROUGH unchanged —
          // this is the shape that previously crashed BigInt('10000.00').
          map: r => ({ period: r.period as string, total: r.amount as string }),
        },
        {
          collection: 'notes',
          map: r => ({ period: r.period as string, total: r.amount as string }),
        },
      ],
      groupBy: 'period',
      aggregate: { total: sum('total') },
      moneyFields: { total: money({ currency: 'EUR', scale: 2 }) },
      rowKey: row => row.period,
      refresh: 'eager',
    })

    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'mv-union-money-fixed-passthrough-passphrase-2026',
      materializedViewStrategies: [rollup],
      aggregateStrategy: withAggregate(),
    })
    const vault = await db.openVault('books')
    vault.collection<MoneyLine>('receipts', {
      schema: z.object({ id: z.string(), period: z.string(), amount: z.union([z.number(), z.string()]) }),
      moneyFields: { amount: money({ currency: 'EUR', scale: 2 }) },
    })
    vault.collection<MoneyLine>('notes', {
      schema: z.object({ id: z.string(), period: z.string(), amount: z.union([z.number(), z.string()]) }),
      moneyFields: { amount: money({ currency: 'EUR', scale: 2 }) },
    })
    const receipts = vault.collection<MoneyLine>('receipts')
    const notes = vault.collection<MoneyLine>('notes')

    await receipts.put('r1', { id: 'r1', period: '2026-05', amount: '10000.00' })
    await receipts.put('r2', { id: 'r2', period: '2026-05', amount: '2500.50' })
    await notes.put('n1', { id: 'n1', period: '2026-05', amount: '500.25' })

    const out = vault.collection<MoneyRollupRow & { _materializedFrom?: unknown }>('periodTotals')
    const row = await out.get('2026-05')
    expect(row).not.toBeNull()
    expect(row?.total).toBe('13000.75') // 10000.00 + 2500.50 + 500.25
  })

  it('float-drift case: Number() in map + 0.10/0.20/0.30 sums to exact 0.60', async () => {
    const rollup = withMaterializedView<MoneyRollupRow>({
      name: 'driftTotals',
      unionSources: [
        {
          collection: 'lines',
          // Deliberately route through Number() — a money descriptor must
          // re-quantize this to the exact scaled integer, not float-drift.
          map: r => ({ period: r.period as string, total: Number(r.amount) }),
        },
      ],
      groupBy: 'period',
      aggregate: { total: sum('total') },
      moneyFields: { total: money({ currency: 'EUR', scale: 2 }) },
      rowKey: row => row.period,
      refresh: 'eager',
    })

    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'mv-union-money-drift-passphrase-2026',
      materializedViewStrategies: [rollup],
      aggregateStrategy: withAggregate(),
    })
    const vault = await db.openVault('books')
    vault.collection<MoneyLine>('lines', {
      schema: z.object({ id: z.string(), period: z.string(), amount: z.union([z.number(), z.string()]) }),
      moneyFields: { amount: money({ currency: 'EUR', scale: 2 }) },
    })
    const lines = vault.collection<MoneyLine>('lines')

    await lines.put('a', { id: 'a', period: 'p', amount: '0.10' })
    await lines.put('b', { id: 'b', period: 'p', amount: '0.20' })
    await lines.put('c', { id: 'c', period: 'p', amount: '0.30' })

    const out = vault.collection<MoneyRollupRow>('driftTotals')
    const row = await out.get('p')
    expect(row?.total).toBe('0.60') // exact, not 0.6000000000000001
  })

  it('money min / max over a union arm return exact decimals', async () => {
    interface MinMaxRow extends Record<string, unknown> {
      period: string
      lo: number | string
      hi: number | string
    }
    const mv = withMaterializedView<MinMaxRow>({
      name: 'minmax',
      unionSources: [
        {
          collection: 'lines',
          map: r => ({ period: r.period as string, lo: r.amount as string, hi: r.amount as string }),
        },
      ],
      groupBy: 'period',
      aggregate: { lo: min('lo'), hi: max('hi') },
      moneyFields: {
        lo: money({ currency: 'EUR', scale: 2 }),
        hi: money({ currency: 'EUR', scale: 2 }),
      },
      rowKey: row => row.period,
      refresh: 'eager',
    })

    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'mv-union-money-minmax-passphrase-2026',
      materializedViewStrategies: [mv],
      aggregateStrategy: withAggregate(),
    })
    const vault = await db.openVault('books')
    vault.collection<MoneyLine>('lines', {
      schema: z.object({ id: z.string(), period: z.string(), amount: z.union([z.number(), z.string()]) }),
      moneyFields: { amount: money({ currency: 'EUR', scale: 2 }) },
    })
    const lines = vault.collection<MoneyLine>('lines')

    await lines.put('a', { id: 'a', period: 'p', amount: '12.34' })
    await lines.put('b', { id: 'b', period: 'p', amount: '99.99' })
    await lines.put('c', { id: 'c', period: 'p', amount: '5.00' })

    const out = vault.collection<MinMaxRow>('minmax')
    const row = await out.get('p')
    expect(row?.lo).toBe('5.00')
    expect(row?.hi).toBe('99.99')
  })

  it('multi-currency sum returns an exact per-currency map', async () => {
    interface MultiLine extends Record<string, unknown> {
      id: string
      period: string
      amount: { amount: number | string; currency: string }
    }
    interface MultiRow extends Record<string, unknown> {
      period: string
      total: { amount: number | string; currency: string }
    }
    const mv = withMaterializedView<MultiRow>({
      name: 'multiTotals',
      unionSources: [
        {
          collection: 'lines',
          map: r => ({
            period: r.period as string,
            total: r.amount as { amount: number | string; currency: string },
          }),
        },
      ],
      groupBy: 'period',
      aggregate: { total: sum('total') },
      moneyFields: { total: money({ currencies: ['EUR', 'USD'] }) },
      rowKey: row => row.period,
      refresh: 'eager',
    })

    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'mv-union-money-multi-passphrase-2026',
      materializedViewStrategies: [mv],
      aggregateStrategy: withAggregate(),
    })
    const vault = await db.openVault('books')
    vault.collection<MultiLine>('lines', {
      schema: z.object({
        id: z.string(),
        period: z.string(),
        amount: z.object({ amount: z.union([z.number(), z.string()]), currency: z.string() }),
      }),
      moneyFields: { amount: money({ currencies: ['EUR', 'USD'] }) },
    })
    const lines = vault.collection<MultiLine>('lines')

    await lines.put('a', { id: 'a', period: 'p', amount: { amount: '10.00', currency: 'EUR' } })
    await lines.put('b', { id: 'b', period: 'p', amount: { amount: '5.50', currency: 'EUR' } })
    await lines.put('c', { id: 'c', period: 'p', amount: { amount: '3.00', currency: 'USD' } })

    const out = vault.collection<MultiRow & { _materializedFrom?: unknown }>('multiTotals')
    const row = await out.get('p')
    expect(row?.total).toEqual({ EUR: '15.50', USD: '3.00' })
  })

  it('single-arm union with money sums exactly (#331 computed-key shape)', async () => {
    interface DatedLine extends Record<string, unknown> {
      id: string
      issuedAt: string
      amount: number | string
    }
    const mv = withMaterializedView<MoneyRollupRow>({
      name: 'monthlyMoney',
      unionSources: [
        {
          collection: 'invoices',
          // Computed bucket key — month sliced from a date field.
          map: r => ({
            period: (r.issuedAt as string).slice(0, 7),
            total: r.amount as string,
          }),
        },
      ],
      groupBy: 'period',
      aggregate: { total: sum('total') },
      moneyFields: { total: money({ currency: 'EUR', scale: 2 }) },
      rowKey: row => row.period,
      refresh: 'eager',
    })

    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'mv-union-money-single-arm-passphrase-2026',
      materializedViewStrategies: [mv],
      aggregateStrategy: withAggregate(),
    })
    const vault = await db.openVault('books')
    vault.collection<DatedLine>('invoices', {
      schema: z.object({ id: z.string(), issuedAt: z.string(), amount: z.union([z.number(), z.string()]) }),
      moneyFields: { amount: money({ currency: 'EUR', scale: 2 }) },
    })
    const inv = vault.collection<DatedLine>('invoices')

    await inv.put('i1', { id: 'i1', issuedAt: '2026-05-01', amount: '100.00' })
    await inv.put('i2', { id: 'i2', issuedAt: '2026-05-20', amount: '50.25' })
    await inv.put('i3', { id: 'i3', issuedAt: '2026-06-01', amount: '7.10' })

    const out = vault.collection<MoneyRollupRow>('monthlyMoney')
    expect((await out.get('2026-05'))?.total).toBe('150.25')
    expect((await out.get('2026-06'))?.total).toBe('7.10')
  })

  it('regression: a union MV WITHOUT moneyFields still sums plain numbers', async () => {
    const mv = withMaterializedView<MoneyRollupRow>({
      name: 'plainTotals',
      unionSources: [
        { collection: 'a', map: r => ({ period: r.period as string, total: r.n as number }) },
        { collection: 'b', map: r => ({ period: r.period as string, total: r.n as number }) },
      ],
      groupBy: 'period',
      aggregate: { total: sum('total') },
      rowKey: row => row.period,
      refresh: 'eager',
    })

    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'mv-union-plain-numeric-passphrase-2026',
      materializedViewStrategies: [mv],
      aggregateStrategy: withAggregate(),
    })
    const vault = await db.openVault('books')
    const a = vault.collection<{ id: string; period: string; n: number }>('a')
    const b = vault.collection<{ id: string; period: string; n: number }>('b')

    await a.put('a1', { id: 'a1', period: 'p', n: 3 })
    await b.put('b1', { id: 'b1', period: 'p', n: 4 })

    const out = vault.collection<MoneyRollupRow>('plainTotals')
    expect((await out.get('p'))?.total).toBe(7)
  })

  it('moneyFields declared without aggregate throws a config error', () => {
    expect(() =>
      withMaterializedView<MoneyRollupRow>({
        name: 'bad-money',
        unionSources: [
          { collection: 'a', map: r => ({ period: r.period as string, total: r.amount as string }) },
        ],
        groupBy: 'period',
        // no aggregate
        moneyFields: { total: money({ currency: 'EUR', scale: 2 }) },
        rowKey: row => row.period,
        refresh: 'eager',
      }),
    ).toThrow(/moneyFields requires aggregate/)
  })
})

describe('UNION MV — queryHash sensitivity to moneyFields (#350)', () => {
  it('declaring moneyFields changes summarizeUnionPlan vs the same spec without it', async () => {
    const base = {
      name: 'hash-money',
      unionSources: [
        { collection: 'a', map: (r: Record<string, unknown>) => ({ period: r.period as string, total: r.amount as string }) },
      ],
      groupBy: 'period',
      aggregate: { total: sum('total') },
      rowKey: (row: { period: string }) => row.period,
      refresh: 'eager' as const,
    }
    const withMoney = withMaterializedView<{ period: string; total: string }>({
      ...base,
      moneyFields: { total: money({ currency: 'EUR', scale: 2 }) },
    })
    const withoutMoney = withMaterializedView<{ period: string; total: string }>({ ...base })

    const { summarizeUnionPlan } = await import('../../src/materialized-views/dependency-analyzer.js')
    const planWith = summarizeUnionPlan(withMoney.spec)
    const planWithout = summarizeUnionPlan(withoutMoney.spec)
    expect(planWith).not.toBe(planWithout)
    expect(planWith).toContain('money(total)')
    expect(planWithout).toContain('money()')
  })
})
