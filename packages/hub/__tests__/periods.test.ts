/**
 * Tests for `vault.closePeriod()` + `vault.openPeriod()` (v0.17 #201 / #202).
 *
 * Covers:
 *   - Closure with `dateField` seals records by business date, not write-time
 *   - Late-entered records (write AFTER close) still blocked when business
 *     date falls inside the period — the documented fix for the `_ts` bug
 *     caught by advisor review
 *   - Incoming records that try to slide into a closed period (via a
 *     forged `date` field on put) are rejected
 *   - Closure without `dateField` falls back to write-time `_ts`
 *   - New-record inserts with a future business date pass
 *   - Duplicate period names / unknown fromPeriod / non-closed fromPeriod
 *   - listPeriods / getPeriod / fresh Vault reload / hash chain
 *   - openPeriod materialises opening balances via time-machine view
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { memory } from '../../to-memory/src/index.js'
import { ValidationError, PeriodClosedError, createNoydb } from '../src/index.js'
import { withPeriods } from '../src/periods/index.js'
import type { Noydb } from '../src/index.js'

interface Invoice { amount: number; status: string; date: string }

describe('vault.closePeriod() + openPeriod() — v0.17 #201 / #202', () => {
  let db: Noydb

  beforeEach(async () => {
    db = await createNoydb({
      store: memory(),
      user: 'owner',
      encrypt: false,
      periodsStrategy: withPeriods(),
    })
  })

  describe('dateField-based seal (accounting semantics)', () => {
    it('blocks updates to a record whose business date falls in the closed period', async () => {
      const vault = await db.openVault('acme')
      const invoices = vault.collection<Invoice>('invoices')
      await invoices.put('inv-1', { amount: 100, status: 'draft', date: '2026-01-15' })

      await vault.closePeriod({
        name: 'FY2026-Q1',
        endDate: '2026-03-31',
        dateField: 'date',
      })

      await expect(
        invoices.put('inv-1', { amount: 999, status: 'paid', date: '2026-01-15' }),
      ).rejects.toBeInstanceOf(PeriodClosedError)
    })

    it('blocks delete of a record whose business date is inside the closed period', async () => {
      const vault = await db.openVault('acme')
      const invoices = vault.collection<Invoice>('invoices')
      await invoices.put('inv-1', { amount: 100, status: 'draft', date: '2026-01-15' })

      await vault.closePeriod({ name: 'FY2026-Q1', endDate: '2026-03-31', dateField: 'date' })

      await expect(invoices.delete('inv-1')).rejects.toBeInstanceOf(PeriodClosedError)
    })

    it('blocks a LATE-entered record (the canonical accounting bug)', async () => {
      // The fix for advisor's #240 critique: even if I book the
      // invoice on 2026-04-22 (after Q1 closed), if its business
      // date is 2026-01-15 (inside Q1), the write must still fail.
      const vault = await db.openVault('acme')
      const invoices = vault.collection<Invoice>('invoices')

      await vault.closePeriod({ name: 'FY2026-Q1', endDate: '2026-03-31', dateField: 'date' })

      // Attempting to insert a record with a business date in the
      // closed period — this must fail even though the write-time
      // is fresh.
      await expect(
        invoices.put('inv-late', { amount: 500, status: 'draft', date: '2026-01-15' }),
      ).rejects.toBeInstanceOf(PeriodClosedError)
    })

    it('blocks backdating — edit that tries to slide an existing record into a closed period', async () => {
      const vault = await db.openVault('acme')
      const invoices = vault.collection<Invoice>('invoices')
      await invoices.put('inv-live', { amount: 500, status: 'draft', date: '2026-06-15' })

      await vault.closePeriod({ name: 'FY2026-Q1', endDate: '2026-03-31', dateField: 'date' })

      // Trying to backdate inv-live to Q1 → rejected because
      // INCOMING record.date falls in the closed period.
      await expect(
        invoices.put('inv-live', { amount: 500, status: 'paid', date: '2026-01-15' }),
      ).rejects.toBeInstanceOf(PeriodClosedError)
    })

    it('allows writes against records with future business dates', async () => {
      const vault = await db.openVault('acme')
      const invoices = vault.collection<Invoice>('invoices')
      await invoices.put('inv-1', { amount: 100, status: 'draft', date: '2026-06-15' })

      await vault.closePeriod({ name: 'FY2026-Q1', endDate: '2026-03-31', dateField: 'date' })

      // inv-1.date = 2026-06-15 is AFTER the period; edits allowed.
      await expect(
        invoices.put('inv-1', { amount: 200, status: 'paid', date: '2026-06-15' }),
      ).resolves.toBeUndefined()
    })

    it('allows fresh inserts dated AFTER the closed period', async () => {
      const vault = await db.openVault('acme')
      const invoices = vault.collection<Invoice>('invoices')
      await vault.closePeriod({ name: 'FY2026-Q1', endDate: '2026-03-31', dateField: 'date' })

      await expect(
        invoices.put('inv-new', { amount: 300, status: 'paid', date: '2026-04-15' }),
      ).resolves.toBeUndefined()
    })
  })

  describe('fallback _ts-based seal (no dateField)', () => {
    it('blocks existing-record writes when prior envelope _ts falls in the period', async () => {
      const vault = await db.openVault('acme')
      const invoices = vault.collection<Invoice>('invoices')
      await invoices.put('inv-1', { amount: 100, status: 'draft', date: '2026-01-15' })

      // No dateField → guard uses envelope _ts which is "now" — use
      // a future endDate so the fallback triggers.
      await vault.closePeriod({ name: 'Anything', endDate: '2099-12-31' })

      await expect(
        invoices.put('inv-1', { amount: 999, status: 'paid', date: '2026-01-15' }),
      ).rejects.toBeInstanceOf(PeriodClosedError)
    })

    it('allows fresh inserts under _ts-based seal — new ids have no prior envelope', async () => {
      const vault = await db.openVault('acme')
      const invoices = vault.collection<Invoice>('invoices')
      await invoices.put('inv-1', { amount: 100, status: 'draft', date: '2026-01-15' })

      await vault.closePeriod({ name: 'Anything', endDate: '2099-12-31' })

      await expect(
        invoices.put('inv-fresh', { amount: 200, status: 'draft', date: '2026-05-10' }),
      ).resolves.toBeUndefined()
    })
  })

  describe('bookkeeping', () => {
    it('rejects duplicate period names', async () => {
      const vault = await db.openVault('acme')
      await vault.closePeriod({ name: 'Q1', endDate: '2026-03-31' })
      await expect(vault.closePeriod({ name: 'Q1', endDate: '2026-06-30' })).rejects.toBeInstanceOf(
        ValidationError,
      )
    })

    it('lists and looks up periods', async () => {
      const vault = await db.openVault('acme')
      await vault.closePeriod({ name: 'Q1', endDate: '2026-03-31', dateField: 'date' })
      await vault.closePeriod({ name: 'Q2', endDate: '2026-06-30', dateField: 'date' })
      const all = await vault.listPeriods()
      expect(all).toHaveLength(2)
      expect(all.map((p) => p.name).sort()).toEqual(['Q1', 'Q2'])
      expect((await vault.getPeriod('Q1'))?.dateField).toBe('date')
      expect(await vault.getPeriod('NEVER')).toBeNull()
    })

    it('hash-chains subsequent closures to the prior period', async () => {
      const vault = await db.openVault('acme')
      const q1 = await vault.closePeriod({ name: 'Q1', endDate: '2026-03-31' })
      const q2 = await vault.closePeriod({ name: 'Q2', endDate: '2026-06-30' })
      expect(q1.priorPeriodHash).toBe('')
      expect(q1.priorPeriodName).toBeUndefined()
      expect(q2.priorPeriodName).toBe('Q1')
      expect(q2.priorPeriodHash).not.toBe('')
    })

    it('records the closer as closedBy and stamps closedAt', async () => {
      const vault = await db.openVault('acme')
      const before = Date.now()
      const p = await vault.closePeriod({ name: 'Q1', endDate: '2026-03-31' })
      const after = Date.now()
      expect(p.closedBy).toBe('owner')
      const ts = Date.parse(p.closedAt)
      expect(ts).toBeGreaterThanOrEqual(before)
      expect(ts).toBeLessThanOrEqual(after)
    })

    it('period cache reloads from adapter in a fresh Vault instance', async () => {
      const store = memory()
      const db1 = await createNoydb({ store, user: 'owner', encrypt: false, periodsStrategy: withPeriods() })
      const v1 = await db1.openVault('acme')
      await v1.collection<Invoice>('invoices').put('inv-1', { amount: 100, status: 'draft', date: '2026-01-15' })
      await v1.closePeriod({ name: 'Q1', endDate: '2026-03-31', dateField: 'date' })
      db1.close()

      const db2 = await createNoydb({ store, user: 'owner', encrypt: false, periodsStrategy: withPeriods() })
      const v2 = await db2.openVault('acme')
      await expect(
        v2.collection<Invoice>('invoices').put('inv-1', { amount: 999, status: 'paid', date: '2026-01-15' }),
      ).rejects.toBeInstanceOf(PeriodClosedError)
      db2.close()
    })
  })

  describe('openPeriod — carry-forward', () => {
    it('writes opening entries from a read-only facade over current state', async () => {
      const vault = await db.openVault('acme')
      const invoices = vault.collection<Invoice>('invoices')

      await invoices.put('inv-a', { amount: 100, status: 'paid', date: '2026-01-15' })
      await invoices.put('inv-b', { amount: 200, status: 'paid', date: '2026-02-15' })

      await vault.closePeriod({ name: 'Q1', endDate: '2026-03-31', dateField: 'date' })

      const opened = await vault.openPeriod({
        name: 'Q2',
        startDate: '2026-04-01',
        fromPeriod: 'Q1',
        carryForward: async (ctx) => {
          const closing = await ctx.collection<Invoice>('invoices').list()
          const carried: Record<string, Invoice> = {}
          for (const entry of closing) {
            if (entry.date <= ctx.priorEndDate) {
              carried[`${entry.status}-${entry.date}-cf`] = {
                ...entry,
                status: 'carried-forward',
                date: '2026-04-01',
              }
            }
          }
          return { invoices: carried }
        },
      })
      expect(opened.kind).toBe('opened')
      expect(opened.openingCollections).toEqual(['invoices'])

      const cfKeys = (await invoices.list()).filter((r) => r.status === 'carried-forward')
      expect(cfKeys).toHaveLength(2)
    })

    it('rejects unknown fromPeriod', async () => {
      const vault = await db.openVault('acme')
      await expect(
        vault.openPeriod({
          name: 'Q2',
          startDate: '2026-04-01',
          fromPeriod: 'NEVER',
          carryForward: async () => ({}),
        }),
      ).rejects.toBeInstanceOf(ValidationError)
    })

    it('rejects an opened (non-closed) fromPeriod', async () => {
      const vault = await db.openVault('acme')
      await vault.closePeriod({ name: 'Q1', endDate: '2026-03-31' })
      await vault.openPeriod({
        name: 'Q2',
        startDate: '2026-04-01',
        fromPeriod: 'Q1',
        carryForward: async () => ({}),
      })
      await expect(
        vault.openPeriod({
          name: 'Q3',
          startDate: '2026-07-01',
          fromPeriod: 'Q2',
          carryForward: async () => ({}),
        }),
      ).rejects.toBeInstanceOf(ValidationError)
    })
  })
})
