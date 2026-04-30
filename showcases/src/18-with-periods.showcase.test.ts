/**
 * Showcase 18 — withPeriods()
 *
 * What you'll learn
 * ─────────────────
 * Accounting periods turn the ledger into a sealed audit surface.
 * `vault.closePeriod({ name, endDate })` writes a period record;
 * subsequent writes whose business date falls in the closed range
 * throw `PeriodClosedError`. `listPeriods()` shows the chain. The
 * `dateField` option lets you seal by `invoiceDate` rather than
 * envelope `_ts` for late-booked records.
 *
 * Why it matters
 * ──────────────
 * Period closure is the central control of any double-entry
 * accounting system. Without it, "we re-open Q3 for one fix" is an
 * uncontrolled write; with it, every late entry is auditable and
 * gated by an explicit `reopenPeriod()` step.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 07 (history baseline — periods chain to the ledger).
 *
 * What to read next
 * ─────────────────
 *   - showcase 19-with-consent (consent scopes for sensitive workflows)
 *   - docs/subsystems/periods.md
 *
 * Spec mapping
 * ────────────
 * features.yaml → features → periods
 */

import { describe, it, expect } from 'vitest'
import { createNoydb, PeriodClosedError } from '@noy-db/hub'
import { withHistory } from '@noy-db/hub/history'
import { withPeriods } from '@noy-db/hub/periods'
import { memory } from '@noy-db/to-memory'

interface Invoice { id: string; invoiceDate: string; amount: number }

describe('Showcase 18 — withPeriods()', () => {
  it('closes a period and rejects writes whose business date falls in it', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'with-periods-passphrase-2026',
      historyStrategy: withHistory(),
      periodsStrategy: withPeriods(),
    })
    const vault = await db.openVault('demo')
    const invoices = vault.collection<Invoice>('invoices')

    await invoices.put('inv-1', { id: 'inv-1', invoiceDate: '2026-Q1-15', amount: 100 })
    await invoices.put('inv-2', { id: 'inv-2', invoiceDate: '2026-Q1-20', amount: 200 })

    await vault.closePeriod({
      name: '2026-Q1',
      endDate: '2026-Q1-31',
      dateField: 'invoiceDate',
    })

    // A late-arriving Q1 entry is rejected.
    await expect(
      invoices.put('inv-late', { id: 'inv-late', invoiceDate: '2026-Q1-10', amount: 50 }),
    ).rejects.toBeInstanceOf(PeriodClosedError)

    // Q2 entries flow as usual.
    await invoices.put('inv-3', { id: 'inv-3', invoiceDate: '2026-Q2-05', amount: 300 })
    expect(await invoices.get('inv-3')).not.toBeNull()

    db.close()
  })

  it('listPeriods() returns the chain of closures', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'with-periods-passphrase-2026',
      historyStrategy: withHistory(),
      periodsStrategy: withPeriods(),
    })
    const vault = await db.openVault('demo')
    vault.collection<Invoice>('invoices')

    await vault.closePeriod({ name: '2026-Q1', endDate: '2026-Q1-31', dateField: 'invoiceDate' })
    await vault.closePeriod({ name: '2026-Q2', endDate: '2026-Q2-30', dateField: 'invoiceDate' })

    const periods = await vault.listPeriods()
    expect(periods.map((p) => p.name)).toEqual(['2026-Q1', '2026-Q2'])
    expect(periods.every((p) => p.kind === 'closed')).toBe(true)

    db.close()
  })
})
