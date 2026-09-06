/**
 * Window functions (#1349) — `.window({ partitionBy, orderBy }).select({ … })`.
 *
 * Pure in-hub post-processing over the query's own result rows. Four things
 * this file exists to pin, because each is the difference between usable and
 * quietly wrong:
 *
 *  1. `rank` and `rowNumber` differ EXACTLY on ties — without a tie in the
 *     fixture the two are indistinguishable and either could be implemented
 *     as the other.
 *  2. Ordering inside a partition is TOTAL: the `orderBy` keys, then the
 *     upstream row order as the final tie-break (a stable sort over indices).
 *     Without that, `lag`/`lead` over equal keys are a coin flip.
 *  3. `runningMoneySum` accumulates the exact BigInt reducer, not floats.
 *  4. The v1 frame is `rows unbounded preceding → current row` and nothing
 *     else — a running aggregate at row i sees rows 0..i of its partition.
 */

import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { Query, type QuerySource } from '../src/kernel/query/index.js'
import {
  withReduce,
  withWindow,
  rowNumber,
  rank,
  lag,
  lead,
  runningSum,
  runningMoneySum,
  count,
} from '../src/with-lookup/reduce/index.js'
import { dateTrunc } from '../src/kernel/query/reduce/date-trunc.js'
import { createNoydb } from '../src/index.js'
import { money } from '../src/via/money/descriptor.js'
import type { NoydbStore, EncryptedEnvelope } from '../src/kernel/types.js'

const AGG = withReduce({ window: withWindow() })

interface Txn {
  id: string
  clientId: string
  date: string
  amount: number
}

const LEDGER: Txn[] = [
  { id: 't1', clientId: 'c1', date: '2026-01-01', amount: 100 },
  { id: 't2', clientId: 'c2', date: '2026-01-03', amount: 5000 },
  { id: 't3', clientId: 'c1', date: '2026-01-05', amount: 250 },
  { id: 't4', clientId: 'c1', date: '2026-02-10', amount: -50 },
  { id: 't5', clientId: 'c2', date: '2026-03-01', amount: 800 },
]

function staticSource<T>(records: T[]): QuerySource<T> {
  return { snapshot: () => records }
}

const q = <T>(rows: T[]) => new Query<T>(staticSource(rows), undefined, undefined, AGG)

// ---------------------------------------------------------------------------
// The headline shape from the issue
// ---------------------------------------------------------------------------

describe('window() > running balance per partition', () => {
  it('computes a running sum, a lag and a row number over the sorted partition', () => {
    const rows = q(LEDGER)
      .window({ partitionBy: 'clientId', orderBy: 'date' })
      .select({ balance: runningSum('amount'), prev: lag('amount', 1), n: rowNumber() })
      .run()

    // Output row order is the QUERY's order (SQL semantics: a window's
    // internal ordering does not reorder the result), so rows come back in
    // LEDGER order with their window values attached.
    expect(rows.map((r) => [r.id, r.balance, r.prev, r.n])).toEqual([
      ['t1', 100, undefined, 1],
      ['t2', 5000, undefined, 1],
      ['t3', 350, 100, 2],
      ['t4', 300, 250, 3],
      ['t5', 5800, 5000, 2],
    ])
  })

  it('leaves the source fields intact on every row', () => {
    const [first] = q(LEDGER)
      .window({ partitionBy: 'clientId', orderBy: 'date' })
      .select({ n: rowNumber() })
      .run()
    expect(first).toEqual({ id: 't1', clientId: 'c1', date: '2026-01-01', amount: 100, n: 1 })
  })

  it('treats the whole relation as one partition when partitionBy is omitted', () => {
    const rows = q(LEDGER).window({ orderBy: 'date' }).select({ n: rowNumber() }).run()
    expect(rows.map((r) => [r.id, r.n])).toEqual([
      ['t1', 1], ['t2', 2], ['t3', 3], ['t4', 4], ['t5', 5],
    ])
  })

  it('honours descending order inside the partition', () => {
    const rows = q(LEDGER)
      .window({ partitionBy: 'clientId', orderBy: { field: 'date', direction: 'desc' } })
      .select({ n: rowNumber(), next: lead('amount', 1) })
      .run()
    expect(rows.map((r) => [r.id, r.n, r.next])).toEqual([
      ['t1', 3, undefined],
      ['t2', 2, undefined],
      ['t3', 2, 100],
      ['t4', 1, 250],
      ['t5', 1, 5000],
    ])
  })
})

// ---------------------------------------------------------------------------
// rank vs rowNumber — the tie case
// ---------------------------------------------------------------------------

interface Score { id: string; region: string; score: number }

const SCORES: Score[] = [
  { id: 's1', region: 'north', score: 10 },
  { id: 's2', region: 'north', score: 20 },
  { id: 's3', region: 'north', score: 20 },
  { id: 's4', region: 'north', score: 30 },
]

describe('window() > rank vs rowNumber differ exactly on ties', () => {
  it('rank repeats then SKIPS; rowNumber never repeats', () => {
    const rows = q(SCORES)
      .window({ partitionBy: 'region', orderBy: { field: 'score', direction: 'desc' } })
      .select({ n: rowNumber(), r: rank() })
      .run()
    // score desc: 30, 20, 20, 10
    const byId = Object.fromEntries(rows.map((x) => [x.id, [x.n, x.r]]))
    expect(byId['s4']).toEqual([1, 1])
    expect(byId['s2']).toEqual([2, 2])
    expect(byId['s3']).toEqual([3, 2]) // ← the whole point: rowNumber 3, rank 2
    expect(byId['s1']).toEqual([4, 4]) // ← rank SKIPS 3
  })

  it('with no orderBy every row is a peer: rank is 1 throughout, rowNumber is not', () => {
    const rows = q(SCORES).window({ partitionBy: 'region' }).select({ n: rowNumber(), r: rank() }).run()
    expect(rows.map((x) => x.r)).toEqual([1, 1, 1, 1])
    expect(rows.map((x) => x.n)).toEqual([1, 2, 3, 4])
  })
})

// ---------------------------------------------------------------------------
// Total ordering
// ---------------------------------------------------------------------------

describe('window() > partition ordering is total', () => {
  const TIED: Txn[] = [
    { id: 'a', clientId: 'c1', date: '2026-01-01', amount: 1 },
    { id: 'b', clientId: 'c1', date: '2026-01-01', amount: 2 },
    { id: 'c', clientId: 'c1', date: '2026-01-01', amount: 3 },
  ]

  it('breaks an orderBy tie by upstream row order, so lag is deterministic', () => {
    const run = () =>
      q(TIED).window({ partitionBy: 'clientId', orderBy: 'date' }).select({ prev: lag('id', 1), n: rowNumber() }).run()
    const first = run()
    expect(first.map((r) => [r.id, r.n, r.prev])).toEqual([
      ['a', 1, undefined],
      ['b', 2, 'a'],
      ['c', 3, 'b'],
    ])
    expect(run()).toEqual(first)
  })

  it('a second orderBy key breaks the first key’s tie before upstream order does', () => {
    const rows = q(TIED)
      .window({ partitionBy: 'clientId', orderBy: ['date', { field: 'amount', direction: 'desc' }] })
      .select({ n: rowNumber() })
      .run()
    expect(rows.map((r) => [r.id, r.n])).toEqual([['a', 3], ['b', 2], ['c', 1]])
  })
})

// ---------------------------------------------------------------------------
// lag / lead offsets and defaults
// ---------------------------------------------------------------------------

describe('window() > lag / lead', () => {
  it('defaults the offset to 1 and returns undefined past the partition edge', () => {
    const rows = q(LEDGER)
      .window({ partitionBy: 'clientId', orderBy: 'date' })
      .select({ p: lag('amount'), n2: lead('amount', 2) })
      .run()
    expect(rows.find((r) => r.id === 't1')!.p).toBeUndefined()
    expect(rows.find((r) => r.id === 't1')!.n2).toBe(-50)
    expect(rows.find((r) => r.id === 't3')!.n2).toBeUndefined()
  })

  it('accepts an explicit default for the out-of-partition case', () => {
    const rows = q(LEDGER)
      .window({ partitionBy: 'clientId', orderBy: 'date' })
      .select({ p: lag('amount', 1, 0) })
      .run()
    expect(rows.find((r) => r.id === 't1')!.p).toBe(0)
  })

  it('refuses a negative or non-integer offset', () => {
    expect(() => lag('amount', -1)).toThrow(/offset/)
    expect(() => lead('amount', 1.5)).toThrow(/offset/)
  })
})

// ---------------------------------------------------------------------------
// The frame: rows unbounded preceding → current row
// ---------------------------------------------------------------------------

describe('window() > v1 frame is rows-unbounded-preceding-to-current-row', () => {
  it('a running aggregate at row i sees exactly rows 0..i of its partition', () => {
    const rows = q(LEDGER)
      .window({ partitionBy: 'clientId', orderBy: 'date' })
      .select({ seen: count() })
      .run()
    expect(rows.map((r) => [r.id, r.seen])).toEqual([
      ['t1', 1], ['t2', 1], ['t3', 2], ['t4', 3], ['t5', 2],
    ])
  })
})

// ---------------------------------------------------------------------------
// dateTrunc partitioning (#1350)
// ---------------------------------------------------------------------------

describe('window() > partitionBy a dateTrunc key', () => {
  it('partitions by the calendar bucket without stamping it on the row', () => {
    const rows = q(LEDGER)
      .window({
        partitionBy: dateTrunc('date', 'month', { timeZone: 'UTC' }),
        orderBy: 'date',
      })
      .select({ balance: runningSum('amount') })
      .run()
    // 2026-01: t1(100), t2(5000), t3(250) → 100, 5100, 5350
    // 2026-02: t4(-50) → -50 ;  2026-03: t5(800) → 800
    expect(rows.map((r) => [r.id, r.balance])).toEqual([
      ['t1', 100], ['t2', 5100], ['t3', 5350], ['t4', -50], ['t5', 800],
    ])
    expect(rows[0]).not.toHaveProperty('date_month')
  })

  it('composes a dateTrunc key with a plain field', () => {
    const rows = q(LEDGER)
      .window({
        partitionBy: ['clientId', dateTrunc('date', 'month', { timeZone: 'UTC' })],
        orderBy: 'date',
      })
      .select({ balance: runningSum('amount') })
      .run()
    expect(rows.map((r) => [r.id, r.balance])).toEqual([
      ['t1', 100], ['t2', 5000], ['t3', 350], ['t4', -50], ['t5', 800],
    ])
  })
})

// ---------------------------------------------------------------------------
// runningMoneySum — exactness
// ---------------------------------------------------------------------------

interface Sale extends Record<string, unknown> { id: string; buyer: string; day: string; total: number | string }

function toMemory(): NoydbStore {
  const data = new Map<string, EncryptedEnvelope>()
  const k = (v: string, c: string, i: string): string => `${v}/${c}/${i}`
  return {
    capabilities: { casAtomic: true, auth: { kind: 'none', required: false, flow: 'static' } },
    async get(v, c, i) { return data.get(k(v, c, i)) ?? null },
    async put(v, c, i, env) { data.set(k(v, c, i), env) },
    async delete(v, c, i) { data.delete(k(v, c, i)) },
    async list(v, c) {
      const prefix = `${v}/${c}/`
      return [...data.keys()].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length))
    },
    async loadAll(v) {
      const out: Record<string, Record<string, EncryptedEnvelope>> = {}
      for (const [key, env] of data) {
        const [vname, cname, id] = key.split('/')
        if (vname === v) { out[cname!] = out[cname!] ?? {}; out[cname!]![id!] = env }
      }
      return out
    },
    async saveAll(v, payload) {
      for (const c of Object.keys(payload)) {
        for (const i of Object.keys(payload[c]!)) { data.set(k(v, c, i), payload[c]![i]!) }
      }
    },
  }
}

async function salesCollection() {
  const db = await createNoydb({
    store: toMemory(),
    user: 'alice',
    secret: 'window-money-secret-2026-issue-1349',
    reduceStrategy: withReduce({ window: withWindow() }),
  })
  const vault = await db.openVault('books')
  vault.collection<Sale>('sales', {
    schema: z.object({
      id: z.string(),
      buyer: z.string(),
      day: z.string(),
      total: z.union([z.number(), z.string()]),
    }),
    moneyFields: { total: money({ currency: 'EUR', scale: 2 }) },
  })
  const sales = vault.collection<Sale>('sales')
  // '0.10' + '0.20' is 0.30000000000000004 in float; the exact reducer says '0.30'.
  await sales.put('a', { id: 'a', buyer: 'acme', day: '2026-01-01', total: '0.10' })
  await sales.put('b', { id: 'b', buyer: 'acme', day: '2026-01-02', total: '0.20' })
  // Past Number.MAX_SAFE_INTEGER as a DECIMAL: Number('9007199254740993.01') + 0.01
  // is 9007199254740994 — the cents are gone entirely. The BigInt reducer keeps them.
  await sales.put('c', { id: 'c', buyer: 'big', day: '2026-01-01', total: '9007199254740993.01' })
  await sales.put('d', { id: 'd', buyer: 'big', day: '2026-01-02', total: '0.01' })
  return sales
}

describe('window() > runningMoneySum is BigInt-exact', () => {
  it('never drifts by a cent on a decimal running balance', async () => {
    const sales = await salesCollection()
    const rows = sales
      .query()
      .window({ partitionBy: 'buyer', orderBy: 'day' })
      .select({ balance: runningMoneySum('total') })
      .run()
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.balance]))
    expect(byId['a']).toBe('0.10')
    expect(byId['b']).toBe('0.30')
  })

  it('stays exact past Number.MAX_SAFE_INTEGER in scaled space', async () => {
    const sales = await salesCollection()
    const rows = sales
      .query()
      .window({ partitionBy: 'buyer', orderBy: 'day' })
      .select({ balance: runningMoneySum('total') })
      .run()
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.balance]))
    expect(byId['c']).toBe('9007199254740993.01')
    expect(byId['d']).toBe('9007199254740993.02')
    // What a float accumulator would have produced for the same running total.
    expect(String(Number('9007199254740993.01') + 0.01)).toBe('9007199254740994')
  })

  it('orders a money field inside the window by MAGNITUDE, not lexically', async () => {
    const sales = await salesCollection()
    // Decoded money values are canonical decimal STRINGS; '9882.00' > '10004.00'
    // lexically. The window comparator is the #1336 post-group rule, which
    // compares two plain decimal numerals by magnitude.
    const rows = sales
      .query()
      .window({ orderBy: { field: 'total', direction: 'desc' } })
      .select({ n: rowNumber() })
      .run()
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.n]))
    expect(byId['c']).toBe(1)
    expect(byId['d']).toBe(4)
    expect(byId['b']).toBe(2)
    expect(byId['a']).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

describe('window() > wiring', () => {
  it('throws without withReduce()', () => {
    const bare = new Query<Txn>(staticSource(LEDGER))
    expect(() => bare.window({ partitionBy: 'clientId' })).toThrow(/@noy-db\/hub\/reduce/)
  })

  // The bundle contract, asserted as behaviour: `withReduce()` on its own must
  // NOT reach the window engine, or the `analytics` scenario pays ~900 gzipped
  // bytes for a feature it never calls (measured +92% before this split).
  // `check-bundle.mjs` carries the matching `WindowedQuery` eager-import canary.
  it('throws with withReduce() but no withWindow(), naming the second opt-in', () => {
    const aggregateOnly = new Query<Txn>(staticSource(LEDGER), undefined, undefined, withReduce())
    expect(() => aggregateOnly.window({ partitionBy: 'clientId' })).toThrow(/withWindow/)
    // …while ordinary aggregation is unaffected by the split.
    expect(
      new Query<Txn>(staticSource(LEDGER), undefined, undefined, withReduce())
        .groupBy('clientId')
        .aggregate({ n: count() })
        .run().length,
    ).toBe(2)
  })

  it('runs after the query’s own where/orderBy/limit', () => {
    const rows = q(LEDGER)
      .where('clientId', '==', 'c1')
      .orderBy('date', 'desc')
      .window({ partitionBy: 'clientId', orderBy: 'date' })
      .select({ n: rowNumber() })
      .run()
    expect(rows.map((r) => [r.id, r.n])).toEqual([['t4', 3], ['t3', 2], ['t1', 1]])
  })

  it('returns an empty array for an empty match set', () => {
    const rows = q(LEDGER).where('clientId', '==', 'nope').window({}).select({ n: rowNumber() }).run()
    expect(rows).toEqual([])
  })
})
