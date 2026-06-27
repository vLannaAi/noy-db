/**
 * Track A slice 3a — closed-period guard registered as gate-bus handlers.
 *
 * Asserts:
 *   1. A plain Noydb (no periodsStrategy) registers NO gate handlers for
 *      'beforePut' or 'beforeDelete'.
 *   2. A Noydb created with periodsStrategy: withPeriods() registers gate
 *      handlers for BOTH 'beforePut' and 'beforeDelete'.
 *   3. The closed-period rejection scenario (copied from periods.test.ts)
 *      still rejects via the gate path.
 */
import { describe, it, expect } from 'vitest'
import { memory } from '../../to/to-memory/src/index.js'
import { PeriodClosedError, createNoydb } from '../src/index.js'
import { withPeriods } from '../src/periods/index.js'

describe('periods gate migration (Track A slice 3a)', () => {
  it('plain Noydb has no gate handlers for beforePut or beforeDelete', async () => {
    const plain = await createNoydb({
      store: memory(),
      user: 'owner',
      encrypt: false,
    })
    expect(plain._subsystemBus.hasGateHandlers('beforePut')).toBe(false)
    expect(plain._subsystemBus.hasGateHandlers('beforeDelete')).toBe(false)
    plain.close()
  })

  it('Noydb with periodsStrategy registers gate handlers for beforePut and beforeDelete', async () => {
    const withP = await createNoydb({
      store: memory(),
      user: 'owner',
      encrypt: false,
      periodsStrategy: withPeriods(),
    })
    expect(withP._subsystemBus.hasGateHandlers('beforePut')).toBe(true)
    expect(withP._subsystemBus.hasGateHandlers('beforeDelete')).toBe(true)
    withP.close()
  })

  it('closed-period rejection still works after gate registration', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'owner',
      encrypt: false,
      periodsStrategy: withPeriods(),
    })
    const vault = await db.openVault('acme')
    const invoices = vault.collection<{ amount: number; status: string; date: string }>('invoices')
    await invoices.put('inv-1', { amount: 100, status: 'draft', date: '2026-01-15' })

    await vault.closePeriod({
      name: 'FY2026-Q1',
      endDate: '2026-03-31',
      dateField: 'date',
    })

    await expect(
      invoices.put('inv-1', { amount: 999, status: 'paid', date: '2026-01-15' }),
    ).rejects.toBeInstanceOf(PeriodClosedError)

    db.close()
  })
})
