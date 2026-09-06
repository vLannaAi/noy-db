/**
 * #1411 (the `window` half) — a materialized view can DECLARE a running
 * total, instead of the consumer hand-writing the loop.
 *
 * The pilot's report is the specification: their "expense-first ordering
 * across prior payments" is a running total over an ordered partition, exact
 * in money, and today it lives in a hand-rolled helper next to a parity test
 * whose only job is to prove the hand-rolled version still agrees with the raw
 * rows. That parity test is pure overhead that exists *because* the rule could
 * not be declared.
 *
 * ⭐ **WHY THIS IS SOUND HERE AND `derive` IS DELIBERATELY NOT.** `derive` is
 * documented as pure, single-row, no cross-row access — a window is the
 * opposite of all three. The difference is that materialization is a FULL
 * RECOMPUTE: the executor holds the complete row set before it writes any of
 * it, so an order-dependent, cross-row pass is computable exactly once, over
 * exactly the rows that will be stored. Its output is then an ordinary column
 * on the row.
 *
 * ⚠️ **The money case is the one that has to be right**, and it is why this
 * does not simply call `applyWindow`: `Query.window().select()` rewrites
 * reducer slots through the collection's Via pipeline, and a UNION-mode MV has
 * no collection — its rows are MAPPED. It has the same answer `aggregate`
 * already uses: the MV's own `moneyFields` descriptors, bound through the
 * kernel's Via port. `runningMoneySum` is exact for exactly the reason `sum`
 * already is.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, withMaterializedView, MaterializedViewConfigError } from '../src/index.js'
import { memoryStore } from '../src/kernel/memory-store.js'
import { money } from '../src/via/money/descriptor.js'
import { withReduce } from '../src/with-lookup/reduce/index.js'
import { sum, runningMoneySum, rowNumber, lag } from '../src/with-lookup/reduce/index.js'

const SECRET = 'issue-1411-mv-window-secret'
const THB = money({ currency: 'THB', scale: 2 })

interface Payment extends Record<string, unknown> { id: string; client: string; seq: number; amount: string }
interface Row extends Record<string, unknown> { client: string; seq: number }

async function vaultWith(view: Record<string, unknown>) {
  const mv = withMaterializedView<Row>({ name: 'rollup', ...view } as never)
  const db = await createNoydb({
    store: memoryStore(),
    user: 'o',
    secret: SECRET,
    reduceStrategy: withReduce(),
    materializedViewStrategies: [mv],
  })
  const vault = await db.openVault('books')
  const payments = vault.collection<Payment>('payments', { moneyFields: { amount: THB } })
  return { vault, payments, out: vault.collection<Record<string, unknown>>('rollup') }
}

/** The pilot's shape: a running total per client, in declaration order. */
const RUNNING_TOTAL_VIEW = {
  refresh: 'eager',
  unionSources: [
    {
      collection: 'payments',
      map: (r: Record<string, unknown>) => ({
        client: r['client'],
        seq: r['seq'],
        amount: r['amount'],
      }),
    },
  ],
  moneyFields: { amount: THB, paidSoFar: THB },
  window: {
    partitionBy: 'client',
    orderBy: 'seq',
    select: { paidSoFar: runningMoneySum('amount'), n: rowNumber() },
  },
  rowKey: (row: Record<string, unknown>) => `${String(row['client'])}:${String(row['seq'])}`,
}

describe('#1411 — a declared window computes a running total', () => {
  it('accumulates within a partition, in the declared order, and restarts per partition', async () => {
    const { payments, out } = await vaultWith(RUNNING_TOTAL_VIEW)
    await payments.put('p1', { id: 'p1', client: 'a', seq: 1, amount: '10.00' })
    await payments.put('p2', { id: 'p2', client: 'a', seq: 2, amount: '5.50' })
    await payments.put('p3', { id: 'p3', client: 'b', seq: 1, amount: '99.00' })

    const rows = await out.list()
    const byKey = new Map(rows.map(r => [`${String(r['client'])}:${String(r['seq'])}`, r]))
    expect(byKey.get('a:1')?.['paidSoFar']).toBe('10.00')
    expect(byKey.get('a:2')?.['paidSoFar']).toBe('15.50')
    // Client b starts its own running total — a partition is not a continuation.
    expect(byKey.get('b:1')?.['paidSoFar']).toBe('99.00')
    expect(byKey.get('b:1')?.['n']).toBe(1)
    expect(byKey.get('a:2')?.['n']).toBe(2)
  })

  it('⭐ stays EXACT in money — the property the hand-rolled loop exists to protect', async () => {
    const { payments, out } = await vaultWith(RUNNING_TOTAL_VIEW)
    // Three tenths: 0.1 + 0.2 + 0.3 is 0.6000000000000001 in float.
    await payments.put('p1', { id: 'p1', client: 'a', seq: 1, amount: '0.10' })
    await payments.put('p2', { id: 'p2', client: 'a', seq: 2, amount: '0.20' })
    await payments.put('p3', { id: 'p3', client: 'a', seq: 3, amount: '0.30' })

    const rows = await out.list()
    const totals = rows
      .sort((x, y) => Number(x['seq']) - Number(y['seq']))
      .map(r => r['paidSoFar'])
    expect(totals).toEqual(['0.10', '0.30', '0.60'])
  })

  it('refreshes the WHOLE partition when one row changes — a running total is not per-row', async () => {
    // The property that makes a window different from `derive`: inserting a
    // row early in a partition moves every later row's total. A per-row
    // recompute would leave the tail stale, so this pins that the recompute
    // sees the whole set.
    const { payments, out } = await vaultWith(RUNNING_TOTAL_VIEW)
    await payments.put('p2', { id: 'p2', client: 'a', seq: 2, amount: '5.00' })
    await payments.put('p3', { id: 'p3', client: 'a', seq: 3, amount: '5.00' })
    let rows: Record<string, unknown>[] = await out.list()
    expect(rows.find(r => r['seq'] === 3)?.['paidSoFar']).toBe('10.00')

    await payments.put('p1', { id: 'p1', client: 'a', seq: 1, amount: '1.00' })
    rows = await out.list()
    expect(rows.find(r => r['seq'] === 3)?.['paidSoFar']).toBe('11.00')
    expect(rows.find(r => r['seq'] === 2)?.['paidSoFar']).toBe('6.00')
  })

  it('supports the navigation functions too, not only running aggregates', async () => {
    const { payments, out } = await vaultWith({
      ...RUNNING_TOTAL_VIEW,
      window: {
        partitionBy: 'client',
        orderBy: 'seq',
        select: { prev: lag('amount') },
      },
    })
    await payments.put('p1', { id: 'p1', client: 'a', seq: 1, amount: '10.00' })
    await payments.put('p2', { id: 'p2', client: 'a', seq: 2, amount: '5.50' })
    const rows = await out.list()
    expect(rows.find(r => r['seq'] === 1)?.['prev']).toBeUndefined()
    expect(rows.find(r => r['seq'] === 2)?.['prev']).toBe('10.00')
  })
})

describe('#1411 — the window runs AFTER groupBy/aggregate', () => {
  it('accumulates over the aggregated rows, not the raw ones', async () => {
    // The pilot's real shape: aggregate per (client, period), then a running
    // total ACROSS periods. If the window ran before grouping it would
    // accumulate over raw rows and every number would be wrong.
    const { payments, out } = await vaultWith({
      refresh: 'eager',
      unionSources: [
        {
          collection: 'payments',
          map: (r: Record<string, unknown>) => ({ client: r['client'], seq: r['seq'], amount: r['amount'] }),
        },
      ],
      groupBy: ['client', 'seq'],
      aggregate: { total: sum('amount') },
      moneyFields: { amount: THB, total: THB, cumulative: THB },
      window: {
        partitionBy: 'client',
        orderBy: 'seq',
        select: { cumulative: runningMoneySum('total') },
      },
      rowKey: (row: Record<string, unknown>) => `${String(row['client'])}:${String(row['seq'])}`,
    })
    // Two rows in period 1 collapse to one aggregated row of 30.00.
    await payments.put('p1', { id: 'p1', client: 'a', seq: 1, amount: '10.00' })
    await payments.put('p2', { id: 'p2', client: 'a', seq: 1, amount: '20.00' })
    await payments.put('p3', { id: 'p3', client: 'a', seq: 2, amount: '5.00' })

    const rows = await out.list()
    expect(rows.find(r => r['seq'] === 1)?.['total']).toBe('30.00')
    expect(rows.find(r => r['seq'] === 1)?.['cumulative']).toBe('30.00')
    expect(rows.find(r => r['seq'] === 2)?.['cumulative']).toBe('35.00')
  })
})

describe('#1411 — the declaration is checked, and folds into queryHash', () => {
  it('refuses a window whose select slot collides with a group key', async () => {
    // Same rule `derive` has, for the same reason: a group key is the row's
    // identity and feeds `rowKey`, so overwriting it re-homes the row.
    await expect(
      vaultWith({
        refresh: 'eager',
        unionSources: [{ collection: 'payments', map: (r: Record<string, unknown>) => ({ client: r['client'], amount: r['amount'] }) }],
        groupBy: 'client',
        aggregate: { total: sum('amount') },
        window: { partitionBy: 'client', select: { client: rowNumber() } },
        rowKey: (row: Record<string, unknown>) => String(row['client']),
      }),
    ).rejects.toThrow(MaterializedViewConfigError)
  })

  it('refuses a window with an empty select — a window that selects nothing computes nothing', async () => {
    await expect(
      vaultWith({
        refresh: 'eager',
        unionSources: [{ collection: 'payments', map: (r: Record<string, unknown>) => ({ client: r['client'] }) }],
        window: { partitionBy: 'client', select: {} },
        rowKey: (row: Record<string, unknown>) => String(row['client']),
      }),
    ).rejects.toThrow(MaterializedViewConfigError)
  })

  it('changing the window changes the queryHash, so a stored view refreshes', async () => {
    const { summarizeUnionPlan } = await import('../src/with-formula/materialized-views/dependency-analyzer.js')
    const base = RUNNING_TOTAL_VIEW as never
    const reordered = {
      ...RUNNING_TOTAL_VIEW,
      window: { ...RUNNING_TOTAL_VIEW.window, orderBy: 'client' },
    } as never
    const renamedSlot = {
      ...RUNNING_TOTAL_VIEW,
      window: { ...RUNNING_TOTAL_VIEW.window, select: { other: runningMoneySum('amount'), n: rowNumber() } },
    } as never
    expect(summarizeUnionPlan(base)).not.toBe(summarizeUnionPlan(reordered))
    expect(summarizeUnionPlan(base)).not.toBe(summarizeUnionPlan(renamedSlot))
    // …and identical declarations still agree, so the hash is deterministic
    // rather than identity-based.
    expect(summarizeUnionPlan(base)).toBe(summarizeUnionPlan({ ...RUNNING_TOTAL_VIEW } as never))
  })
})
