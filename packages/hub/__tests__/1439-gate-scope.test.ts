/**
 * #1439 — "is a gate registered on this bus" is not "can a gate fire here".
 *
 * `Collection._cacheStamp` opted the #1418 MV memo out on
 * `subsystemBus.hasGateHandlers('beforePut')`. That map is VAULT-WIDE, while
 * both registrants decide per event — guards by collection, periods by the
 * record's date field. So one guard on one collection, or a `withPeriods()`
 * nobody had closed a period against, disabled the memo for every MV output in
 * the vault.
 *
 * Measured by the reporter on their own shape, counting real `store.put` calls
 * over 100 dropped source writes (their MV output has 54 rows):
 *
 *     periods  guards   output puts/write
 *       yes      yes         54.00
 *       no       yes         54.00      <- guards alone are sufficient
 *       yes      no          54.00
 *       no       no           0.54      <- the fast path working
 *
 * ⭐ `guardStrategies` is ordinary where `withPeriods()` is rare, so the guard
 * half is what decided whether anyone saw #1418 at all. The original
 * reproduction had no guards, which is why periods looked like the trigger.
 *
 * This file is that 2x2, plus the two directions the narrowing must NOT break:
 * a gate that really does apply still fires, and the compliance signal a closed
 * period produces is still emitted.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { memoryStore } from '../src/kernel/memory-store.js'
import { withMaterializedView } from '../src/with-formula/materialized-views/index.js'
import { withPeriods } from '../src/with-audit/periods/index.js'
import { withGuard } from '../src/with-audit/guards/with-guard.js'
import { sum } from '../src/with-lookup/reduce/index.js'
import { _clearEmitMemos } from '../src/with-formula/materialized-views/emit-memo.js'
import type { NoydbStore } from '../src/kernel/types.js'

interface Receipt { id: string; billId: string | null; amount: number; asOf: string }
interface Paid extends Record<string, unknown> { id: string; billId: string; paid: number }

/** Counts real store writes per collection — the reporter's instrument, not a timer. */
function counting(inner: NoydbStore): { store: NoydbStore; puts: Record<string, number>; reset(): void } {
  const puts: Record<string, number> = {}
  const store = new Proxy(inner, {
    get(t, p, r) {
      if (p === 'put') {
        return async (v: string, c: string, i: string, e: unknown) => {
          puts[c] = (puts[c] ?? 0) + 1
          return (t as unknown as { put: (...a: unknown[]) => Promise<void> }).put(v, c, i, e)
        }
      }
      return Reflect.get(t, p, r) as unknown
    },
  }) as NoydbStore
  return { store, puts, reset: () => { for (const k of Object.keys(puts)) delete puts[k] } }
}

function mvSpec() {
  return withMaterializedView<Paid>({
    name: 'billPaidByBill', output: 'billPaidByBill', refresh: 'eager', sources: ['receipts'],
    unionSources: [{
      collection: 'receipts',
      map: (r) => (r['billId'] == null
        ? null
        : { id: String(r['billId']), billId: String(r['billId']), paid: Number(r['amount']) }),
    }],
    groupBy: ['billId'], aggregate: { paid: sum('paid') },
    rowKey: (r) => String((r as Record<string, unknown>)['billId']),
  } as never)
}

const VIEW_ROWS = 40

/**
 * Seed `VIEW_ROWS` bills, then time N source writes the MV's `map` DROPS.
 * Returns output puts per dropped write: ~0 when the memo engages, ~VIEW_ROWS
 * when it does not.
 */
async function outputPutsPerDroppedWrite(
  opts: { periods?: boolean; guards?: boolean },
): Promise<number> {
  _clearEmitMemos()
  const c = counting(memoryStore())
  const db = await createNoydb({
    store: c.store, user: 'o', secret: 'issue-1439-gate-scope-secret',
    materializedViewStrategies: [mvSpec()],
    ...(opts.periods === true ? { periodsStrategy: withPeriods() } : {}),
    // A guard on an UNRELATED collection — never on the MV output.
    ...(opts.guards === true
      ? { guardStrategies: [withGuard({ collection: 'ledger', check: () => {} })] }
      : {}),
  } as never)
  const vault = await db.openVault('V')
  const receipts = vault.collection<Receipt>('receipts')
  vault.collection<Paid>('billPaidByBill')

  for (let i = 0; i < VIEW_ROWS; i++) {
    await receipts.put(`rc${i}`, { id: `rc${i}`, billId: `b${i}`, amount: i * 10, asOf: '2026-06-01' })
  }

  const N = 20
  c.reset()
  for (let i = 0; i < N; i++) {
    await receipts.put(`rd${i}`, { id: `rd${i}`, billId: null, amount: 5, asOf: '2026-06-01' })
  }
  return (c.puts['billPaidByBill'] ?? 0) / N
}

describe('#1439 — the 2x2 the reporter measured', () => {
  it('no periods, no guards — the fast path (this always worked)', async () => {
    expect(await outputPutsPerDroppedWrite({})).toBeLessThan(1)
  }, 120_000)

  it('guards on an UNRELATED collection no longer disable the memo', async () => {
    // The row that mattered: `guardStrategies` is ordinary, and one guard
    // anywhere used to cost every MV output in the vault.
    expect(await outputPutsPerDroppedWrite({ guards: true })).toBeLessThan(1)
  }, 120_000)

  it('withPeriods() with nothing closed no longer disables the memo', async () => {
    expect(await outputPutsPerDroppedWrite({ periods: true })).toBeLessThan(1)
  }, 120_000)

  it('both together no longer disable the memo', async () => {
    expect(await outputPutsPerDroppedWrite({ periods: true, guards: true })).toBeLessThan(1)
  }, 120_000)
})

describe('#1439 — a gate that DOES apply still fires', () => {
  it('a guard on the MV OUTPUT collection keeps the memo off', async () => {
    // The narrowing must not become "guards never count". When the output is
    // itself guarded, a redundant write is observable and must still happen.
    _clearEmitMemos()
    const c = counting(memoryStore())
    const db = await createNoydb({
      store: c.store, user: 'o', secret: 'issue-1439-gate-scope-secret',
      materializedViewStrategies: [mvSpec()],
      guardStrategies: [withGuard({ collection: 'billPaidByBill', check: () => {} })],
    } as never)
    const vault = await db.openVault('V')
    const receipts = vault.collection<Receipt>('receipts')
    vault.collection<Paid>('billPaidByBill')
    for (let i = 0; i < 10; i++) {
      await receipts.put(`rc${i}`, { id: `rc${i}`, billId: `b${i}`, amount: i, asOf: '2026-06-01' })
    }
    c.reset()
    for (let i = 0; i < 5; i++) {
      await receipts.put(`rd${i}`, { id: `rd${i}`, billId: null, amount: 5, asOf: '2026-06-01' })
    }
    expect((c.puts['billPaidByBill'] ?? 0) / 5).toBeGreaterThan(1)
  }, 120_000)

  it('the closed-period compliance signal is still emitted', async () => {
    // #1418's opt-out existed for this. The scope narrows WHICH rows are
    // exempt, never whether a governed row is checked — the reporter said
    // plainly they would rather carry the cost than lose this trace.
    _clearEmitMemos()
    const mv = withMaterializedView<Record<string, unknown>>({
      name: 'all-items', query: (db) => db.collection('items').query(),
      rowKey: (r) => String((r as Record<string, unknown>)['id']), refresh: 'manual',
    } as never)
    const db = await createNoydb({
      store: memoryStore(), user: 'alice', secret: 'issue-1439-gate-scope-secret',
      materializedViewStrategies: [mv], periodsStrategy: withPeriods(),
    } as never)
    const vault = await db.openVault('demo')
    const items = vault.collection<{ id: string; asOf: string }>('items')
    await items.put('a', { id: 'a', asOf: '2026-01-15' })
    await items.put('b', { id: 'b', asOf: '2026-06-01' })
    await vault.refreshView('all-items')
    await vault.closePeriod({ name: 'FY2026-Q1', endDate: '2026-03-31', dateField: 'asOf' })

    const events: unknown[] = []
    db.on('derivation:skipped-frozen', (e) => events.push(e))
    await vault.refreshView('all-items')

    // 'a' carries a date inside the closed period, so its row is governed:
    // the write is attempted, refused, and the audit event fires.
    expect(events).toHaveLength(1)
  }, 120_000)
})

describe('#1439 — gateAppliesTo vs hasGateHandlers', () => {
  it('a scope-less handler still counts as "may fire"', async () => {
    const { ServiceBus } = await import('../src/port/with/service-bus.js')
    const bus = new ServiceBus()
    expect(bus.gateAppliesTo('beforePut', { vault: 'v', collection: 'c' })).toBe(false)

    bus.registerGate('beforePut', () => {})
    // No declared scope — a registrant that has not thought about it keeps
    // today's behaviour rather than silently opting out.
    expect(bus.gateAppliesTo('beforePut', { vault: 'v', collection: 'c' })).toBe(true)
  })

  it('is an OR across registrants, and a throwing scope means "may fire"', async () => {
    const { ServiceBus } = await import('../src/port/with/service-bus.js')
    const bus = new ServiceBus()
    bus.registerGate('beforePut', () => {}, { scope: ({ collection }) => collection === 'a' })
    bus.registerGate('beforePut', () => {}, { scope: ({ collection }) => collection === 'b' })

    expect(bus.gateAppliesTo('beforePut', { vault: 'v', collection: 'a' })).toBe(true)
    expect(bus.gateAppliesTo('beforePut', { vault: 'v', collection: 'b' })).toBe(true)
    expect(bus.gateAppliesTo('beforePut', { vault: 'v', collection: 'c' })).toBe(false)

    // A predicate that exists to PERMIT an optimisation must never be able to
    // disable a gate by failing.
    bus.registerGate('beforePut', () => {}, { scope: () => { throw new Error('boom') } })
    expect(bus.gateAppliesTo('beforePut', { vault: 'v', collection: 'c' })).toBe(true)
  })
})
