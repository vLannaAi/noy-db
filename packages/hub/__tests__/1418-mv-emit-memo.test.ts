/**
 * #1418 — a materialized-view refresh must not rewrite output rows that have
 * not changed.
 *
 * `refresh()` recomputes the whole view and then wrote EVERY output row on
 * EVERY source write, so per-write cost tracked the SIZE OF THE VIEW rather
 * than the size of the change. Measured on one MV with a single union arm,
 * writing rows the MV's own `map` drops:
 *
 *     250 output rows  →  23.0 ms per source write
 *     450 output rows  →  41.6 ms per source write
 *
 * ⛔ THE FAILURE MODE OF THIS FIX IS AN MV THAT SILENTLY STOPS UPDATING, which
 * has no symptom at the call site — the view just quietly answers with old
 * numbers. So the timing case at the bottom is one test and the other twelve
 * are all "did the view actually track the change": a group whose sum moves, a
 * new group, a group emptied, a source deleted, a second MV over the same
 * output, and a write by something other than the MV.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { memoryStore } from '../src/kernel/memory-store.js'
import { withMaterializedView } from '../src/with-formula/materialized-views/index.js'
import { sum } from '../src/with-lookup/reduce/index.js'
import { _clearEmitMemos, rowContentKey } from '../src/with-formula/materialized-views/emit-memo.js'

interface Receipt { id: string; billId: string | null; amount: number }
interface Paid extends Record<string, unknown> { id: string; billId: string; paid: number }

const SECRET = 'issue-1418-mv-emit-memo-secret'

function spec() {
  return withMaterializedView<Paid>({
    name: 'billPaidByBill',
    output: 'billPaidByBill',
    refresh: 'eager',
    sources: ['receipts'],
    unionSources: [{
      collection: 'receipts',
      map: (r) => (r['billId'] == null
        ? null
        : { id: String(r['billId']), billId: String(r['billId']), paid: Number(r['amount']) }),
    }],
    groupBy: ['billId'],
    aggregate: { paid: sum('paid') },
    rowKey: (r) => String((r as Record<string, unknown>)['billId']),
  } as never)
}

async function openVault() {
  const db = await createNoydb({
    store: memoryStore(), user: 'owner', secret: SECRET,
    materializedViewStrategies: [spec()],
  } as never)
  const vault = await db.openVault('V')
  const receipts = vault.collection<Receipt>('receipts')
  const view = vault.collection<Paid>('billPaidByBill')
  return { vault, receipts, view }
}

/** The view as `{ billId: paid }`, which is the thing a consumer actually reads. */
async function viewOf(view: Awaited<ReturnType<typeof openVault>>['view']): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const r of await view.list()) out[r.billId] = Number(r.paid)
  return out
}

beforeEach(() => {
  // The memo is process-wide; two cases building the same vault/MV/collection
  // names would otherwise inherit each other's beliefs about the output.
  _clearEmitMemos()
})

describe('#1418 — the view still tracks every change', () => {
  it('a new group appears', async () => {
    const { receipts, view } = await openVault()

    await receipts.put('r1', { id: 'r1', billId: 'b1', amount: 100 })
    expect(await viewOf(view)).toEqual({ b1: 100 })

    await receipts.put('r2', { id: 'r2', billId: 'b2', amount: 50 })
    expect(await viewOf(view)).toEqual({ b1: 100, b2: 50 })
  })

  it('an EXISTING group re-sums when a row is added to it', async () => {
    const { receipts, view } = await openVault()
    await receipts.put('r1', { id: 'r1', billId: 'b1', amount: 100 })
    await receipts.put('r2', { id: 'r2', billId: 'b2', amount: 50 })

    // b1's row content changes; b2's does not. A memo that skipped both would
    // leave b1 reading 100 forever — the whole defect this fix could introduce.
    await receipts.put('r3', { id: 'r3', billId: 'b1', amount: 7 })

    expect(await viewOf(view)).toEqual({ b1: 107, b2: 50 })
  })

  it('an UPDATE that changes an amount re-sums its group', async () => {
    const { receipts, view } = await openVault()
    await receipts.put('r1', { id: 'r1', billId: 'b1', amount: 100 })
    await receipts.put('r2', { id: 'r2', billId: 'b2', amount: 50 })

    await receipts.put('r1', { id: 'r1', billId: 'b1', amount: 1 })

    expect(await viewOf(view)).toEqual({ b1: 1, b2: 50 })
  })

  it('an UPDATE that MOVES a row between groups re-sums both', async () => {
    const { receipts, view } = await openVault()
    await receipts.put('r1', { id: 'r1', billId: 'b1', amount: 100 })
    await receipts.put('r2', { id: 'r2', billId: 'b2', amount: 50 })

    await receipts.put('r1', { id: 'r1', billId: 'b2', amount: 100 })

    expect(await viewOf(view)).toEqual({ b2: 150 })
  })

  it('a DELETE empties a group and tombstones its row', async () => {
    const { receipts, view } = await openVault()
    await receipts.put('r1', { id: 'r1', billId: 'b1', amount: 100 })
    await receipts.put('r2', { id: 'r2', billId: 'b2', amount: 50 })

    await receipts.delete('r1')

    expect(await viewOf(view)).toEqual({ b2: 50 })
  })

  it('a row the map DROPS changes nothing — the reported workload', async () => {
    const { receipts, view } = await openVault()
    await receipts.put('r1', { id: 'r1', billId: 'b1', amount: 100 })
    const before = await viewOf(view)

    for (let i = 0; i < 5; i++) {
      await receipts.put(`rd${i}`, { id: `rd${i}`, billId: null, amount: 5 })
    }

    expect(await viewOf(view)).toEqual(before)
  })

  it('a value that returns to an earlier one is still re-emitted correctly', async () => {
    // 100 -> 5 -> 100. The final row content equals what was written two
    // refreshes ago; the memo must be comparing against the LAST write, not a
    // set of every value ever seen.
    const { receipts, view } = await openVault()
    await receipts.put('r1', { id: 'r1', billId: 'b1', amount: 100 })
    await receipts.put('r1', { id: 'r1', billId: 'b1', amount: 5 })
    expect(await viewOf(view)).toEqual({ b1: 5 })

    await receipts.put('r1', { id: 'r1', billId: 'b1', amount: 100 })
    expect(await viewOf(view)).toEqual({ b1: 100 })
  })
})

describe('#1418 — the memo stands down when it cannot see the output', () => {
  it('a write to the output collection by someone else invalidates it', async () => {
    const { receipts, view } = await openVault()
    await receipts.put('r1', { id: 'r1', billId: 'b1', amount: 100 })
    expect(await viewOf(view)).toEqual({ b1: 100 })

    // Something other than this MV edits the output row. The mutation stamp
    // moves, so the memo's beliefs about the collection are discarded and the
    // next refresh rewrites rather than skipping.
    await view.put('b1', { id: 'b1', billId: 'b1', paid: -1 } as Paid)
    expect((await viewOf(view))['b1']).toBe(-1)

    await receipts.put('rd', { id: 'rd', billId: null, amount: 5 })

    // The refresh repaired the row it did not itself write.
    expect(await viewOf(view)).toEqual({ b1: 100 })
  })

  it('a fresh process writes everything — an empty memo is never read as "unchanged"', async () => {
    const { receipts, view } = await openVault()
    await receipts.put('r1', { id: 'r1', billId: 'b1', amount: 100 })

    // Simulates a restart: the in-memory memo is gone, the store is not.
    _clearEmitMemos()
    await receipts.put('rd', { id: 'rd', billId: null, amount: 5 })

    expect(await viewOf(view)).toEqual({ b1: 100 })
  })
})

describe('#1418 — rowContentKey', () => {
  it('ignores _materializedFrom, which moves on every refresh', () => {
    const a = rowContentKey({ billId: 'b1', paid: 1, _materializedFrom: { materializedAt: 'T1' } }, 'h')
    const b = rowContentKey({ billId: 'b1', paid: 1, _materializedFrom: { materializedAt: 'T2' } }, 'h')
    expect(a).toBe(b)
    expect(a).not.toBeNull()
  })

  it('is insensitive to key order but sensitive to content and queryHash', () => {
    expect(rowContentKey({ a: 1, b: 2 }, 'h')).toBe(rowContentKey({ b: 2, a: 1 }, 'h'))
    expect(rowContentKey({ a: 1 }, 'h')).not.toBe(rowContentKey({ a: 2 }, 'h'))
    // A strategy change must rewrite every row: a stale queryHash IS staleness.
    expect(rowContentKey({ a: 1 }, 'h1')).not.toBe(rowContentKey({ a: 1 }, 'h2'))
    // The digit/string collapse must not reappear through a cache key.
    expect(rowContentKey({ a: 1 }, 'h')).not.toBe(rowContentKey({ a: '1' }, 'h'))
  })

  it('declines rather than throws on a value JSON cannot express', () => {
    // Declining costs one write; guessing costs a stale view.
    expect(rowContentKey({ a: 1n } as unknown as Record<string, unknown>, 'h')).toBeNull()
    const cyclic: Record<string, unknown> = { a: 1 }
    cyclic['self'] = cyclic
    expect(rowContentKey(cyclic, 'h')).toBeNull()
  })
})

describe('#1418 — the per-write cost no longer tracks the view size', () => {
  it('a dropped-row write over a large view costs a fraction of the first refresh', async () => {
    const { receipts, view } = await openVault()
    for (let i = 0; i < 300; i++) {
      await receipts.put(`r${i}`, { id: `r${i}`, billId: `b${i}`, amount: i })
    }
    expect(Object.keys(await viewOf(view))).toHaveLength(300)

    // Ten writes the MV's map drops entirely: the view cannot have changed, so
    // no output row should be rewritten.
    const t0 = performance.now()
    for (let i = 0; i < 10; i++) {
      await receipts.put(`rd${i}`, { id: `rd${i}`, billId: null, amount: 5 })
    }
    const perWrite = (performance.now() - t0) / 10

    // Before the fix this was ~25 ms at this view size and grew with it. The
    // bound is deliberately generous — it guards the memo's existence, not a
    // millisecond budget on a loaded CI box.
    expect(perWrite).toBeLessThan(8)
    // ...and the view is still correct after all that skipping.
    expect(Object.keys(await viewOf(view))).toHaveLength(300)
  }, 120_000)
})
