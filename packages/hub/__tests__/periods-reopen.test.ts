/**
 * #1022 — reopening a closed period.
 *
 * Close is a three-state lifecycle in practice — open / closed / reopened —
 * and the service offered two. A month gets closed and then a missing invoice
 * arrives, or a filing is rejected and must be amended; the accountant
 * reopens, corrects, and recloses. That is routine, and it is supposed to leave
 * a trail.
 *
 * Two properties matter more than the ability to write again:
 *
 *  1. The reopen is recorded on an APPEND-ONLY log, and the hash-chained
 *     `_periods/<key>` record is never touched — a reopen that rewrote the
 *     close would destroy the very evidence that the close happened.
 *  2. A reopen withdraws the PERIOD's veto and nothing else. Record-level
 *     rules stay in force, so a reopened month cannot resurrect a document
 *     that is independently immutable.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { toMemory } from '../../to-memory/src/index.js'
import {
  ValidationError, PeriodClosedError, RecordLockedError, createNoydb, immutableGuard,
} from '../src/index.js'
import { withPeriods } from '../src/with-audit/periods/index.js'
import type { Noydb } from '../src/index.js'

interface Filing extends Record<string, unknown> {
  id: string
  clientId: string
  layer: string
  amount: number
  date: string
}

const subjects = {
  filings: (r: Record<string, unknown>) => [r.clientId as string, r.layer as string],
}

const past = (ms: number) => new Date(Date.now() - ms).toISOString()
const future = (ms: number) => new Date(Date.now() + ms).toISOString()

describe('#1022 — reopenPeriod', () => {
  let db: Noydb

  beforeEach(async () => {
    db = await createNoydb({
      store: toMemory(), user: 'owner', encrypt: false, periodsStrategy: withPeriods(),
    })
  })

  async function closedJune() {
    const vault = await db.openVault('acme')
    const filings = vault.collection<Filing>('filings')
    await filings.put('f1', { id: 'f1', clientId: 'A', layer: 'vat', amount: 100, date: '2026-06-15' })
    await vault.closePeriod({ name: '2026-06', endDate: '2026-06-30', dateField: 'date' })
    return { vault, filings }
  }

  describe('the lifecycle', () => {
    it('a closed period refuses writes; a reopened one accepts them', async () => {
      const { vault, filings } = await closedJune()
      await expect(filings.put('f1', { id: 'f1', clientId: 'A', layer: 'vat', amount: 999, date: '2026-06-15' }))
        .rejects.toBeInstanceOf(PeriodClosedError)

      await vault.reopenPeriod('2026-06', { reason: 'client sent a missing invoice' })

      await expect(filings.put('f1', { id: 'f1', clientId: 'A', layer: 'vat', amount: 999, date: '2026-06-15' }))
        .resolves.not.toThrow()
      expect((await filings.get('f1'))?.amount).toBe(999)
    })

    it('recloses on demand and the seal comes back', async () => {
      const { vault, filings } = await closedJune()
      await vault.reopenPeriod('2026-06')
      await filings.put('f1', { id: 'f1', clientId: 'A', layer: 'vat', amount: 200, date: '2026-06-15' })

      await vault.reclosePeriod('2026-06', { reason: 'corrections applied' })

      await expect(filings.put('f1', { id: 'f1', clientId: 'A', layer: 'vat', amount: 300, date: '2026-06-15' }))
        .rejects.toBeInstanceOf(PeriodClosedError)
    })

    it('allows a delete while reopened, and refuses it again after reclose', async () => {
      const { vault, filings } = await closedJune()
      await expect(filings.delete('f1')).rejects.toBeInstanceOf(PeriodClosedError)
      await vault.reopenPeriod('2026-06')
      await expect(filings.delete('f1')).resolves.not.toThrow()
      await vault.reclosePeriod('2026-06')
      await filings.put('f2', { id: 'f2', clientId: 'A', layer: 'vat', amount: 1, date: '2026-07-01' })
      await expect(filings.delete('f2')).resolves.not.toThrow() // July is not sealed
    })

    it('survives a vault reload — reopen state is persisted, not in-memory', async () => {
      const { vault } = await closedJune()
      await vault.reopenPeriod('2026-06', { reason: 'persisted' })

      const reopened = await db.openVault('acme')
      await expect(
        reopened.collection<Filing>('filings')
          .put('f1', { id: 'f1', clientId: 'A', layer: 'vat', amount: 42, date: '2026-06-15' }),
      ).resolves.not.toThrow()
      expect((await reopened.getPeriod('2026-06'))?.reopenReason).toBe('persisted')
    })
  })

  describe('a bounded window re-seals itself', () => {
    it('an `until` in the future keeps the period writable', async () => {
      const { vault, filings } = await closedJune()
      await vault.reopenPeriod('2026-06', { until: future(60_000) })
      await expect(filings.put('f1', { id: 'f1', clientId: 'A', layer: 'vat', amount: 5, date: '2026-06-15' }))
        .resolves.not.toThrow()
    })

    it('an `until` already elapsed leaves the period sealed — no sweep, no timer', async () => {
      const { vault, filings } = await closedJune()
      await vault.reopenPeriod('2026-06', { until: past(60_000) })
      await expect(filings.put('f1', { id: 'f1', clientId: 'A', layer: 'vat', amount: 5, date: '2026-06-15' }))
        .rejects.toBeInstanceOf(PeriodClosedError)
    })

    it('rejects an unparseable `until` rather than treating it as unbounded', async () => {
      const { vault } = await closedJune()
      await expect(vault.reopenPeriod('2026-06', { until: 'next tuesday' }))
        .rejects.toBeInstanceOf(ValidationError)
    })
  })

  describe('the audit trail', () => {
    it('records close → reopen → reclose → reopen in order, append-only', async () => {
      const { vault } = await closedJune()
      await vault.reopenPeriod('2026-06', { reason: 'first' })
      await vault.reclosePeriod('2026-06', { reason: 'done' })
      await vault.reopenPeriod('2026-06', { reason: 'second' })

      const log = await vault.listPeriodReopens('2026-06')
      expect(log.map((e) => e.op)).toEqual(['reopen', 'reclose', 'reopen'])
      expect(log.map((e) => e.reason)).toEqual(['first', 'done', 'second'])
      expect(log.every((e) => e.by === 'owner')).toBe(true)
      // Monotonic, and every entry carries its own instant.
      expect(log.map((e) => e.at)).toEqual([...log.map((e) => e.at)].sort())
    })

    it('never mutates the hash-chained close record', async () => {
      const { vault } = await closedJune()
      const before = await vault.getPeriod('2026-06')
      await vault.reopenPeriod('2026-06')
      await vault.reclosePeriod('2026-06')
      const after = await vault.getPeriod('2026-06')

      // The chain-bearing fields are byte-identical across the whole cycle.
      expect(after?.closedAt).toBe(before?.closedAt)
      expect(after?.closedBy).toBe(before?.closedBy)
      expect(after?.priorPeriodHash).toBe(before?.priorPeriodHash)
      expect(after?.endDate).toBe(before?.endDate)
      expect(after?.kind).toBe('closed')
    })

    it('surfaces the current state on the period record', async () => {
      const { vault } = await closedJune()
      expect((await vault.getPeriod('2026-06'))?.reopenedAt).toBeUndefined()

      await vault.reopenPeriod('2026-06', { reason: 'why' })
      const open = await vault.getPeriod('2026-06')
      expect(open?.reopenedBy).toBe('owner')
      expect(open?.reopenReason).toBe('why')
      expect(open?.reclosedAt).toBeUndefined()
      expect(open?.reopenCount).toBe(1)

      await vault.reclosePeriod('2026-06')
      const shut = await vault.getPeriod('2026-06')
      expect(shut?.reclosedAt).toBeDefined()
      expect(shut?.reopenCount).toBe(1)
    })

    it('listPeriods reports reopen state too', async () => {
      const { vault } = await closedJune()
      await vault.reopenPeriod('2026-06')
      const [p] = await vault.listPeriods()
      expect(p?.reopenedAt).toBeDefined()
    })
  })

  describe('refusals', () => {
    it('an unknown period', async () => {
      const { vault } = await closedJune()
      await expect(vault.reopenPeriod('2026-99')).rejects.toBeInstanceOf(ValidationError)
    })

    it('an OPENED period — only a closed one can be reopened', async () => {
      const { vault } = await closedJune()
      await vault.openPeriod({ name: '2026-07', startDate: '2026-07-01', fromPeriod: '2026-06', carryForward: () => ({}) })
      await expect(vault.reopenPeriod('2026-07')).rejects.toBeInstanceOf(ValidationError)
    })

    it('reclosing something that is not open', async () => {
      const { vault } = await closedJune()
      await expect(vault.reclosePeriod('2026-06')).rejects.toBeInstanceOf(ValidationError)
    })

    it('reclosing a window that already lapsed on its own', async () => {
      const { vault } = await closedJune()
      await vault.reopenPeriod('2026-06', { until: past(60_000) })
      await expect(vault.reclosePeriod('2026-06')).rejects.toThrow(/re-sealed on its own/)
    })
  })

  describe('record-level immutability still wins — reopen only widens', () => {
    it('a reopened period does not resurrect a record under immutableGuard', async () => {
      const guarded = await createNoydb({
        store: toMemory(), user: 'owner', encrypt: false,
        periodsStrategy: withPeriods(),
        guardStrategies: [immutableGuard<Filing>({ name: 'filings-worm', collection: 'filings', appendOnly: true })],
      })
      const vault = await guarded.openVault('acme')
      const filings = vault.collection<Filing>('filings')
      await filings.put('f1', { id: 'f1', clientId: 'A', layer: 'vat', amount: 100, date: '2026-06-15' })
      await vault.closePeriod({ name: '2026-06', endDate: '2026-06-30', dateField: 'date' })

      await vault.reopenPeriod('2026-06')

      // The period veto is gone; the record's own lock is not.
      await expect(filings.put('f1', { id: 'f1', clientId: 'A', layer: 'vat', amount: 999, date: '2026-06-15' }))
        .rejects.toBeInstanceOf(RecordLockedError)
      // ...and a record the guard does NOT lock is writable again.
      await expect(filings.put('f-new', { id: 'f-new', clientId: 'A', layer: 'vat', amount: 1, date: '2026-06-20' }))
        .resolves.not.toThrow()
    })
  })
})

describe('#1022 × #1005 — reopen is partition-scoped', () => {
  let db: Noydb

  beforeEach(async () => {
    db = await createNoydb({
      store: toMemory(), user: 'owner', encrypt: false,
      periodsStrategy: withPeriods({ subjects }),
    })
  })

  async function twoClosedTimelines() {
    const vault = await db.openVault('acme')
    const filings = vault.collection<Filing>('filings')
    await filings.put('a1', { id: 'a1', clientId: 'A', layer: 'vat', amount: 10, date: '2026-06-15' })
    await filings.put('b1', { id: 'b1', clientId: 'B', layer: 'vat', amount: 20, date: '2026-06-15' })
    await vault.closePeriod({ name: '2026-06', endDate: '2026-06-30', dateField: 'date', partition: ['A', 'vat'] })
    await vault.closePeriod({ name: '2026-06', endDate: '2026-06-30', dateField: 'date', partition: ['B', 'vat'] })
    return { vault, filings }
  }

  it('reopening one timeline leaves the other sealed', async () => {
    const { vault, filings } = await twoClosedTimelines()
    await vault.reopenPeriod('2026-06', { partition: ['A', 'vat'] })

    await expect(filings.put('a1', { id: 'a1', clientId: 'A', layer: 'vat', amount: 11, date: '2026-06-15' }))
      .resolves.not.toThrow()
    await expect(filings.put('b1', { id: 'b1', clientId: 'B', layer: 'vat', amount: 21, date: '2026-06-15' }))
      .rejects.toBeInstanceOf(PeriodClosedError)
  })

  it('keeps a separate log per timeline', async () => {
    const { vault } = await twoClosedTimelines()
    await vault.reopenPeriod('2026-06', { partition: ['A', 'vat'], reason: 'A only' })

    expect((await vault.listPeriodReopens('2026-06', { partition: ['A', 'vat'] })).map((e) => e.reason)).toEqual(['A only'])
    expect(await vault.listPeriodReopens('2026-06', { partition: ['B', 'vat'] })).toEqual([])
  })

  it('unlike freeze/archive, reopen accepts a partitioned period', async () => {
    const { vault } = await twoClosedTimelines()
    // freeze/archive refuse — they sweep a write-time window across the whole
    // ciphertext store. Reopen changes no stored bytes, so it composes.
    await expect(vault.freezePeriod('2026-06', { partition: ['A', 'vat'] })).rejects.toBeInstanceOf(ValidationError)
    await expect(vault.reopenPeriod('2026-06', { partition: ['A', 'vat'] })).resolves.toBeTruthy()
  })
})
