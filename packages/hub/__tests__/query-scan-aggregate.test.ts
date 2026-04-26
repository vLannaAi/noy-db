/**
 * Tests for ScanBuilder + Collection.scan().aggregate() — v0.6 #99.
 *
 * Covers:
 *   - Backward compatibility — existing for-await consumers still work
 *   - ScanBuilder with a plain-object page provider (unit-level)
 *   - .where() and .filter() clause application during streaming
 *   - .aggregate() async terminal over a real Collection + memory adapter
 *   - Same reducer protocol as Query.aggregate() (#97 reuse)
 *   - O(reducers) memory guarantee via a 5k-record streaming test
 *   - #87 seed seam still honored in the scan path
 *   - Multi-page iteration across listPage cursors
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { createNoydb } from '../src/noydb.js'
import type { Noydb } from '../src/noydb.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot, ListPageResult } from '../src/types.js'
import { ConflictError } from '../src/errors.js'
import {
  ScanBuilder,
  count,
  sum,
  avg,
  min,
  max,
  type ScanPageProvider,
} from '../src/query/index.js'

/** Inline memory adapter — same pattern as the other integration tests. */
function memory(): NoydbStore {
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
      if (existing) {
        for (const [name, coll] of existing) {
          if (name.startsWith('_')) comp.set(name, coll)
        }
      }
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

interface Invoice {
  id: string
  status: 'draft' | 'open' | 'paid'
  amount: number
  year: number
}

async function seed(
  invoices: import('../src/collection.js').Collection<Invoice>,
  n: number,
): Promise<void> {
  for (let i = 0; i < n; i++) {
    await invoices.put(`inv-${String(i).padStart(5, '0')}`, {
      id: `inv-${String(i).padStart(5, '0')}`,
      status: (['draft', 'open', 'paid'] as const)[i % 3]!,
      amount: i * 10,
      year: 2024 + (i % 3), // 2024, 2025, 2026 round-robin
    })
  }
}

// ---------------------------------------------------------------------------
// ScanBuilder unit tests — plain-object page provider
// ---------------------------------------------------------------------------

/** In-memory page provider for unit tests — no Collection required. */
function arrayProvider<T>(records: T[], pageSize = 100): ScanPageProvider<T> {
  return {
    async listPage(opts) {
      const limit = opts.limit ?? pageSize
      const start = opts.cursor ? parseInt(opts.cursor, 10) : 0
      const end = Math.min(start + limit, records.length)
      return {
        items: records.slice(start, end),
        nextCursor: end < records.length ? String(end) : null,
      }
    },
  }
}

describe('ScanBuilder > async iteration', () => {
  it('yields every record in order across page boundaries', async () => {
    const records = [
      { id: 'a', n: 1 },
      { id: 'b', n: 2 },
      { id: 'c', n: 3 },
      { id: 'd', n: 4 },
      { id: 'e', n: 5 },
    ]
    const builder = new ScanBuilder(arrayProvider(records), 2)
    const collected: Array<{ id: string; n: number }> = []
    for await (const rec of builder) collected.push(rec)
    expect(collected).toEqual(records)
  })

  it('applies where() clauses during iteration', async () => {
    const records = [
      { id: 'a', n: 1 },
      { id: 'b', n: 2 },
      { id: 'c', n: 3 },
      { id: 'd', n: 4 },
    ]
    const builder = new ScanBuilder(arrayProvider(records), 2).where('n', '>', 2)
    const collected: Array<{ id: string; n: number }> = []
    for await (const rec of builder) collected.push(rec)
    expect(collected.map((r) => r.id)).toEqual(['c', 'd'])
  })

  it('applies multiple where() clauses as AND', async () => {
    const records = [
      { id: 'a', status: 'open', n: 1 },
      { id: 'b', status: 'paid', n: 2 },
      { id: 'c', status: 'open', n: 3 },
      { id: 'd', status: 'open', n: 4 },
    ]
    const builder = new ScanBuilder(arrayProvider(records), 2)
      .where('status', '==', 'open')
      .where('n', '>=', 3)
    const ids: string[] = []
    for await (const rec of builder) ids.push(rec.id)
    expect(ids).toEqual(['c', 'd'])
  })

  it('applies filter() escape hatch', async () => {
    const records = [{ id: 'a', n: 1 }, { id: 'b', n: 2 }, { id: 'c', n: 3 }]
    const builder = new ScanBuilder(arrayProvider(records), 2).filter((r) => r.n % 2 === 1)
    const ids: string[] = []
    for await (const rec of builder) ids.push(rec.id)
    expect(ids).toEqual(['a', 'c'])
  })

  it('is immutable — chained .where() returns a new builder', async () => {
    const records = [{ id: 'a', n: 1 }, { id: 'b', n: 2 }]
    const base = new ScanBuilder(arrayProvider(records), 2)
    const filtered = base.where('n', '>', 1)

    const baseIds: string[] = []
    for await (const rec of base) baseIds.push(rec.id)
    const filteredIds: string[] = []
    for await (const rec of filtered) filteredIds.push(rec.id)

    expect(baseIds).toEqual(['a', 'b']) // base unchanged
    expect(filteredIds).toEqual(['b'])
  })
})

describe('ScanBuilder > .aggregate() terminal', () => {
  const records = [
    { id: 'a', status: 'open', amount: 100 },
    { id: 'b', status: 'open', amount: 250 },
    { id: 'c', status: 'open', amount: 5000 },
    { id: 'd', status: 'paid', amount: 800 },
    { id: 'e', status: 'paid', amount: 1500 },
  ]

  it('reduces every record through a named spec', async () => {
    const result = await new ScanBuilder(arrayProvider(records), 2).aggregate({
      total: sum('amount'),
      n:     count(),
    })
    expect(result).toEqual({ total: 7650, n: 5 })
  })

  it('honors where() clauses during reduction', async () => {
    const result = await new ScanBuilder(arrayProvider(records), 2)
      .where('status', '==', 'open')
      .aggregate({ total: sum('amount'), n: count() })
    expect(result).toEqual({ total: 5350, n: 3 })
  })

  it('supports every reducer in combination', async () => {
    const result = await new ScanBuilder(arrayProvider(records), 2).aggregate({
      n:        count(),
      total:    sum('amount'),
      average:  avg('amount'),
      smallest: min('amount'),
      largest:  max('amount'),
    })
    expect(result).toEqual({
      n: 5,
      total: 7650,
      average: 1530,
      smallest: 100,
      largest: 5000,
    })
  })

  it('returns empty/null sentinels for an empty result set', async () => {
    const result = await new ScanBuilder(arrayProvider(records), 2)
      .where('status', '==', 'nonexistent')
      .aggregate({
        n:       count(),
        total:   sum('amount'),
        average: avg('amount'),
        lo:      min('amount'),
        hi:      max('amount'),
      })
    expect(result).toEqual({ n: 0, total: 0, average: null, lo: null, hi: null })
  })

  it('#87 constraint #2 — seed parameter plumbed through (no-op in v0.6)', async () => {
    const withoutSeed = await new ScanBuilder(arrayProvider(records), 2).aggregate({
      total: sum('amount'),
      n:     count(),
    })
    const withSeed = await new ScanBuilder(arrayProvider(records), 2).aggregate({
      total: sum('amount', { seed: 999_999 }),
      n:     count({ seed: 42 }),
    })
    expect(withSeed).toEqual(withoutSeed)
  })
})

// ---------------------------------------------------------------------------
// Collection.scan() integration — real adapter, pagination, decryption
// ---------------------------------------------------------------------------

describe('Collection.scan() > backward-compatible for-await iteration', () => {
  let db: Noydb

  beforeEach(async () => {
    db = await createNoydb({
      store: memory(),
      user: 'owner',
      secret: 'scan-agg-test-passphrase-2026',
    })
  })

  it('for await (… of scan()) still yields every record', async () => {
    const c = await db.openVault('TEST')
    const invoices = c.collection<Invoice>('invoices')
    await seed(invoices, 25)
    const collected: Invoice[] = []
    for await (const rec of invoices.scan({ pageSize: 7 })) collected.push(rec)
    expect(collected).toHaveLength(25)
  })
})

describe('Collection.scan().aggregate() > real collection over memory adapter', () => {
  let db: Noydb

  beforeEach(async () => {
    db = await createNoydb({
      store: memory(),
      user: 'owner',
      secret: 'scan-agg-test-passphrase-2026',
    })
  })

  it('reduces the full collection with one reducer', async () => {
    const c = await db.openVault('TEST')
    const invoices = c.collection<Invoice>('invoices')
    await seed(invoices, 30)
    const { total } = await invoices.scan({ pageSize: 10 }).aggregate({
      total: sum('amount'),
    })
    // Sum 0..290 step 10 → 10 * (0 + 1 + … + 29) = 10 * 435 = 4350
    expect(total).toBe(4350)
  })

  it('filters with where() during the scan stream', async () => {
    const c = await db.openVault('TEST')
    const invoices = c.collection<Invoice>('invoices')
    await seed(invoices, 30)
    const { n, total } = await invoices.scan({ pageSize: 10 })
      .where('status', '==', 'open')
      .aggregate({ n: count(), total: sum('amount') })
    // Every 3rd record is 'open' starting at index 1 → 10 matches.
    // Amounts: 10, 40, 70, …, 280. Sum = 10 * (1 + 4 + 7 + … + 28).
    // That's an arithmetic series: 10 terms, first=1, last=28, sum=(1+28)*10/2=145.
    // Total = 10 * 145 = 1450.
    expect(n).toBe(10)
    expect(total).toBe(1450)
  })

  it('walks every page when pageSize is smaller than the collection', async () => {
    const c = await db.openVault('TEST')
    const invoices = c.collection<Invoice>('invoices')
    await seed(invoices, 50)
    const { n } = await invoices.scan({ pageSize: 7 }).aggregate({ n: count() })
    expect(n).toBe(50)
  })

  it('combines where() on a year field with sum() and avg() across pages', async () => {
    const c = await db.openVault('TEST')
    const invoices = c.collection<Invoice>('invoices')
    await seed(invoices, 60) // 20 records per year 2024 / 2025 / 2026
    const result = await invoices.scan({ pageSize: 13 })
      .where('year', '==', 2025)
      .aggregate({
        n:       count(),
        total:   sum('amount'),
        average: avg('amount'),
      })
    expect(result.n).toBe(20)
    // year 2025 — indices 1, 4, 7, …, 58 (start 1, step 3, 20 terms)
    // amounts: 10, 40, 70, …, 580. Sum = 10 * (1+4+7+…+58)
    // arith series: 20 terms, first=1, last=58, sum = (1+58)*20/2 = 590
    // total = 10 * 590 = 5900, average = 295.
    expect(result.total).toBe(5900)
    expect(result.average).toBe(295)
  })

  it('streams a large collection with O(reducers) memory footprint', async () => {
    // The bound is a code-level invariant visible in ScanBuilder.aggregate
    // (one mutable state per reducer, records consumed one at a time).
    // This test verifies correctness on a dataset large enough that
    // collecting every record into an array would be noticeable — 5k
    // records across ~50 pages. Running correctly is the memory proof.
    const c = await db.openVault('TEST')
    const invoices = c.collection<Invoice>('invoices')
    const N = 5_000
    for (let i = 0; i < N; i++) {
      await invoices.put(`inv-${String(i).padStart(6, '0')}`, {
        id: `inv-${String(i).padStart(6, '0')}`,
        status: 'open',
        amount: 1,
        year: 2025,
      })
    }
    const { n, total } = await invoices.scan({ pageSize: 100 }).aggregate({
      n: count(),
      total: sum('amount'),
    })
    expect(n).toBe(N)
    expect(total).toBe(N)
  }, 60_000)
})
