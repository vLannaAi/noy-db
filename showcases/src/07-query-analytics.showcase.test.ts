/**
 * Showcase 07 — "Query engine as a real analytics surface"
 * GitHub issue: https://github.com/vLannaAi/noy-db/issues/172
 *
 * Framework: Pinia (`defineNoydbStore` + `query()`)
 * Store:     `memory()`
 * Branch:    showcase/07-query-analytics
 * Dimension: Efficiency — aggregate, groupBy, top-N, count all run
 *            against a plaintext in-memory cache behind the Pinia
 *            store surface.
 *
 * What this proves:
 *   1. 200 invoices seeded across 12 months, 10 clients, and the
 *      fixture's 4 statuses are queryable without a secondary index —
 *      the plan runs against the Collection's hydrated cache.
 *   2. `.groupBy('month').aggregate({ total: sum, n: count }).run()`
 *      returns one row per month, summed and counted correctly.
 *   3. `.groupBy('clientId').aggregate({ avg: avg(...) }).run()`
 *      handles a different key + reducer combination.
 *   4. `.where(...).orderBy('amount', 'desc').limit(5)` is top-N
 *      over the encrypted collection — plaintext ordering happens in
 *      memory, never on disk.
 *   5. `.where(...).count()` is a cheap single-number terminal.
 *
 * Note on the fixture: `generateInvoices` in `_fixtures.ts` cycles
 * through four statuses (`draft | open | paid | overdue`). The issue
 * copy mentioned "5 statuses" — that's a typo in the issue. The
 * assertions below match the real fixture, not the issue copy.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import {
  createNoydb,
  sum,
  avg,
  count,
  type Noydb,
} from '@noy-db/hub'
import { withAggregate } from '@noy-db/hub/aggregate'
import { memory } from '@noy-db/to-memory'
import { defineNoydbStore, setActiveNoydb } from '@noy-db/in-pinia'

import {
  type Invoice,
  generateInvoices,
  SHOWCASE_PASSPHRASE,
} from './_fixtures.js'

describe('Showcase 07 — Query engine analytics (Pinia)', () => {
  const INVOICE_COUNT = 200
  const invoices = generateInvoices(INVOICE_COUNT)

  let db: Noydb
  let store: ReturnType<ReturnType<typeof defineNoydbStore<Invoice>>>

  beforeEach(async () => {
    setActivePinia(createPinia())

    db = await createNoydb({
      store: memory(),
      user: 'owner', aggregateStrategy: withAggregate(),
      secret: SHOWCASE_PASSPHRASE,
    })
    await db.openVault('firm-demo')
    setActiveNoydb(db)

    const useInvoices = defineNoydbStore<Invoice>('invoices', { vault: 'firm-demo' })
    store = useInvoices()
    await store.$ready

    // Seed 200 invoices. Sequential awaits keep the semantics obvious
    // — each add triggers a list() refresh under the hood, which is
    // fine for 200 records. For production seeding we'd reach for the
    // raw Collection and batch, but this is showcase code.
    for (const inv of invoices) {
      await store.add(inv.id, inv)
    }
  })

  afterEach(async () => {
    setActiveNoydb(null)
    await db.close()
  })

  it('step 1 — 200 invoices hydrate into the Pinia store', () => {
    expect(store.count).toBe(INVOICE_COUNT)
  })

  it('step 2 — groupBy(month) + sum/count gives per-month totals', () => {
    const byMonth = store
      .query()
      .groupBy('month')
      .aggregate({ total: sum('amount'), n: count() })
      .run()

    // 12 calendar months, so 12 buckets.
    expect(byMonth).toHaveLength(12)

    // Invariant checks: the reducer totals must equal the raw totals,
    // regardless of how groupBy bucketized things.
    const expectedTotal = invoices.reduce((s, r) => s + r.amount, 0)
    const bucketTotal = byMonth.reduce(
      (s, row) => s + (row as { total: number }).total,
      0,
    )
    expect(bucketTotal).toBe(expectedTotal)

    const bucketN = byMonth.reduce(
      (s, row) => s + (row as { n: number }).n,
      0,
    )
    expect(bucketN).toBe(INVOICE_COUNT)

    // Every row carries the group key under the grouping field.
    for (const row of byMonth) {
      expect(typeof (row as { month: string }).month).toBe('string')
      expect((row as { month: string }).month).toMatch(/^\d{4}-\d{2}$/)
    }
  })

  it('step 3 — groupBy(clientId) + avg returns per-client averages', () => {
    const byClient = store
      .query()
      .groupBy('clientId')
      .aggregate({ avg: avg('amount') })
      .run()

    // The fixture cycles through 5 `sampleClients`, so we expect 5 buckets.
    expect(byClient).toHaveLength(5)

    // Every bucket's average must sit inside the fixture's amount
    // spread (1000–49999). Cheap sanity — guards against the reducer
    // being a no-op.
    for (const row of byClient) {
      const a = (row as { avg: number }).avg
      expect(a).toBeGreaterThan(0)
      expect(a).toBeLessThan(50_000)
      expect(typeof (row as { clientId: string }).clientId).toBe('string')
    }

    // Cross-check one bucket manually: client cl-01 gets every invoice
    // whose index % 5 === 0 (the fixture rotates clients via modulo).
    const expectedCl01Rows = invoices.filter(i => i.clientId === 'cl-01')
    const expectedCl01Avg =
      expectedCl01Rows.reduce((s, r) => s + r.amount, 0) /
      expectedCl01Rows.length
    const cl01 = byClient.find(r => (r as { clientId: string }).clientId === 'cl-01')!
    expect((cl01 as { avg: number }).avg).toBeCloseTo(expectedCl01Avg, 6)
  })

  it('step 4 — where + orderBy desc + limit(5) is top-N by amount', () => {
    const top5 = store
      .query()
      .where('amount', '>', 10_000)
      .orderBy('amount', 'desc')
      .limit(5)
      .toArray()

    expect(top5).toHaveLength(5)

    // Strictly non-increasing amounts (orderBy desc).
    for (let i = 1; i < top5.length; i++) {
      expect(top5[i - 1].amount).toBeGreaterThanOrEqual(top5[i].amount)
    }
    // Every row satisfies the where clause.
    for (const row of top5) {
      expect(row.amount).toBeGreaterThan(10_000)
    }
    // The top row must be the global max among amounts > 10000.
    const expectedMax = Math.max(
      ...invoices.filter(i => i.amount > 10_000).map(i => i.amount),
    )
    expect(top5[0].amount).toBe(expectedMax)
  })

  it('step 5 — where(status, overdue).count() is a cheap number', () => {
    const overdueCount = store.query().where('status', '==', 'overdue').count()

    // The fixture's status rotation: i % 4, with statuses =
    // [draft, open, paid, overdue]. `overdue` lands on every i where
    // i % 4 === 3, so among 200 rows we expect 50.
    const expected = invoices.filter(i => i.status === 'overdue').length
    expect(expected).toBe(50)
    expect(overdueCount).toBe(expected)
  })

  it('step 6 — recap: five analytical passes still see the same 200-row working set', () => {
    // The recap tie-back: every query above ran against the hub's in-memory
    // working copy. There's no pagination, no disk seek, no re-decryption —
    // the Pinia store's hydrated array is the single source of truth that
    // every terminal (count / aggregate / groupBy / orderBy / limit) reads
    // from. Run a spread of analytical queries back-to-back and confirm
    // the reactive store is unchanged — the queries are pure reads.
    const before = store.count
    const draftTotal = store
      .query()
      .where('status', '==', 'draft')
      .aggregate({ total: sum('amount') })
      .run().total
    const paidCount = store.query().where('status', '==', 'paid').count()
    const byMonthRows = store
      .query()
      .groupBy('month')
      .aggregate({ n: count() })
      .run().length
    const top3 = store.query().orderBy('amount', 'desc').limit(3).toArray().length

    expect(store.count).toBe(before) // working set is untouched by queries
    expect(draftTotal).toBeGreaterThan(0)
    expect(paidCount).toBe(50)
    expect(byMonthRows).toBe(12)
    expect(top3).toBe(3)
  })
})
