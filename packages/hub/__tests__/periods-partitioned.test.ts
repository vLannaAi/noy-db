/**
 * #1005 — partitioned accounting periods.
 *
 * A vault had exactly ONE period timeline (`PeriodRecord.name` was unique per
 * vault, `ClosePeriodOptions` carried no scope key), so it could not express a
 * close unit finer than the whole vault. Real statutory close is not
 * vault-global: separate legal entities file independently, and separate
 * sub-ledgers for the SAME entity and month close on different statutory
 * calendars — withholding tax weeks before VAT, billing later still.
 *
 * `partition` gives each `(subject, layer)` its own disjoint timeline, reusing
 * the tuple semantics `sequence('invoice', { partition: [2026, 'EU'] })`
 * already established: a partitioned key is always disjoint from any
 * unpartitioned one.
 *
 * The write guard needs to resolve a RECORD to its partition, which is what
 * `withPeriods({ subjects })` supplies — the same shape `withForget({ subjects })`
 * uses to answer the same question.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { toMemory } from '../../to-memory/src/index.js'
import { ValidationError, PeriodClosedError, createNoydb } from '../src/index.js'
import { withPeriods } from '../src/with-audit/periods/index.js'
import type { Noydb } from '../src/index.js'

interface Receipt extends Record<string, unknown> {
  clientId: string
  layer: 'wht' | 'vat' | 'billing'
  amount: number
  issuedAt: string
}

/** Mirrors the reporter's shape: the close unit is (client, layer, period). */
const subjects = {
  receipts: (r: Record<string, unknown>) => [r.clientId as string, r.layer as string],
}

describe('#1005 — partitioned accounting periods', () => {
  let db: Noydb

  beforeEach(async () => {
    db = await createNoydb({
      store: toMemory(),
      user: 'owner',
      encrypt: false,
      periodsStrategy: withPeriods({ subjects }),
    })
  })

  describe('timelines are disjoint', () => {
    it('allows the same period name in two different partitions', async () => {
      const vault = await db.openVault('acme')
      await vault.closePeriod({ name: '2026-06', endDate: '2026-06-30', dateField: 'issuedAt', partition: ['A', 'vat'] })
      await expect(
        vault.closePeriod({ name: '2026-06', endDate: '2026-06-30', dateField: 'issuedAt', partition: ['B', 'vat'] }),
      ).resolves.toBeTruthy()
    })

    it('still rejects a duplicate name WITHIN one partition', async () => {
      const vault = await db.openVault('acme')
      await vault.closePeriod({ name: '2026-06', endDate: '2026-06-30', partition: ['A', 'vat'] })
      await expect(
        vault.closePeriod({ name: '2026-06', endDate: '2026-07-31', partition: ['A', 'vat'] }),
      ).rejects.toBeInstanceOf(ValidationError)
    })

    it('treats a partitioned name as disjoint from the same unpartitioned name', async () => {
      const vault = await db.openVault('acme')
      await vault.closePeriod({ name: '2026-06', endDate: '2026-06-30' })
      await expect(
        vault.closePeriod({ name: '2026-06', endDate: '2026-06-30', partition: ['A', 'vat'] }),
      ).resolves.toBeTruthy()
      expect((await vault.listPeriods()).map((p) => p.partition)).toEqual([undefined, ['A', 'vat']])
    })

    it('records the partition on the stored period and survives a vault reload', async () => {
      const vault = await db.openVault('acme')
      await vault.closePeriod({ name: '2026-06', endDate: '2026-06-30', partition: ['A', 'vat'] })

      const reopened = await db.openVault('acme')
      const [p] = await reopened.listPeriods()
      expect(p?.partition).toEqual(['A', 'vat'])
    })
  })

  describe('the write guard applies only the record’s own partition', () => {
    it('seals a record whose partition is closed', async () => {
      const vault = await db.openVault('acme')
      const receipts = vault.collection<Receipt>('receipts')
      await receipts.put('r1', { clientId: 'A', layer: 'vat', amount: 100, issuedAt: '2026-06-15' })

      await vault.closePeriod({ name: '2026-06', endDate: '2026-06-30', dateField: 'issuedAt', partition: ['A', 'vat'] })

      await expect(
        receipts.put('r1', { clientId: 'A', layer: 'vat', amount: 999, issuedAt: '2026-06-15' }),
      ).rejects.toBeInstanceOf(PeriodClosedError)
    })

    it('leaves a DIFFERENT client’s same-month record writable', async () => {
      const vault = await db.openVault('acme')
      const receipts = vault.collection<Receipt>('receipts')
      await receipts.put('r2', { clientId: 'B', layer: 'vat', amount: 100, issuedAt: '2026-06-15' })

      await vault.closePeriod({ name: '2026-06', endDate: '2026-06-30', dateField: 'issuedAt', partition: ['A', 'vat'] })

      await expect(
        receipts.put('r2', { clientId: 'B', layer: 'vat', amount: 999, issuedAt: '2026-06-15' }),
      ).resolves.not.toThrow()
    })

    it('leaves the SAME client’s other layer writable — WHT sealed, VAT still open', async () => {
      const vault = await db.openVault('acme')
      const receipts = vault.collection<Receipt>('receipts')
      await receipts.put('w1', { clientId: 'A', layer: 'wht', amount: 50, issuedAt: '2026-06-10' })
      await receipts.put('v1', { clientId: 'A', layer: 'vat', amount: 100, issuedAt: '2026-06-10' })

      await vault.closePeriod({ name: '2026-06', endDate: '2026-06-30', dateField: 'issuedAt', partition: ['A', 'wht'] })

      await expect(
        receipts.put('w1', { clientId: 'A', layer: 'wht', amount: 51, issuedAt: '2026-06-10' }),
      ).rejects.toBeInstanceOf(PeriodClosedError)
      await expect(
        receipts.put('v1', { clientId: 'A', layer: 'vat', amount: 101, issuedAt: '2026-06-10' }),
      ).resolves.not.toThrow()
    })

    it('blocks a delete inside a closed partition and permits it outside', async () => {
      const vault = await db.openVault('acme')
      const receipts = vault.collection<Receipt>('receipts')
      await receipts.put('r1', { clientId: 'A', layer: 'vat', amount: 100, issuedAt: '2026-06-15' })
      await receipts.put('r2', { clientId: 'B', layer: 'vat', amount: 100, issuedAt: '2026-06-15' })

      await vault.closePeriod({ name: '2026-06', endDate: '2026-06-30', dateField: 'issuedAt', partition: ['A', 'vat'] })

      await expect(receipts.delete('r1')).rejects.toBeInstanceOf(PeriodClosedError)
      await expect(receipts.delete('r2')).resolves.not.toThrow()
    })

    it('cannot slide a record INTO a closed partition by rewriting its partition fields', async () => {
      const vault = await db.openVault('acme')
      const receipts = vault.collection<Receipt>('receipts')
      await receipts.put('r2', { clientId: 'B', layer: 'vat', amount: 100, issuedAt: '2026-06-15' })

      await vault.closePeriod({ name: '2026-06', endDate: '2026-06-30', dateField: 'issuedAt', partition: ['A', 'vat'] })

      // Re-assigning the record to client A would place it inside A's sealed
      // June. The incoming side must be checked under ITS OWN partition.
      await expect(
        receipts.put('r2', { clientId: 'A', layer: 'vat', amount: 100, issuedAt: '2026-06-15' }),
      ).rejects.toBeInstanceOf(PeriodClosedError)
    })

    it('cannot move a record OUT of a closed partition either', async () => {
      const vault = await db.openVault('acme')
      const receipts = vault.collection<Receipt>('receipts')
      await receipts.put('r1', { clientId: 'A', layer: 'vat', amount: 100, issuedAt: '2026-06-15' })

      await vault.closePeriod({ name: '2026-06', endDate: '2026-06-30', dateField: 'issuedAt', partition: ['A', 'vat'] })

      await expect(
        receipts.put('r1', { clientId: 'B', layer: 'vat', amount: 100, issuedAt: '2026-06-15' }),
      ).rejects.toBeInstanceOf(PeriodClosedError)
    })

    it('an UNPARTITIONED close does not seal a partitioned subject’s records', async () => {
      const vault = await db.openVault('acme')
      const receipts = vault.collection<Receipt>('receipts')
      await receipts.put('r1', { clientId: 'A', layer: 'vat', amount: 100, issuedAt: '2026-06-15' })

      await vault.closePeriod({ name: 'vault-wide', endDate: '2026-06-30', dateField: 'issuedAt' })

      await expect(
        receipts.put('r1', { clientId: 'A', layer: 'vat', amount: 999, issuedAt: '2026-06-15' }),
      ).resolves.not.toThrow()
    })

    it('a collection with no subject mapping is governed by the unpartitioned timeline', async () => {
      const vault = await db.openVault('acme')
      const settings = vault.collection<{ id: string; date: string; v: number }>('settings')
      await settings.put('s1', { id: 's1', date: '2026-06-15', v: 1 })

      await vault.closePeriod({ name: '2026-06', endDate: '2026-06-30', dateField: 'date', partition: ['A', 'vat'] })
      await expect(settings.put('s1', { id: 's1', date: '2026-06-15', v: 2 })).resolves.not.toThrow()

      await vault.closePeriod({ name: 'vault-wide', endDate: '2026-06-30', dateField: 'date' })
      await expect(settings.put('s1', { id: 's1', date: '2026-06-15', v: 3 })).rejects.toBeInstanceOf(PeriodClosedError)
    })
  })

  describe('listPeriods / getPeriod scoping', () => {
    beforeEach(async () => {
      const vault = await db.openVault('acme')
      await vault.closePeriod({ name: '2026-06', endDate: '2026-06-30', partition: ['A', 'vat'] })
      await vault.closePeriod({ name: '2026-06', endDate: '2026-06-30', partition: ['A', 'wht'] })
      await vault.closePeriod({ name: '2026-06', endDate: '2026-06-30', partition: ['B', 'vat'] })
      await vault.closePeriod({ name: 'vault-wide', endDate: '2026-06-30' })
    })

    it('listPeriods() with no argument still returns every timeline', async () => {
      const vault = await db.openVault('acme')
      expect(await vault.listPeriods()).toHaveLength(4)
    })

    it('listPeriods({ partition }) returns only that timeline', async () => {
      const vault = await db.openVault('acme')
      const scoped = await vault.listPeriods({ partition: ['A', 'vat'] })
      expect(scoped).toHaveLength(1)
      expect(scoped[0]?.partition).toEqual(['A', 'vat'])
    })

    it('getPeriod(name) resolves the UNPARTITIONED period by default', async () => {
      const vault = await db.openVault('acme')
      expect((await vault.getPeriod('2026-06'))).toBeNull()
      expect((await vault.getPeriod('vault-wide'))?.name).toBe('vault-wide')
    })

    it('getPeriod(name, { partition }) resolves within that timeline', async () => {
      const vault = await db.openVault('acme')
      const p = await vault.getPeriod('2026-06', { partition: ['A', 'wht'] })
      expect(p?.partition).toEqual(['A', 'wht'])
    })
  })

  describe('the hash chain runs per-partition', () => {
    it('chains a partition to its own predecessor, not to an interleaved other partition', async () => {
      const vault = await db.openVault('acme')
      await vault.closePeriod({ name: '2026-05', endDate: '2026-05-31', partition: ['A', 'vat'] })
      await vault.closePeriod({ name: '2026-05', endDate: '2026-05-31', partition: ['B', 'vat'] })
      await vault.closePeriod({ name: '2026-06', endDate: '2026-06-30', partition: ['A', 'vat'] })

      const aJune = (await vault.listPeriods({ partition: ['A', 'vat'] })).find((p) => p.name === '2026-06')
      expect(aJune?.priorPeriodName).toBe('2026-05')
      expect(aJune?.priorPeriodHash).not.toBe('')

      const firstInB = (await vault.listPeriods({ partition: ['B', 'vat'] }))[0]
      expect(firstInB?.priorPeriodName).toBeUndefined()
      expect(firstInB?.priorPeriodHash).toBe('')
    })

    it('openPeriod chains within the partition and rejects a fromPeriod in another one', async () => {
      const vault = await db.openVault('acme')
      await vault.closePeriod({ name: '2026-06', endDate: '2026-06-30', partition: ['A', 'vat'] })

      await expect(
        vault.openPeriod({
          name: '2026-07', startDate: '2026-07-01', fromPeriod: '2026-06',
          partition: ['B', 'vat'], carryForward: () => ({}),
        }),
      ).rejects.toBeInstanceOf(ValidationError)

      const opened = await vault.openPeriod({
        name: '2026-07', startDate: '2026-07-01', fromPeriod: '2026-06',
        partition: ['A', 'vat'], carryForward: () => ({}),
      })
      expect(opened.partition).toEqual(['A', 'vat'])
      expect(opened.priorPeriodName).toBe('2026-06')
    })
  })

  describe('partition component validation mirrors sequence()', () => {
    it('rejects an empty component', async () => {
      const vault = await db.openVault('acme')
      await expect(
        vault.closePeriod({ name: 'p', endDate: '2026-06-30', partition: [''] }),
      ).rejects.toBeInstanceOf(ValidationError)
    })

    it('rejects a non-finite numeric component', async () => {
      const vault = await db.openVault('acme')
      await expect(
        vault.closePeriod({ name: 'p', endDate: '2026-06-30', partition: [Number.NaN] }),
      ).rejects.toBeInstanceOf(ValidationError)
    })

    it('keeps components containing "/" distinct from a multi-component partition', async () => {
      const vault = await db.openVault('acme')
      await vault.closePeriod({ name: 'p', endDate: '2026-06-30', partition: ['a/b'] })
      await expect(
        vault.closePeriod({ name: 'p', endDate: '2026-06-30', partition: ['a', 'b'] }),
      ).resolves.toBeTruthy()
    })
  })

  describe('vault-wide physical operations refuse a partitioned period', () => {
    it('freezePeriod throws, naming the reason', async () => {
      const vault = await db.openVault('acme')
      await vault.closePeriod({ name: '2026-06', endDate: '2026-06-30', partition: ['A', 'vat'] })
      await expect(vault.freezePeriod('2026-06', { partition: ['A', 'vat'] }))
        .rejects.toBeInstanceOf(ValidationError)
    })

    it('archivePeriod throws', async () => {
      const vault = await db.openVault('acme')
      await vault.closePeriod({ name: '2026-06', endDate: '2026-06-30', partition: ['A', 'vat'] })
      await expect(vault.archivePeriod('2026-06', { partition: ['A', 'vat'] }))
        .rejects.toBeInstanceOf(ValidationError)
    })
  })
})

describe('#1005 — unpartitioned behaviour is unchanged without `subjects`', () => {
  it('withPeriods() with no config still seals vault-wide by business date', async () => {
    const db = await createNoydb({
      store: toMemory(), user: 'owner', encrypt: false, periodsStrategy: withPeriods(),
    })
    const vault = await db.openVault('acme')
    const receipts = vault.collection<Receipt>('receipts')
    await receipts.put('r1', { clientId: 'A', layer: 'vat', amount: 100, issuedAt: '2026-06-15' })
    await vault.closePeriod({ name: '2026-06', endDate: '2026-06-30', dateField: 'issuedAt' })
    await expect(
      receipts.put('r1', { clientId: 'A', layer: 'vat', amount: 999, issuedAt: '2026-06-15' }),
    ).rejects.toBeInstanceOf(PeriodClosedError)
  })
})
