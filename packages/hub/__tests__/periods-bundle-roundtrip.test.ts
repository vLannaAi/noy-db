/**
 * #1025 — period state must survive `dump()` → `load()` (and therefore
 * `writePod` → `vault.load`).
 *
 * `loadAll` deliberately filters out every `_`-prefixed collection, so
 * `dumpVault` carries reserved collections through an explicit allowlist
 * (`internalNames`). `_periods` and its four companions were simply not on it,
 * so a restored vault lost every close.
 *
 * The sharp end is not the missing row. The bundle is the backup/restore path,
 * so a restore discarded the hash-chained evidence that a month was ever
 * closed — the artifact `closePeriod` exists to produce — AND silently dropped
 * the write gate with it, so the reconstituted vault accepted back-dated writes
 * into a sealed month. Silent in both directions: no error on load, none on write.
 */
import { describe, it, expect } from 'vitest'
import { toMemory } from '../../to-memory/src/index.js'
import { createNoydb, PeriodClosedError } from '../src/index.js'
import { withHistory } from '../src/with-commit/history/index.js'
import { withPeriods } from '../src/with-audit/periods/index.js'
import type { Noydb } from '../src/index.js'

interface Filing extends Record<string, unknown> {
  id: string
  clientId: string
  bookedAt: string
}

const SECRET = 'bundle-roundtrip-2026'
const subjects = { filings: (r: Record<string, unknown>) => [String(r.clientId)] }

async function openVault(store = toMemory()) {
  const db: Noydb = await createNoydb({
    store, user: 'ann', secret: SECRET, validateSecret: false,
    // `dump()` is history-gated: with the ledger wired the backup also carries a
    // `ledgerHead`, which is what a real backup/restore looks like.
    historyStrategy: withHistory(),
    periodsStrategy: withPeriods({ subjects }),
  })
  return { db, vault: await db.openVault('niwat') }
}

describe('#1025 — period state survives a dump/load round-trip', () => {
  it('carries the closed period, and the restored vault still seals it', async () => {
    const src = await openVault()
    await src.vault.collection<Filing>('filings').put('f1', { id: 'f1', clientId: 'c1', bookedAt: '2026-07-02' })
    await src.vault.closePeriod({
      name: '2026-06', endDate: '2026-06-30', dateField: 'bookedAt', partition: ['c1'],
    })
    expect(await src.vault.listPeriods()).toHaveLength(1)
    const dumpJson = await src.vault.dump()

    const dst = await openVault()
    await dst.vault.load(dumpJson)

    // Ordinary data is the control — it round-tripped before this fix too.
    expect(await dst.vault.collection<Filing>('filings').list()).toHaveLength(1)
    // The close itself.
    const restored = await dst.vault.listPeriods()
    expect(restored).toHaveLength(1)
    expect(restored[0]?.name).toBe('2026-06')
    expect(restored[0]?.partition).toEqual(['c1'])

    // …and the gate came with it: a back-dated write into the sealed window.
    await expect(
      dst.vault.collection<Filing>('filings').put('late', { id: 'late', clientId: 'c1', bookedAt: '2026-06-15' }),
    ).rejects.toBeInstanceOf(PeriodClosedError)
  })

  it('preserves the hash chain across the restore', async () => {
    const src = await openVault()
    await src.vault.closePeriod({ name: '2026-05', endDate: '2026-05-31' })
    await src.vault.closePeriod({ name: '2026-06', endDate: '2026-06-30' })
    const before = await src.vault.listPeriods()
    const dumpJson = await src.vault.dump()

    const dst = await openVault()
    await dst.vault.load(dumpJson)
    const after = await dst.vault.listPeriods()

    expect(after.map((p) => p.name)).toEqual(before.map((p) => p.name))
    expect(after.map((p) => p.priorPeriodHash)).toEqual(before.map((p) => p.priorPeriodHash))
    expect(after.map((p) => p.closedAt)).toEqual(before.map((p) => p.closedAt))
  })

  it('carries the reopen log — a bounded window is state a restore must not drop', async () => {
    const src = await openVault()
    await src.vault.collection<Filing>('filings').put('f1', { id: 'f1', clientId: 'c1', bookedAt: '2026-07-02' })
    await src.vault.closePeriod({ name: '2026-06', endDate: '2026-06-30', dateField: 'bookedAt' })
    await src.vault.reopenPeriod('2026-06', { reason: 'missing invoice' })
    const dumpJson = await src.vault.dump()

    const dst = await openVault()
    await dst.vault.load(dumpJson)

    expect((await dst.vault.listPeriodReopens('2026-06')).map((e) => `${e.op}:${e.reason}`))
      .toEqual(['reopen:missing invoice'])
    // The restored vault is still REOPENED — the window survived, so a write
    // into the month is accepted exactly as it was on the source.
    await expect(
      dst.vault.collection<Filing>('filings').put('fix', { id: 'fix', clientId: 'c1', bookedAt: '2026-06-15' }),
    ).resolves.not.toThrow()
  })

  it('carries a freeze companion too', async () => {
    const src = await openVault()
    await src.vault.collection<Filing>('filings').put('f1', { id: 'f1', clientId: 'c1', bookedAt: '2026-01-02' })
    await src.vault.closePeriod({ name: '2026-01', endDate: '2026-01-31', dateField: 'bookedAt' })
    await src.vault.freezePeriod('2026-01')
    const dumpJson = await src.vault.dump()

    const dst = await openVault()
    await dst.vault.load(dumpJson)
    expect((await dst.vault.getPeriod('2026-01'))?.frozenAt).toBeDefined()
  })

  it('a vault with no periods still round-trips (the allowlist skips empty collections)', async () => {
    const src = await openVault()
    await src.vault.collection<Filing>('filings').put('f1', { id: 'f1', clientId: 'c1', bookedAt: '2026-07-02' })
    const dumpJson = await src.vault.dump()

    const dst = await openVault()
    await dst.vault.load(dumpJson)
    expect(await dst.vault.listPeriods()).toEqual([])
    expect(await dst.vault.collection<Filing>('filings').list()).toHaveLength(1)
  })
})
