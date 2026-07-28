import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { VaultPeriods } from '../src/with-audit/periods/vault-facade.js'
import { withPeriods } from '../src/with-audit/periods/index.js'
import { PERIOD_TARGET_PURGES_COLLECTION } from '../src/with-audit/periods/periods.js'

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

function makeFacade(purgeTargetsImpl: (before: string) => Promise<readonly { label?: string; role: 'backup' | 'archive'; purgedCount: number }[]>) {
  const adapter = toMemory()
  let purgeCalls = 0
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
    archiveRecords: async () => 0,
    purgeTargets: async (before: string) => { purgeCalls++; return purgeTargetsImpl(before) },
  }
  const periods = new VaultPeriods(deps as any)
  return { periods, adapter, purgeCalls: () => purgeCalls }
}

async function closeAndFreeze(periods: any, name = 'FY26-Q1', endDate = '2026-03-31') {
  await periods.closePeriod({ name, endDate })
  await periods.freezePeriod(name)
}

describe('VaultPeriods.purgePeriodTargets (#615)', () => {
  it('sweeps push-only targets on a frozen period, writes the companion, returns merged fields', async () => {
    const { periods, adapter } = makeFacade(async () => [{ label: 'bkp', role: 'backup', purgedCount: 3 }])
    await closeAndFreeze(periods)
    const out = await periods.purgePeriodTargets('FY26-Q1')
    expect(out.targetsPurged).toEqual([{ label: 'bkp', role: 'backup', purgedCount: 3 }])
    expect(out.targetsPurgedBy).toBe('alice')
    expect(typeof out.targetsPurgedAt).toBe('string')
    expect(adapter.raw('V', PERIOD_TARGET_PURGES_COLLECTION, 'FY26-Q1')).toBeDefined()
  })

  it('throws when the period is not frozen first', async () => {
    const { periods } = makeFacade(async () => [{ role: 'backup', purgedCount: 0 }])
    await periods.closePeriod({ name: 'FY26-Q1', endDate: '2026-03-31' })   // closed but NOT frozen
    await expect(periods.purgePeriodTargets('FY26-Q1')).rejects.toThrow(/must be frozen first|frozen/i)
  })

  it('throws on an absent or opened period', async () => {
    const { periods } = makeFacade(async () => [])
    await expect(periods.purgePeriodTargets('nope')).rejects.toThrow(/no period named|not found/i)
    await closeAndFreeze(periods)
    await periods.openPeriod({ name: 'FY26-Q2', startDate: '2026-04-01', fromPeriod: 'FY26-Q1', carryForward: async () => ({}) })
    await expect(periods.purgePeriodTargets('FY26-Q2')).rejects.toThrow(/only a closed period|closed/i)
  })

  it('no push-only targets → writes NO companion and is re-runnable (no black hole)', async () => {
    let targets: readonly { label?: string; role: 'backup' | 'archive'; purgedCount: number }[] = []
    const { periods, adapter } = makeFacade(async () => targets)
    await closeAndFreeze(periods)
    const first = await periods.purgePeriodTargets('FY26-Q1')
    expect(first.targetsPurged).toBeUndefined()
    expect(adapter.raw('V', PERIOD_TARGET_PURGES_COLLECTION, 'FY26-Q1')).toBeUndefined()  // NO companion
    // a target appears later → a subsequent call DOES sweep + record it
    targets = [{ label: 'bkp', role: 'backup', purgedCount: 1 }]
    const second = await periods.purgePeriodTargets('FY26-Q1')
    expect(second.targetsPurged).toEqual([{ label: 'bkp', role: 'backup', purgedCount: 1 }])
    expect(adapter.raw('V', PERIOD_TARGET_PURGES_COLLECTION, 'FY26-Q1')).toBeDefined()
  })

  it('is idempotent once a companion exists: second call does not re-sweep', async () => {
    const { periods, purgeCalls } = makeFacade(async () => [{ role: 'backup', purgedCount: 2 }])
    await closeAndFreeze(periods)
    const first = await periods.purgePeriodTargets('FY26-Q1')
    const second = await periods.purgePeriodTargets('FY26-Q1')
    expect(second.targetsPurgedAt).toBe(first.targetsPurgedAt)
    expect(purgeCalls()).toBe(1)   // purgeTargets called exactly once
  })

  it('leaves the chained _periods record byte-identical', async () => {
    const { periods, adapter } = makeFacade(async () => [{ role: 'backup', purgedCount: 1 }])
    await closeAndFreeze(periods)
    const before = adapter.raw('V', '_periods', 'FY26-Q1')!._data
    await periods.purgePeriodTargets('FY26-Q1')
    expect(adapter.raw('V', '_periods', 'FY26-Q1')!._data).toBe(before)
  })

  it('getPeriod merges the target-purge fields alongside freeze', async () => {
    const { periods } = makeFacade(async () => [{ label: 'bkp', role: 'backup', purgedCount: 1 }])
    await closeAndFreeze(periods)
    await periods.purgePeriodTargets('FY26-Q1')
    const got = await periods.getPeriod('FY26-Q1')
    expect(got?.targetsPurged?.[0]?.purgedCount).toBe(1)
    expect(got?.frozenAt).toBeDefined()   // freeze merge still works
  })
})
