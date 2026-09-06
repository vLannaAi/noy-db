/**
 * #1452 — a sealed record's attachments are sealed with it.
 *
 * `withPeriods()` refused `put()` on a record in a closed cell and ALLOWED
 * `blob(id).put(slot, …)` and `blob(id).delete(slot)` on the same record.
 * Either policy is defensible alone; together they run the wrong way for an
 * accounting product — the filed amount is immutable while the pay-in slip
 * attached as its evidence can be swapped or destroyed, with no error and no
 * audit line.
 *
 * Decision on record: option (1) from the report — a blob write or delete is
 * gated on the OWNING RECORD exactly as an update of that record would be.
 * The blob path runs the same `beforePut` gate bus with `incoming = existing`,
 * so it is not only periods: a record guard's `check` that would refuse an
 * update refuses the attachment change too. "Sealed" means the record and
 * what hangs off it.
 *
 * A record that does not exist yet is not gated (attaching before the first
 * `put()` was always allowed and still is), and an open cell is untouched.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { PeriodClosedError, RecordLockedError } from '../src/kernel/errors.js'
import { withBlobs } from '../src/via/blob/index.js'
import { withPeriods } from '../src/with-audit/periods/index.js'
import { withGuard } from '../src/with-audit/guards/with-guard.js'
import { makeStore, bytes } from './_blob-issues-store.js'

const SECRET = 'issue-1452-periods-gate-blob-writes'
const subjects = { disbursements: (r: Record<string, unknown>) => [r.client as string, 'pnd1'] }

interface Disbursement { id: string; client: string; cycle: string; amount: number; status?: string }

async function sealed() {
  const db = await createNoydb({
    store: makeStore(), user: 'a', secret: SECRET,
    blobsStrategy: withBlobs(),
    periodsStrategy: withPeriods({ subjects }),
    guardStrategies: [withGuard({
      collection: 'disbursements',
      // Locks a record once it HAS been issued: the seed write lands, the next change does not.
      check: (r, ctx) => { if ((ctx.existing as Disbursement | null)?.status === 'issued') throw new RecordLockedError('disbursements', (r as Disbursement).id, 'issued') },
    })],
  })
  const vault = await db.openVault('V')
  const d = vault.collection<Disbursement>('disbursements')
  await d.put('jan', { id: 'jan', client: 'c1', cycle: '2026-01', amount: 100 })
  await d.blob('jan').put('qr', bytes(2_000, 3))
  await d.put('jul', { id: 'jul', client: 'c1', cycle: '2026-07', amount: 100 })
  await d.blob('jul').put('qr', bytes(2_000, 4))
  await vault.closePeriod({ name: '2026-01', endDate: '2026-01-31', dateField: 'cycle', partition: ['c1', 'pnd1'] })
  return { vault, d }
}

describe('#1452 — closed cell', () => {
  it('the record put is refused (control)', async () => {
    const { d } = await sealed()
    await expect(d.put('jan', { id: 'jan', client: 'c1', cycle: '2026-01', amount: 999 })).rejects.toThrow(PeriodClosedError)
  })

  it('a blob put on the sealed record is refused with the same error', async () => {
    const { d } = await sealed()
    await expect(d.blob('jan').put('qr', bytes(2_000, 9))).rejects.toThrow(PeriodClosedError)
    // …and the evidence is exactly what it was.
    expect(await d.blob('jan').get('qr')).toEqual(bytes(2_000, 3))
  })

  it('a blob delete on the sealed record is refused', async () => {
    const { d } = await sealed()
    await expect(d.blob('jan').delete('qr')).rejects.toThrow(PeriodClosedError)
    expect((await d.blob('jan').list()).map((s) => s.name)).toEqual(['qr'])
  })

  it('a NEW slot on the sealed record is refused too — evidence is fixed at close, not just protected', async () => {
    const { d } = await sealed()
    await expect(d.blob('jan').put('extra', bytes(100))).rejects.toThrow(PeriodClosedError)
  })

  it('the open cell is untouched', async () => {
    const { d } = await sealed()
    await expect(d.blob('jul').put('qr', bytes(2_000, 9))).resolves.toBeUndefined()
    await expect(d.blob('jul').delete('qr')).resolves.toBeUndefined()
  })

  it('reopening the period frees the attachments with the record', async () => {
    const { vault, d } = await sealed()
    await vault.reopenPeriod('2026-01', { partition: ['c1', 'pnd1'] })
    await expect(d.blob('jan').put('qr', bytes(2_000, 9))).resolves.toBeUndefined()
  })
})

describe('#1452 — the gate is the record gate, not a periods special case', () => {
  it('a record guard that refuses an update refuses an attachment change', async () => {
    const { d } = await sealed()
    await d.put('iss', { id: 'iss', client: 'c1', cycle: '2026-07', amount: 1, status: 'issued' })
    await expect(d.blob('iss').put('qr', bytes(10))).rejects.toThrow(RecordLockedError)
  })

  it('a record that does not exist yet is not gated', async () => {
    const { d } = await sealed()
    await expect(d.blob('not-yet').put('qr', bytes(10))).resolves.toBeUndefined()
  })
})
