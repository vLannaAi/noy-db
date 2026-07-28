import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { VaultPeriods } from '../src/with-audit/periods/vault-facade.js'
import { withPeriods } from '../src/with-audit/periods/index.js'
import { PERIOD_ARCHIVES_COLLECTION } from '../src/with-audit/periods/periods.js'

function toMemory(): NoydbStore & { raw(c: string, col: string, id: string): EncryptedEnvelope | undefined } {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const gc = (c: string, col: string) => {
    let a = store.get(c); if (!a) { a = new Map(); store.set(c, a) }
    let b = a.get(col); if (!b) { b = new Map(); a.set(col, b) }
    return b
  }
  return {
    raw: (c, col, id) => store.get(c)?.get(col)?.get(id),
    async get(c, col, id) { return store.get(c)?.get(col)?.get(id) ?? null },
    async put(c, col, id, env) { gc(c, col).set(id, env) },
    async delete(c, col, id) { store.get(c)?.get(col)?.delete(id) },
    async list(c, col) { const m = store.get(c)?.get(col); return m ? [...m.keys()] : [] },
    async loadAll() { return {} as VaultSnapshot },
    async saveAll() {},
  }
}

function makeFacade() {
  const adapter = toMemory()
  let archiveArg: string | undefined
  const deps = {
    strategy: withPeriods(),
    adapter,
    vault: 'V',
    encrypted: false,
    userId: () => 'alice',
    getDEK: async () => { throw new Error('no crypto in plaintext test') },
    getLedgerOrNull: () => null,          // history off → appendPeriodLedgerEntry no-ops
    collection: () => { throw new Error('unused') },
    purgeDeleteMarkers: async () => 0,
    archiveRecords: async (before: string) => { archiveArg = before; return 2 },
  }
  const periods = new VaultPeriods(deps as any)
  return { periods, adapter, archiveArg: () => archiveArg }
}

describe('VaultPeriods.archivePeriod (#613)', () => {
  it('archives a closed period: calls archiveRecords with the _ts upper bound, writes the companion, returns merged fields', async () => {
    const { periods, adapter, archiveArg } = makeFacade()
    await periods.closePeriod({ name: 'FY26-Q1', endDate: '2026-03-31' })

    const archived = await periods.archivePeriod('FY26-Q1')

    expect(archiveArg()).toBe('2026-04-01T00:00:00.000Z')          // periodExclusiveUpperBound('2026-03-31')
    expect(archived.archivedRecordCount).toBe(2)
    expect(archived.archivedBy).toBe('alice')
    expect(typeof archived.archivedAt).toBe('string')
    expect(adapter.raw('V', PERIOD_ARCHIVES_COLLECTION, 'FY26-Q1')).toBeDefined()  // companion written
  })

  it('throws on an absent or opened period', async () => {
    const { periods } = makeFacade()
    await expect(periods.archivePeriod('nope')).rejects.toThrow(/no period named|not found/i)
    await periods.closePeriod({ name: 'FY26-Q1', endDate: '2026-03-31' })
    await periods.openPeriod({ name: 'FY26-Q2', startDate: '2026-04-01', fromPeriod: 'FY26-Q1', carryForward: async () => ({}) })
    await expect(periods.archivePeriod('FY26-Q2')).rejects.toThrow(/only a closed period|closed/i)
  })

  it('is idempotent: second archive is a no-op (companion unchanged, archiveRecords not called again)', async () => {
    const { periods, adapter } = makeFacade()
    await periods.closePeriod({ name: 'FY26-Q1', endDate: '2026-03-31' })
    const first = await periods.archivePeriod('FY26-Q1')
    const companionBefore = adapter.raw('V', PERIOD_ARCHIVES_COLLECTION, 'FY26-Q1')!._data
    const second = await periods.archivePeriod('FY26-Q1')
    expect(second.archivedAt).toBe(first.archivedAt)
    expect(adapter.raw('V', PERIOD_ARCHIVES_COLLECTION, 'FY26-Q1')!._data).toBe(companionBefore)
  })

  it('is idempotent: archiveRecords is called exactly once across two archivePeriod calls, proving the early return happens before the seam + ledger append (#613 whole-branch M3)', async () => {
    const adapter = toMemory()
    let archiveCalls = 0
    const deps = {
      strategy: withPeriods(),
      adapter,
      vault: 'V',
      encrypted: false,
      userId: () => 'alice',
      getDEK: async () => { throw new Error('no crypto in plaintext test') },
      getLedgerOrNull: () => null,
      collection: () => { throw new Error('unused') },
      purgeDeleteMarkers: async () => 0,
      archiveRecords: async () => { archiveCalls += 1; return 2 },
    }
    const periods = new VaultPeriods(deps as any)
    await periods.closePeriod({ name: 'FY26-Q1', endDate: '2026-03-31' })
    await periods.archivePeriod('FY26-Q1')
    await periods.archivePeriod('FY26-Q1')
    expect(archiveCalls).toBe(1)
  })

  it('leaves the chained _periods record byte-identical (never mutated by archive)', async () => {
    const { periods, adapter } = makeFacade()
    await periods.closePeriod({ name: 'FY26-Q1', endDate: '2026-03-31' })
    const before = adapter.raw('V', '_periods', 'FY26-Q1')!._data
    await periods.archivePeriod('FY26-Q1')
    expect(adapter.raw('V', '_periods', 'FY26-Q1')!._data).toBe(before)
  })

  it('getPeriod merges the archive fields', async () => {
    const { periods } = makeFacade()
    await periods.closePeriod({ name: 'FY26-Q1', endDate: '2026-03-31' })
    await periods.archivePeriod('FY26-Q1')
    const got = await periods.getPeriod('FY26-Q1')
    expect(got?.archivedRecordCount).toBe(2)
    expect(got?.archivedBy).toBe('alice')
  })

  it('listPeriods merges the archive fields (#613 whole-branch M2)', async () => {
    const { periods } = makeFacade()
    await periods.closePeriod({ name: 'FY26-Q1', endDate: '2026-03-31' })
    await periods.archivePeriod('FY26-Q1')
    const all = await periods.listPeriods()
    const got = all.find((p) => p.name === 'FY26-Q1')
    expect(got?.archivedRecordCount).toBe(2)
    expect(got?.archivedBy).toBe('alice')
  })
})
