/**
 * #1455 — the documented `_ts` fallback exists, and a date the gate cannot
 * read is refused rather than admitted.
 *
 * `ClosePeriodOptions.endDate` promised: sealed when `record[dateField]` (or,
 * if absent, the envelope `_ts`) is at or before endDate. The implementation
 * tested `typeof v === 'string'` and `continue`d past the `_ts` branch, so the
 * fallback existed only for periods that declared NO dateField — the opposite
 * of the sentence — and `undefined`, `null`, a `Date` and a number all wrote
 * straight into a sealed cell.
 *
 * The posture, per value shape:
 *   - a `Date`            → compared as the ISO string it will be stored as.
 *   - absent / null       → the record carries no business date, so it is in
 *                           NO period. The docstring's per-record `_ts` fallback
 *                           is withdrawn rather than implemented: honouring it
 *                           would seal every dateless row written before a
 *                           vault-wide close — settings, MV outputs — on the day
 *                           the first period closes. `PeriodRecord.dateField`'s
 *                           own doc always said the `_ts` seal is for periods
 *                           that declare NO dateField; the two sentences now agree.
 *   - anything else       → refused. "Unable to determine" is not "permitted".
 */
import { describe, it, expect } from 'vitest'
import { toMemory } from '../../to-memory/src/index.js'
import { createNoydb, PeriodClosedError, ValidationError } from '../src/index.js'
import { withPeriods } from '../src/with-audit/periods/index.js'

const subjects = { rows: (r: Record<string, unknown>) => [r.c as string, 'vat'] }

async function sealedCell() {
  const db = await createNoydb({ store: toMemory(), user: 'owner', encrypt: false, periodsStrategy: withPeriods({ subjects }) })
  const vault = await db.openVault('acme')
  const rows = vault.collection<Record<string, unknown>>('rows')
  await vault.closePeriod({ name: '2026-06', endDate: '2026-06-30', dateField: 'cycle', partition: ['c1', 'vat'] })
  return { vault, rows }
}

describe('#1455 — values the gate could not read', () => {
  it('a Date inside the sealed window is refused, not admitted by its type', async () => {
    const { rows } = await sealedCell()
    await expect(rows.put('r', { id: 'r', c: 'c1', cycle: new Date('2026-06-15T00:00:00Z') })).rejects.toThrow(PeriodClosedError)
  })

  it('a Date after the window is still writable', async () => {
    const { rows } = await sealedCell()
    await expect(rows.put('r', { id: 'r', c: 'c1', cycle: new Date('2026-07-15T00:00:00Z') })).resolves.toBeUndefined()
  })

  it.each([
    ['epoch number', 1_749_945_600_000],
    ['boolean', true],
    ['object', { y: 2026, m: 6 }],
  ])('%s is refused as unevaluable', async (_label, cycle) => {
    const { rows } = await sealedCell()
    await expect(rows.put('r', { id: 'r', c: 'c1', cycle })).rejects.toThrow(ValidationError)
    await expect(rows.put('r', { id: 'r', c: 'c1', cycle })).rejects.toThrow(/cycle/)
  })

  it('an unevaluable value on a row OUTSIDE the closed partition is not the gate\'s business', async () => {
    const { rows } = await sealedCell()
    await expect(rows.put('r', { id: 'r', c: 'c2', cycle: 42 })).resolves.toBeUndefined()
  })
})

describe('#1455 — absent date means outside every period', () => {
  it('a stored row with NO date field stays writable through a close whose window contains its write time', async () => {
    const db = await createNoydb({ store: toMemory(), user: 'owner', encrypt: false, periodsStrategy: withPeriods({ subjects }) })
    const vault = await db.openVault('acme')
    const rows = vault.collection<Record<string, unknown>>('rows')
    await rows.put('r', { id: 'r', c: 'c1', amount: 1 })            // written now, no `cycle`
    const future = new Date(Date.now() + 86_400_000).toISOString()
    await vault.closePeriod({ name: 'now', endDate: future, dateField: 'cycle', partition: ['c1', 'vat'] })
    await expect(rows.put('r', { id: 'r', c: 'c1', amount: 2 })).resolves.toBeUndefined()
    await expect(rows.delete('r')).resolves.toBeUndefined()
  })

  it('null is absent, not a value the gate refuses', async () => {
    const { rows } = await sealedCell()
    await expect(rows.put('r', { id: 'r', c: 'c1', cycle: null })).resolves.toBeUndefined()
  })

  it('a period with NO dateField keeps its write-time seal — that path is unchanged', async () => {
    const db = await createNoydb({ store: toMemory(), user: 'owner', encrypt: false, periodsStrategy: withPeriods({ subjects }) })
    const vault = await db.openVault('acme')
    const rows = vault.collection<Record<string, unknown>>('rows')
    await rows.put('r', { id: 'r', c: 'c1', amount: 1 })
    const future = new Date(Date.now() + 86_400_000).toISOString()
    await vault.closePeriod({ name: 'now', endDate: future, partition: ['c1', 'vat'] })
    await expect(rows.put('r', { id: 'r', c: 'c1', amount: 2 })).rejects.toThrow(PeriodClosedError)
  })
})

describe('#1455 — PeriodClosedError is structured', () => {
  it('names the field and the side without making the consumer regex the message', async () => {
    const { rows } = await sealedCell()
    const err = await rows.put('r', { id: 'r', c: 'c1', cycle: '2026-06-15' }).catch((e: unknown) => e) as PeriodClosedError
    expect(err).toBeInstanceOf(PeriodClosedError)
    expect(err.dateField).toBe('cycle')
    expect(err.side).toBe('incoming')
    expect(err.periodName).toBe('2026-06')
  })
})
