/**
 * Post-group `having()` / `orderBy()` / `limit()` (#1336).
 *
 * These three sit on `GroupedReduction` — i.e. AFTER `.aggregate()` — and are
 * pure post-processing over the reduced rows. The regression risk this file
 * exists to pin is that `orderBy` now names two different operations depending
 * on where it sits in the chain: on `Query` it sorts RECORDS before grouping;
 * on `GroupedReduction` it sorts REDUCED ROWS after. The pre-group meaning must
 * not shift. What the last describe block actually MEASURED: a pre-group
 * orderBy/limit was never consulted on the grouped path at all — the buckets
 * come from the candidate/filter pipeline only — so post-group ordering is the
 * only ordering a grouped query has ever had. That is pinned there so the
 * distinction cannot silently become a change.
 */

import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { Query, type QuerySource } from '../src/kernel/query/index.js'
import { count, sum, withReduce } from '../src/with-lookup/reduce/index.js'
import { dateTrunc } from '../src/kernel/query/date-trunc.js'
import { createNoydb } from '../src/index.js'
import { money } from '../src/via/money/descriptor.js'
import type { NoydbStore, EncryptedEnvelope } from '../src/kernel/types.js'

const AGG = withReduce()

interface Invoice {
  id: string
  status: 'draft' | 'open' | 'paid'
  clientId: string
  amount: number
}

const SAMPLE: Invoice[] = [
  { id: 'a', status: 'open', clientId: 'c1', amount: 100 },
  { id: 'b', status: 'open', clientId: 'c1', amount: 250 },
  { id: 'c', status: 'open', clientId: 'c2', amount: 5000 },
  { id: 'd', status: 'paid', clientId: 'c2', amount: 800 },
  { id: 'e', status: 'paid', clientId: 'c3', amount: 1500 },
  { id: 'f', status: 'open', clientId: 'c4', amount: 20 },
]

function staticSource<T>(records: T[]): QuerySource<T> {
  return { snapshot: () => records }
}

const grouped = () =>
  new Query<Invoice>(staticSource(SAMPLE), undefined, undefined, AGG)
    .groupBy('clientId')
    .aggregate({ total: sum('amount'), n: count() })

// ---------------------------------------------------------------------------
// having()
// ---------------------------------------------------------------------------

describe('groupBy > having()', () => {
  it('filters on the reduced row, not on the source records', () => {
    expect(grouped().having((r) => (r.total as number) >= 1000).run()).toEqual([
      { clientId: 'c2', total: 5800, n: 2 },
      { clientId: 'c3', total: 1500, n: 1 },
    ])
  })

  it('can predicate on the group key as well as a reducer output', () => {
    expect(grouped().having((r) => r.clientId === 'c1').run()).toEqual([
      { clientId: 'c1', total: 350, n: 2 },
    ])
  })

  it('ANDs successive having() calls', () => {
    expect(
      grouped()
        .having((r) => (r.n as number) === 2)
        .having((r) => (r.total as number) > 1000)
        .run(),
    ).toEqual([{ clientId: 'c2', total: 5800, n: 2 }])
  })

  it('returns an empty array when nothing survives', () => {
    expect(grouped().having(() => false).run()).toEqual([])
  })

  it('is immutable — having() does not mutate the reduction it came from', () => {
    const base = grouped()
    const narrowed = base.having((r) => (r.total as number) > 1000)
    expect(narrowed.run()).toHaveLength(2)
    expect(base.run()).toHaveLength(4)
  })
})

// ---------------------------------------------------------------------------
// post-group orderBy() / limit()
// ---------------------------------------------------------------------------

describe('groupBy > post-group orderBy() and limit()', () => {
  it('orders by a reduced key', () => {
    expect(grouped().orderBy('total', 'desc').run().map((r) => r.clientId)).toEqual([
      'c2',
      'c3',
      'c1',
      'c4',
    ])
  })

  it('orders by the group key', () => {
    expect(grouped().orderBy('clientId', 'desc').run().map((r) => r.clientId)).toEqual([
      'c4',
      'c3',
      'c2',
      'c1',
    ])
  })

  it('treats successive orderBy() calls as tie-breakers', () => {
    const rows = grouped().orderBy('n', 'desc').orderBy('clientId', 'asc').run()
    expect(rows.map((r) => r.clientId)).toEqual(['c1', 'c2', 'c3', 'c4'])
  })

  it('limits after ordering, not before', () => {
    expect(
      grouped()
        .orderBy('total', 'desc')
        .limit(2)
        .run()
        .map((r) => r.clientId),
    ).toEqual(['c2', 'c3'])
  })

  it('applies having() before ordering and limiting — the documented order', () => {
    expect(
      grouped()
        .having((r) => (r.total as number) > 300)
        .orderBy('total', 'asc')
        .limit(2)
        .run()
        .map((r) => r.clientId),
    ).toEqual(['c1', 'c3'])
  })

  it('defaults to ascending and tolerates a limit past the end', () => {
    expect(grouped().orderBy('total').limit(99).run().map((r) => r.clientId)).toEqual([
      'c4',
      'c1',
      'c3',
      'c2',
    ])
  })

  it('refuses a negative or non-integer limit', () => {
    expect(() => grouped().limit(-1)).toThrow(/limit/)
    expect(() => grouped().limit(1.5)).toThrow(/limit/)
  })
})

// ---------------------------------------------------------------------------
// dateTrunc'd group key (#1350 interaction)
// ---------------------------------------------------------------------------

describe('groupBy > post-group ops over a dateTrunc() group key', () => {
  interface Sale { id: string; date: Date; amount: number }
  const SALES: Sale[] = [
    { id: '1', date: new Date('2026-01-15T12:00:00Z'), amount: 100 },
    { id: '2', date: new Date('2026-01-20T12:00:00Z'), amount: 50 },
    { id: '3', date: new Date('2026-03-02T12:00:00Z'), amount: 900 },
    { id: '4', date: new Date('2026-02-10T12:00:00Z'), amount: 10 },
  ]

  const byMonth = () =>
    new Query<Sale>(staticSource(SALES), undefined, undefined, AGG)
      .groupBy(dateTrunc('date', 'month', { timeZone: 'UTC' }))
      .aggregate({ total: sum('amount') })

  it('orders and limits over the derived calendar key', () => {
    expect(byMonth().orderBy('date_month', 'desc').limit(2).run()).toEqual([
      { date_month: '2026-03-01', total: 900 },
      { date_month: '2026-02-01', total: 10 },
    ])
  })

  it('having() sees the derived key and the reduced value together', () => {
    expect(
      byMonth()
        .having((r) => (r.total as number) >= 100 && (r.date_month as string) < '2026-03-01')
        .run(),
    ).toEqual([{ date_month: '2026-01-01', total: 150 }])
  })
})

// ---------------------------------------------------------------------------
// Money / Via-dressed reduced values
// ---------------------------------------------------------------------------

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

interface Sale extends Record<string, unknown> { id: string; buyer: string; total: number | string }

async function salesCollection() {
  const db = await createNoydb({
    store: toMemory(),
    user: 'alice',
    secret: 'having-money-secret-2026-issue-1336',
    reduceStrategy: withReduce(),
  })
  const vault = await db.openVault('books')
  vault.collection<Sale>('sales', {
    schema: z.object({ id: z.string(), buyer: z.string(), total: z.union([z.number(), z.string()]) }),
    moneyFields: { total: money({ currency: 'EUR', scale: 2 }) },
  })
  const sales = vault.collection<Sale>('sales')
  // Chosen so the exact decimal strings ('9882.00' vs '10004.00') sort the
  // OPPOSITE way lexically to how they sort numerically — a lexical comparator
  // would pass a laxer assertion and fail this one.
  await sales.put('a', { id: 'a', buyer: 'acme', total: '9882.00' })
  await sales.put('b', { id: 'b', buyer: 'globex', total: '10004.00' })
  await sales.put('c', { id: 'c', buyer: 'initech', total: '0.10' })
  await sales.put('d', { id: 'd', buyer: 'initech', total: '0.20' })
  return sales
}

describe('groupBy > having() and ordering over a money-dressed reduced value', () => {
  it('predicates on the exact reduced value, not on a formatted string', async () => {
    const sales = await salesCollection()
    const rows = sales
      .query()
      .groupBy('buyer')
      .aggregate({ total: sum('total') })
      // The reduced money value is the exact canonical decimal string
      // ('9882.00'), not a formatted label — so Number() on it is exact.
      // (`sum()` types as Reducer<number> here because the money rewrite is a
      // runtime one; the runtime value is the decimal string, hence Number().)
      .having((r) => Number(r.total) > 1000)
      .run() as Array<Record<string, unknown>>
    expect(rows.map((r) => r.buyer).sort()).toEqual(['acme', 'globex'])
    expect(rows.find((r) => r.buyer === 'acme')!.total).toBe('9882.00')
  })

  it('orders money-reduced decimal strings by magnitude, not lexically', async () => {
    const sales = await salesCollection()
    const rows = sales
      .query()
      .groupBy('buyer')
      .aggregate({ total: sum('total') })
      .orderBy('total', 'desc')
      .run() as Array<Record<string, unknown>>
    expect(rows.map((r) => r.buyer)).toEqual(['globex', 'acme', 'initech'])
    expect(rows[2]!.total).toBe('0.30')
  })
})

// ---------------------------------------------------------------------------
// The regression guard: pre-group orderBy/limit are unchanged
// ---------------------------------------------------------------------------

describe('groupBy > pre-group orderBy()/limit() keep their existing meaning', () => {
  // MEASURED, not assumed: `.groupBy()` builds its record set from the
  // candidate/filter pipeline only — `plan.orderBy`, `plan.limit` and
  // `plan.offset` are never consulted on the grouped path (builder.ts,
  // `groupBy`'s `executeRecords` closure). These three cases pin that
  // pre-existing behaviour so the #1336 post-group ops cannot be mistaken for
  // a change to it: post-group `orderBy`/`limit` are the ONLY ordering and
  // capping a grouped query has ever honoured.
  it('pre-group orderBy() does not reorder buckets — emission stays source first-seen', () => {
    const asc = new Query<Invoice>(staticSource(SAMPLE), undefined, undefined, AGG)
      .orderBy('amount', 'asc')
      .groupBy('clientId')
      .aggregate({ total: sum('amount') })
      .run()
    const desc = new Query<Invoice>(staticSource(SAMPLE), undefined, undefined, AGG)
      .orderBy('amount', 'desc')
      .groupBy('clientId')
      .aggregate({ total: sum('amount') })
      .run()
    const bare = new Query<Invoice>(staticSource(SAMPLE), undefined, undefined, AGG)
      .groupBy('clientId')
      .aggregate({ total: sum('amount') })
      .run()
    expect(asc.map((r) => r.clientId)).toEqual(['c1', 'c2', 'c3', 'c4'])
    expect(desc).toEqual(asc)
    expect(bare).toEqual(asc)
  })

  it('pre-group limit() does not narrow the grouped record set', () => {
    const rows = new Query<Invoice>(staticSource(SAMPLE), undefined, undefined, AGG)
      .orderBy('amount', 'asc')
      .limit(3)
      .groupBy('clientId')
      .aggregate({ total: sum('amount'), n: count() })
      .run()
    expect(rows).toEqual([
      { clientId: 'c1', total: 350, n: 2 },
      { clientId: 'c2', total: 5800, n: 2 },
      { clientId: 'c3', total: 1500, n: 1 },
      { clientId: 'c4', total: 20, n: 1 },
    ])
  })

  it('pre-group orderBy()/limit() on the ROW pipeline is untouched by this feature', () => {
    const ids = new Query<Invoice>(staticSource(SAMPLE), undefined, undefined, AGG)
      .orderBy('amount', 'desc')
      .limit(2)
      .toArray()
      .map((r) => r.id)
    expect(ids).toEqual(['c', 'e'])
  })

  it('a pre-group orderBy() in the chain does not interfere with a post-group one', () => {
    const rows = new Query<Invoice>(staticSource(SAMPLE), undefined, undefined, AGG)
      .orderBy('amount', 'asc')
      .groupBy('clientId')
      .aggregate({ total: sum('amount') })
      .orderBy('total', 'desc')
      .limit(2)
      .run()
    expect(rows).toEqual([
      { clientId: 'c2', total: 5800 },
      { clientId: 'c3', total: 1500 },
    ])
  })
})

// ---------------------------------------------------------------------------
// live() and runAsync() carry the post-group ops
// ---------------------------------------------------------------------------

describe('groupBy > post-group ops apply on every terminal', () => {
  it('live() emits post-processed rows and keeps doing so after a change', () => {
    let records: Invoice[] = [...SAMPLE]
    const listeners = new Set<() => void>()
    const source: QuerySource<Invoice> = {
      snapshot: () => records,
      subscribe: (cb) => {
        listeners.add(cb)
        return () => listeners.delete(cb)
      },
    }
    const live = new Query<Invoice>(source, undefined, undefined, AGG)
      .groupBy('clientId')
      .aggregate({ total: sum('amount') })
      .having((r) => (r.total as number) > 300)
      .orderBy('total', 'desc')
      .limit(2)
      .live()

    expect(live.value!.map((r) => r.clientId)).toEqual(['c2', 'c3'])
    records = [...records, { id: 'g', status: 'open', clientId: 'c4', amount: 9000 }]
    for (const cb of listeners) cb()
    expect(live.value!.map((r) => r.clientId)).toEqual(['c4', 'c2'])
    live.stop()
  })

  it('runAsync() applies the post-group ops too', async () => {
    const rows = await grouped()
      .having((r) => (r.total as number) > 300)
      .orderBy('total', 'asc')
      .limit(1)
      .runAsync()
    expect(rows).toEqual([{ clientId: 'c1', total: 350, n: 2 }])
  })
})
