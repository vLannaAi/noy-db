/**
 * #1340 — `scan().aggregate([specA, specB])` (one pass, N reducer states) and
 * `scan().groupBy(key, { maxGroups }).aggregate(spec)`.
 *
 * The load-bearing cases:
 *   - a multi-spec scan reads each page EXACTLY ONCE (counted, not inferred)
 *   - a grouped scan equals the eager `groupBy().aggregate().run()` over the
 *     same records
 *   - `maxGroups` refuses LOUDLY at the right cardinality, naming the option
 *     and the observed group count — it never truncates
 *   - money stays BigInt-exact through the grouped scan path
 *   - a `dateTrunc()` derived key groups a scan (the monthly-rollup shape)
 */

import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { createNoydb } from '../src/kernel/noydb.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot, ListPageResult } from '../src/kernel/types.js'
import { ConflictError, GroupCardinalityError } from '../src/kernel/errors.js'
import { ScanBuilder, type ScanPageProvider } from '../src/kernel/query/index.js'
import { dateTrunc } from '../src/kernel/query/date-trunc.js'
import { count, sum, avg, max, median, withReduce, GROUPBY_MAX_CARDINALITY } from '../src/with-lookup/reduce/index.js'
import { SCAN_GROUPBY_DEFAULT_MAX_GROUPS } from '../src/kernel/query/scan-builder.js'
import { money } from '../src/via/money/index.js'

/** Inline memory adapter with a real `listPage` — same shape as the scan tests. */
function toMemory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function getCollection(c: string, col: string): Map<string, EncryptedEnvelope> {
    let comp = store.get(c)
    if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col)
    if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    name: 'memory',
    async get(c, col, id) { return store.get(c)?.get(col)?.get(id) ?? null },
    async put(c, col, id, env, ev) {
      const coll = getCollection(c, col)
      const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(c, col, id) { store.get(c)?.get(col)?.delete(id) },
    async list(c, col) { const coll = store.get(c)?.get(col); return coll ? [...coll.keys()] : [] },
    async loadAll(c) {
      const comp = store.get(c); const s: VaultSnapshot = {}
      if (comp) for (const [n, coll] of comp) {
        if (!n.startsWith('_')) {
          const r: Record<string, EncryptedEnvelope> = {}
          for (const [id, e] of coll) r[id] = e
          s[n] = r
        }
      }
      return s
    },
    async saveAll(c, data) {
      const comp = new Map<string, Map<string, EncryptedEnvelope>>()
      for (const [name, records] of Object.entries(data)) {
        const coll = new Map<string, EncryptedEnvelope>()
        for (const [id, env] of Object.entries(records)) coll.set(id, env)
        comp.set(name, coll)
      }
      const existing = store.get(c)
      if (existing) for (const [name, coll] of existing) if (name.startsWith('_')) comp.set(name, coll)
      store.set(c, comp)
    },
    async listPage(c, col, cursor, limit = 100): Promise<ListPageResult> {
      const coll = store.get(c)?.get(col)
      if (!coll) return { items: [], nextCursor: null }
      const ids = [...coll.keys()].sort()
      const start = cursor ? parseInt(cursor, 10) : 0
      const end = Math.min(start + limit, ids.length)
      const items: ListPageResult['items'] = []
      for (let i = start; i < end; i++) {
        const id = ids[i]!
        const envelope = coll.get(id)
        if (envelope) items.push({ id, envelope })
      }
      return { items, nextCursor: end < ids.length ? String(end) : null }
    },
  }
}

/** Page provider that COUNTS its reads — the single-pass proof. */
function countingProvider<T>(records: T[]): { provider: ScanPageProvider<T>; reads: () => number } {
  let reads = 0
  return {
    reads: () => reads,
    provider: {
      async listPage(opts) {
        reads++
        const limit = opts.limit ?? 100
        const start = opts.cursor ? parseInt(opts.cursor, 10) : 0
        const end = Math.min(start + limit, records.length)
        return {
          items: records.slice(start, end),
          nextCursor: end < records.length ? String(end) : null,
        }
      },
    },
  }
}

interface Row extends Record<string, unknown> {
  id: string
  status: 'open' | 'paid'
  clientId: string
  amount: number
  closedAt: string
}

function rows(n: number): Row[] {
  const out: Row[] = []
  for (let i = 0; i < n; i++) {
    out.push({
      id: `r-${String(i).padStart(4, '0')}`,
      status: i % 2 === 0 ? 'open' : 'paid',
      clientId: `c-${i % 5}`,
      amount: (i + 1) * 10,
      closedAt: `2026-0${(i % 3) + 1}-1${i % 9}`,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// 1. Multi-spec aggregate — one pass, N reducer states
// ---------------------------------------------------------------------------

describe('#1340 > scan().aggregate([specA, specB])', () => {
  it('reads each page EXACTLY ONCE for N specs (counted)', async () => {
    const data = rows(250)
    const { provider, reads } = countingProvider(data)
    const scan = new ScanBuilder<Row>(provider, 100)

    const [a, b, c] = await scan.aggregate([
      { n: count() },
      { total: sum('amount') },
      { biggest: max('amount') },
    ])

    // 250 records / pageSize 100 → 3 page reads for ONE pass.
    expect(reads()).toBe(3)
    expect(a.n).toBe(250)
    expect(b.total).toBe(data.reduce((s, r) => s + r.amount, 0))
    expect(c.biggest).toBe(2500)
  })

  it('agrees value-for-value with running each spec on its own scan', async () => {
    const data = rows(60)
    const one = new ScanBuilder<Row>(countingProvider(data).provider, 25)
    const two = new ScanBuilder<Row>(countingProvider(data).provider, 25)

    const combined = await one.where('status', '==', 'open').aggregate([
      { n: count() },
      { avgAmount: avg('amount') },
    ])
    const separateN = await two.where('status', '==', 'open').aggregate({ n: count() })
    const separateAvg = await two.where('status', '==', 'open').aggregate({ avgAmount: avg('amount') })

    expect(combined[0]).toEqual(separateN)
    expect(combined[1]).toEqual(separateAvg)
  })

  it('still accepts the single-spec form unchanged', async () => {
    const data = rows(10)
    const scan = new ScanBuilder<Row>(countingProvider(data).provider, 4)
    const res = await scan.aggregate({ n: count() })
    expect(res.n).toBe(10)
  })
})

// ---------------------------------------------------------------------------
// 2. Grouped scan — equality with the eager path
// ---------------------------------------------------------------------------

describe('#1340 > scan().groupBy().aggregate()', () => {
  it('equals the eager groupBy().aggregate() over the same records', async () => {
    const db = await createNoydb({
      store: toMemory(),
      user: 'alice',
      secret: 'scan-groupby-secret-1340-equality',
      reduceStrategy: withReduce(),
    })
    const vault = await db.openVault('books')
    const invoices = vault.collection<Row>('invoices')
    for (const r of rows(60)) await invoices.put(r.id, r)

    const streamed = await invoices
      .scan({ pageSize: 7 })
      .where('status', '==', 'open')
      .groupBy('clientId')
      .aggregate({ total: sum('amount'), n: count() })

    const eager = invoices
      .query()
      .where('status', '==', 'open')
      .groupBy('clientId')
      .aggregate({ total: sum('amount'), n: count() })
      .run()

    const sortByKey = <R extends Record<string, unknown>>(xs: readonly R[]): R[] =>
      [...xs].sort((x, y) => String(x.clientId).localeCompare(String(y.clientId)))
    expect(sortByKey(streamed)).toEqual(sortByKey(eager))
  })

  it('reads each page exactly once for a grouped aggregate', async () => {
    const data = rows(250)
    const { provider, reads } = countingProvider(data)
    const out = await new ScanBuilder<Row>(provider, 100)
      .groupBy('clientId')
      .aggregate({ n: count() })
    expect(reads()).toBe(3)
    expect(out).toHaveLength(5)
    expect(out.every((r) => r.n === 50)).toBe(true)
  })

  it('buckets null and undefined group keys separately, like the eager path', async () => {
    const data = [
      { id: 'a', k: null },
      { id: 'b' },
      { id: 'c', k: null },
      { id: 'd', k: 'x' },
    ] as Array<Record<string, unknown>>
    const out = await new ScanBuilder<Record<string, unknown>>(countingProvider(data).provider, 2)
      .groupBy('k')
      .aggregate({ n: count() })
    expect(out).toHaveLength(3)
    expect(out.map((r) => r.n)).toEqual([2, 1, 1])
  })
})

// ---------------------------------------------------------------------------
// 3. maxGroups — the declared memory budget, refused loudly
// ---------------------------------------------------------------------------

describe('#1340 > maxGroups', () => {
  it('throws GroupCardinalityError at the declared ceiling, naming the option and the count', async () => {
    const data = rows(20) // 5 distinct clientIds
    const scan = new ScanBuilder<Row>(countingProvider(data).provider, 5)

    const err = await scan
      .groupBy('clientId', { maxGroups: 3 })
      .aggregate({ n: count() })
      .then(() => null, (e: unknown) => e)

    expect(err).toBeInstanceOf(GroupCardinalityError)
    const e = err as GroupCardinalityError
    expect(e.maxGroups).toBe(3)
    expect(e.cardinality).toBe(4) // refused as the 4th bucket would be created
    expect(e.message).toContain('maxGroups')
    expect(e.message).toContain('4')
  })

  it('does not truncate — a grouping that fits the budget returns every group', async () => {
    const data = rows(20)
    const out = await new ScanBuilder<Row>(countingProvider(data).provider, 5)
      .groupBy('clientId', { maxGroups: 5 })
      .aggregate({ n: count() })
    expect(out).toHaveLength(5)
  })

  it('defaults to the GROUPBY_MAX_CARDINALITY ceiling', async () => {
    // The scan path keeps its own literal (the kernel must not import the
    // eager grouping module to read one number) — so the PAIRING is the thing
    // to assert, or the two drift silently.
    expect(SCAN_GROUPBY_DEFAULT_MAX_GROUPS).toBe(GROUPBY_MAX_CARDINALITY)

    const data = rows(4)
    const out = await new ScanBuilder<Row>(countingProvider(data).provider, 2)
      .groupBy('id') // one bucket per record, but only 4 of them — well under the default
      .aggregate({ n: count() })
    expect(out).toHaveLength(4)
  })
})

// ---------------------------------------------------------------------------
// 4. Money stays exact; dateTrunc keys work
// ---------------------------------------------------------------------------

interface Sale extends Record<string, unknown> {
  id: string
  buyer: string
  total: number | string
  closedAt: string
}

describe('#1340 > money + derived keys', () => {
  it('keeps money BigInt-exact through a grouped scan (agrees with the eager path)', async () => {
    const db = await createNoydb({
      store: toMemory(),
      user: 'alice',
      secret: 'scan-groupby-secret-1340-money',
      reduceStrategy: withReduce(),
    })
    const vault = await db.openVault('books')
    const sales = vault.collection<Sale>('sales', {
      schema: z.object({
        id: z.string(),
        buyer: z.string(),
        total: z.union([z.number(), z.string()]),
        closedAt: z.string(),
      }),
      moneyFields: { total: money({ currency: 'EUR', scale: 2 }) },
    })
    const seed: Sale[] = [
      { id: 's1', buyer: 'ann', total: '10000000000000.01', closedAt: '2026-01-05' },
      { id: 's2', buyer: 'ann', total: '0.02', closedAt: '2026-01-20' },
      { id: 's3', buyer: 'bob', total: '9882.00', closedAt: '2026-02-11' },
    ]
    for (const s of seed) await sales.put(s.id, s)

    const streamed = await sales.scan({ pageSize: 2 }).groupBy('buyer').aggregate({ total: sum('total') })
    const eager = sales.query().groupBy('buyer').aggregate({ total: sum('total') }).run()

    const byBuyer = (xs: readonly Record<string, unknown>[]): Record<string, unknown> =>
      Object.fromEntries(xs.map((r) => [r.buyer as string, r.total]))
    expect(byBuyer(streamed)).toEqual(byBuyer(eager))
    // Exact past 2^53 — float summation would land on '10000000000000.02'.
    expect(byBuyer(streamed).ann).toBe('10000000000000.03')
  })

  it('groups a scan by a dateTrunc() derived key — the monthly-rollup shape', async () => {
    const db = await createNoydb({
      store: toMemory(),
      user: 'alice',
      secret: 'scan-groupby-secret-1340-datetrunc',
      reduceStrategy: withReduce(),
    })
    const vault = await db.openVault('books')
    const invoices = vault.collection<Row>('invoices')
    for (const r of rows(30)) await invoices.put(r.id, r)

    const key = dateTrunc('closedAt', 'month', { as: 'month', timeZone: 'UTC' })
    const streamed = await invoices.scan({ pageSize: 4 }).groupBy(key).aggregate({ n: count() })
    const eager = invoices.query().groupBy(key).aggregate({ n: count() }).run()

    const norm = (xs: readonly Record<string, unknown>[]): Record<string, unknown> =>
      Object.fromEntries(xs.map((r) => [String(r.month), r.n]))
    expect(norm(streamed)).toEqual(norm(eager))
    expect(Object.keys(norm(streamed)).sort()).toEqual(['2026-01-01', '2026-02-01', '2026-03-01'])
  })

  it('carries an O(n)-per-group reducer (median) through the grouped scan', async () => {
    const data = rows(20)
    const out = await new ScanBuilder<Row>(countingProvider(data).provider, 6)
      .groupBy('clientId', { maxGroups: 10 })
      .aggregate({ mid: median('amount') })
    expect(out).toHaveLength(5)
    // clientId c-0 holds records 0, 5, 10, 15 → amounts 10, 60, 110, 160 → median 85.
    expect(out.find((r) => r.clientId === 'c-0')!.mid).toBe(85)
  })
})
