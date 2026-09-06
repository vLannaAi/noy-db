/**
 * #1456 — reopening a period frees the records IN ITS WINDOW, whatever later
 * closes say.
 *
 * A close has an `endDate` and no start, and the guard tested
 * `record[dateField] <= endDate` against EVERY closed period in the timeline.
 * So a January row sat inside February's window, March's, and every close
 * after — and reopening January freed nothing. Measured: reopen only worked
 * on the newest close in a cell, which is the one case the correction
 * workflow never needs.
 *
 * The rule now: a value is OWNED by the closed period with the smallest
 * `endDate` at or after it. If that owner is effectively reopened, no period
 * in the timeline vetoes the value. February's own rows stay sealed by
 * February, so the reopen is exactly as wide as the accountant said.
 */
import { describe, it, expect } from 'vitest'
import { toMemory } from '../../to-memory/src/index.js'
import { createNoydb, PeriodClosedError } from '../src/index.js'
import { withPeriods } from '../src/with-audit/periods/index.js'

const subjects = { rows: (r: Record<string, unknown>) => [r.c as string, 'wht'] }

async function threeCloses() {
  const db = await createNoydb({ store: toMemory(), user: 'owner', encrypt: false, periodsStrategy: withPeriods({ subjects }) })
  const vault = await db.openVault('acme')
  const rows = vault.collection<Record<string, unknown>>('rows')
  const p = ['c1', 'wht'] as const
  await vault.closePeriod({ name: '2026-01', endDate: '2026-01-31', dateField: 'date', partition: p })
  await vault.closePeriod({ name: '2026-02', endDate: '2026-02-28', dateField: 'date', partition: p })
  await vault.closePeriod({ name: '2026-03', endDate: '2026-03-31', dateField: 'date', partition: p })
  return { vault, rows, p }
}

describe('#1456 — reopen January with February and March closed', () => {
  it('before: a January row is refused (by January, its owner)', async () => {
    const { rows } = await threeCloses()
    const err = await rows.put('j', { id: 'j', c: 'c1', date: '2026-01-15' }).catch((e: unknown) => e) as PeriodClosedError
    expect(err).toBeInstanceOf(PeriodClosedError)
    expect(err.periodName).toBe('2026-01')
  })

  it('after reopening January alone, the January row is writable', async () => {
    const { vault, rows, p } = await threeCloses()
    await vault.reopenPeriod('2026-01', { partition: p })
    await expect(rows.put('j', { id: 'j', c: 'c1', date: '2026-01-15' })).resolves.toBeUndefined()
  })

  it('…and a February row is still sealed, by February', async () => {
    const { vault, rows, p } = await threeCloses()
    await vault.reopenPeriod('2026-01', { partition: p })
    const err = await rows.put('f', { id: 'f', c: 'c1', date: '2026-02-10' }).catch((e: unknown) => e) as PeriodClosedError
    expect(err).toBeInstanceOf(PeriodClosedError)
    expect(err.periodName).toBe('2026-02')
  })

  it('reclosing January seals the January row again', async () => {
    const { vault, rows, p } = await threeCloses()
    await vault.reopenPeriod('2026-01', { partition: p })
    await rows.put('j', { id: 'j', c: 'c1', date: '2026-01-15' })
    await vault.reclosePeriod('2026-01', { partition: p })
    await expect(rows.put('j', { id: 'j', c: 'c1', date: '2026-01-15', amount: 2 })).rejects.toThrow(PeriodClosedError)
  })

  it('a row dated in a GAP between closes belongs to the next close up', async () => {
    // No April close: a 2026-04 row is owned by nothing and is writable; with
    // only Jan and Mar closed, a February row is owned by March.
    const db = await createNoydb({ store: toMemory(), user: 'owner', encrypt: false, periodsStrategy: withPeriods({ subjects }) })
    const vault = await db.openVault('acme')
    const rows = vault.collection<Record<string, unknown>>('rows')
    const p = ['c1', 'wht'] as const
    await vault.closePeriod({ name: '2026-01', endDate: '2026-01-31', dateField: 'date', partition: p })
    await vault.closePeriod({ name: '2026-03', endDate: '2026-03-31', dateField: 'date', partition: p })
    await vault.reopenPeriod('2026-03', { partition: p })
    await expect(rows.put('f', { id: 'f', c: 'c1', date: '2026-02-10' })).resolves.toBeUndefined()
    await expect(rows.put('j', { id: 'j', c: 'c1', date: '2026-01-10' })).rejects.toThrow(PeriodClosedError)
  })
})
