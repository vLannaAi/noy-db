/**
 * Showcase 15 — Financial year-end closure workflow
 * GitHub issue: https://github.com/vLannaAi/noy-db/issues/203 (+ #204 verify)
 *
 * Framework: pure hub
 * Store:     `memory()`
 * Pattern:   Local only (see docs/guides/topology-matrix.md, Pattern A)
 * Dimension: accounting compliance — period closure + opening + audit
 *
 * What this proves:
 *   1. `vault.closePeriod({ name, endDate, dateField })` seals every
 *      record whose BUSINESS DATE (`record[dateField]`) falls inside
 *      the period. Late entries (posted today for Q1) are still
 *      sealed if their logical date is in Q1 — the check is against
 *      the stored record, not the write timestamp.
 *   2. Backdating attempts fail — trying to edit a live record into a
 *      closed period's date range throws PeriodClosedError.
 *   3. `vault.openPeriod({ fromPeriod, carryForward })` materialises
 *      opening balances in the new period. The callback reads a
 *      time-machine view of the prior close; returned records land
 *      with fresh dates outside the closed period.
 *   4. The ledger captures every period closure + opening as a
 *      tamper-evident entry, so `vault.ledger().verify()` cross-
 *      checks the full chain of closures, openings, and underlying
 *      journal writes in one call.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createNoydb, PeriodClosedError, sum, type Noydb } from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'
import { SHOWCASE_PASSPHRASE } from './_fixtures.js'

interface LedgerEntry {
  id: string
  account: string
  debit: number
  credit: number
  date: string // business date (ISO) — used by closePeriod's dateField
  memo?: string
}

describe('Showcase 15 — Financial year-end closure workflow', () => {
  let db: Noydb

  beforeEach(async () => {
    db = await createNoydb({
      store: memory(),
      user: 'cfo',
      secret: SHOWCASE_PASSPHRASE,
    })
    await db.openVault('firm')
  })

  afterEach(() => {
    db.close()
  })

  it('step 1 — post Q1 entries against the journal', async () => {
    const v = db.vault('firm')
    const journal = v.collection<LedgerEntry>('journal')
    await journal.put('J001', { id: 'J001', account: 'revenue', debit: 0, credit: 10_000, date: '2026-01-15' })
    await journal.put('J002', { id: 'J002', account: 'cash', debit: 10_000, credit: 0, date: '2026-01-15' })
    await journal.put('J003', { id: 'J003', account: 'revenue', debit: 0, credit: 25_000, date: '2026-02-20' })
    await journal.put('J004', { id: 'J004', account: 'cash', debit: 25_000, credit: 0, date: '2026-02-20' })
    const q1TotalCredit = journal
      .query()
      .aggregate({ total: sum('credit') })
      .run().total
    expect(q1TotalCredit).toBe(35_000)
  })

  it('step 2 — close Q1 with dateField:"date" — business-date seal', async () => {
    const v = db.vault('firm')
    const journal = v.collection<LedgerEntry>('journal')
    await journal.put('J001', { id: 'J001', account: 'revenue', debit: 0, credit: 10_000, date: '2026-01-15' })

    const closed = await v.closePeriod({
      name: 'FY2026-Q1',
      endDate: '2026-03-31',
      dateField: 'date',
    })
    expect(closed.kind).toBe('closed')
    expect(closed.closedBy).toBe('cfo')
    expect(closed.endDate).toBe('2026-03-31')
    expect(closed.dateField).toBe('date')
    expect(closed.priorPeriodHash).toBe('') // first in the chain
  })

  it('step 3 — post-close edits to a Q1 entry throw PeriodClosedError', async () => {
    const v = db.vault('firm')
    const journal = v.collection<LedgerEntry>('journal')
    await journal.put('J001', { id: 'J001', account: 'revenue', debit: 0, credit: 10_000, date: '2026-01-15' })
    await v.closePeriod({ name: 'FY2026-Q1', endDate: '2026-03-31', dateField: 'date' })

    // Edit rejected — J001.date = 2026-01-15 is inside Q1.
    await expect(
      journal.put('J001', { id: 'J001', account: 'revenue', debit: 0, credit: 999, date: '2026-01-15', memo: 'fraud' }),
    ).rejects.toBeInstanceOf(PeriodClosedError)

    // Delete also rejected.
    try {
      await journal.delete('J001')
    } catch (err) {
      expect(err).toBeInstanceOf(PeriodClosedError)
      const e = err as PeriodClosedError
      expect(e.periodName).toBe('FY2026-Q1')
      expect(e.endDate).toBe('2026-03-31')
    }
  })

  it('step 4 — LATE entry for Q1 is rejected (the canonical accounting correctness check)', async () => {
    const v = db.vault('firm')
    const journal = v.collection<LedgerEntry>('journal')

    await v.closePeriod({ name: 'FY2026-Q1', endDate: '2026-03-31', dateField: 'date' })

    // Today's write, but for a Q1 business date — must fail. This
    // is the scenario a `_ts`-only seal would silently let through.
    await expect(
      journal.put('J-late', { id: 'J-late', account: 'revenue', debit: 0, credit: 5_000, date: '2026-01-20' }),
    ).rejects.toBeInstanceOf(PeriodClosedError)

    // Q2 entry (outside the closed period) is fine.
    await expect(
      journal.put('J-q2', { id: 'J-q2', account: 'revenue', debit: 0, credit: 7_000, date: '2026-05-10' }),
    ).resolves.toBeUndefined()
  })

  it('step 5 — open Q2 with a closing trial balance carried forward from Q1', async () => {
    const v = db.vault('firm')
    const journal = v.collection<LedgerEntry>('journal')

    // Q1 journal entries.
    await journal.put('J001', { id: 'J001', account: 'revenue', debit: 0, credit: 10_000, date: '2026-01-15' })
    await journal.put('J002', { id: 'J002', account: 'cash', debit: 10_000, credit: 0, date: '2026-01-15' })
    await journal.put('J003', { id: 'J003', account: 'revenue', debit: 0, credit: 25_000, date: '2026-02-20' })
    await journal.put('J004', { id: 'J004', account: 'cash', debit: 25_000, credit: 0, date: '2026-02-20' })

    await v.closePeriod({ name: 'FY2026-Q1', endDate: '2026-03-31', dateField: 'date' })

    // Open Q2 — the carry-forward callback sees a time-machine view
    // of Q1's closing state and produces opening balances dated
    // 2026-04-01, which fall outside the sealed period.
    const opened = await v.openPeriod({
      name: 'FY2026-Q2',
      startDate: '2026-04-01',
      fromPeriod: 'FY2026-Q1',
      carryForward: async (ctx) => {
        const closing = await ctx.collection<LedgerEntry>('journal').list()
        const totals: Record<string, number> = {}
        for (const entry of closing) {
          // Only include entries dated within the prior period.
          if (entry.date > ctx.priorEndDate) continue
          const delta = entry.credit - entry.debit
          totals[entry.account] = (totals[entry.account] ?? 0) + delta
        }
        const opening: Record<string, LedgerEntry> = {}
        for (const [account, balance] of Object.entries(totals)) {
          const openingId = `OB-${account}`
          opening[openingId] = {
            id: openingId,
            account,
            debit: balance < 0 ? Math.abs(balance) : 0,
            credit: balance > 0 ? balance : 0,
            date: '2026-04-01', // Q2, outside the sealed Q1 window
            memo: 'Carried forward from FY2026-Q1',
          }
        }
        return { journal: opening }
      },
    })
    expect(opened.kind).toBe('opened')
    expect(opened.openingCollections).toEqual(['journal'])

    const obRevenue = await journal.get('OB-revenue')
    const obCash = await journal.get('OB-cash')
    expect(obRevenue?.credit).toBe(35_000)
    expect(obCash?.debit).toBe(35_000)
  })

  it('step 6 — the ledger captures every closure + opening as chained entries', async () => {
    const v = db.vault('firm')
    const journal = v.collection<LedgerEntry>('journal')
    await journal.put('J001', { id: 'J001', account: 'revenue', debit: 0, credit: 10_000, date: '2026-01-15' })
    await v.closePeriod({ name: 'FY2026-Q1', endDate: '2026-03-31', dateField: 'date' })
    await v.openPeriod({
      name: 'FY2026-Q2',
      startDate: '2026-04-01',
      fromPeriod: 'FY2026-Q1',
      carryForward: async () => ({
        journal: {
          'OB-revenue': { id: 'OB-revenue', account: 'revenue', debit: 0, credit: 10_000, date: '2026-04-01' },
        },
      }),
    })

    const result = await v.ledger().verify()
    expect(result.ok).toBe(true)

    const entries = await v.ledger().entries()
    expect(entries.length).toBeGreaterThanOrEqual(4)
    const opsByCollection = entries.map((e) => `${e.op}:${e.collection}`)
    expect(opsByCollection).toContain('put:_periods')
  })

  it('step 7 — listPeriods reports both closed and opened periods in order', async () => {
    const v = db.vault('firm')
    await v.closePeriod({ name: 'FY2026-Q1', endDate: '2026-03-31', dateField: 'date' })
    await v.openPeriod({
      name: 'FY2026-Q2',
      startDate: '2026-04-01',
      fromPeriod: 'FY2026-Q1',
      carryForward: async () => ({}),
    })
    await v.closePeriod({ name: 'FY2026-Q2-Close', endDate: '2026-06-30', dateField: 'date' })

    const all = await v.listPeriods()
    expect(all).toHaveLength(3)
    expect(all[0]!.name).toBe('FY2026-Q1')
    expect(all[0]!.kind).toBe('closed')
    expect(all[1]!.name).toBe('FY2026-Q2')
    expect(all[1]!.kind).toBe('opened')
    expect(all[2]!.name).toBe('FY2026-Q2-Close')
  })
})
