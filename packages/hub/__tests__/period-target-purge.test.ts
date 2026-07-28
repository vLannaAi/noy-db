import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { createNoydb } from '../src/kernel/noydb.js'
import { withPeriods } from '../src/with-audit/periods/index.js'
import { withHistory } from '../src/with-commit/history/index.js'
import { withSync } from '../src/with-party/sync/index.js'
import { isDeleteMarker } from '../src/kernel/enclave/index.js'

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
    async put(c, col, id, env, ev) { const m = gc(c, col); const ex = m.get(id); if (ev !== undefined && ex && ex._v !== ev) throw Object.assign(new Error('conflict'), { name: 'ConflictError' }); m.set(id, env) },
    async delete(c, col, id) { store.get(c)?.get(col)?.delete(id) },
    async list(c, col) { const m = store.get(c)?.get(col); return m ? [...m.keys()] : [] },
    async loadAll(c) { const comp = store.get(c); const s: VaultSnapshot = {}; if (comp) for (const [n, coll] of comp) { if (!n.startsWith('_')) { const r: Record<string, EncryptedEnvelope> = {}; for (const [id, e] of coll) r[id] = e; s[n] = r } } return s },
    async saveAll(c, data) { for (const [n, recs] of Object.entries(data)) { const m = gc(c, n); for (const [id, e] of Object.entries(recs)) m.set(id, e) } },
  }
}

const V = 'V1'

// Build a vault with the given sync targets; returns the stores for white-box assertions.
async function makeVault(targets: { store: NoydbStore; role: 'backup' | 'archive' | 'sync-peer'; label?: string }[]) {
  const local = toMemory()
  const db = await createNoydb({
    store: local,
    ...(targets.length > 0 ? { sync: targets } : {}),   // omit sync when empty (withSync still enables _del markers)
    user: 'alice',
    syncStrategy: withSync(),
    periodsStrategy: withPeriods(),
    historyStrategy: withHistory(),
    secret: 'hunter2',
  })
  const vault = await db.openVault(V)
  return { local, db, vault }
}

// Produce a real encrypted delete marker for (col,id) by deleting locally, then return it.
async function realMarker(vault: any, local: ReturnType<typeof toMemory>, col: string, id: string): Promise<EncryptedEnvelope> {
  const t = vault.collection(col)
  await t.put(id, { amount: 1, date: '2026-02-01' })
  await t.delete(id)                 // under withSync, delete writes a _del marker (not a physical delete)
  const m = local.raw(V, col, id)!
  expect(isDeleteMarker(m)).toBe(true)
  return m
}

describe('purgePeriodTargets (#615)', () => {
  it('sweeps in-window markers off a backup target; local unaffected; count recorded', async () => {
    const backup = toMemory()
    const { local, db, vault } = await makeVault([{ store: backup, role: 'backup', label: 'bkp' }])
    const marker = await realMarker(vault, local, 'txns', 'a')
    // seed the same real marker onto the backup with an in-window _ts (white-box, mimics a pushed marker)
    await backup.put(V, 'txns', 'a', { ...marker, _ts: '2026-02-15T00:00:00.000Z' })

    await vault.closePeriod({ name: 'FY26-Q1', endDate: '2026-03-31' })
    await vault.freezePeriod('FY26-Q1')
    const out = await vault.purgePeriodTargets('FY26-Q1')

    expect(out.targetsPurged).toEqual([{ label: 'bkp', role: 'backup', purgedCount: 1 }])
    expect(backup.raw(V, 'txns', 'a')).toBeUndefined()          // marker swept off backup
    db.close()
  })

  it('skips sync-peer targets (their markers survive)', async () => {
    const backup = toMemory(), peer = toMemory()
    const { local, db, vault } = await makeVault([
      { store: backup, role: 'backup', label: 'bkp' },
      { store: peer, role: 'sync-peer', label: 'peer' },
    ])
    const marker = await realMarker(vault, local, 'txns', 'a')
    await backup.put(V, 'txns', 'a', { ...marker, _ts: '2026-02-15T00:00:00.000Z' })
    await peer.put(V, 'txns', 'a', { ...marker, _ts: '2026-02-15T00:00:00.000Z' })

    await vault.closePeriod({ name: 'FY26-Q1', endDate: '2026-03-31' })
    await vault.freezePeriod('FY26-Q1')
    const out = await vault.purgePeriodTargets('FY26-Q1')

    expect(out.targetsPurged?.map(t => t.label)).toEqual(['bkp'])   // only the backup swept
    expect(backup.raw(V, 'txns', 'a')).toBeUndefined()
    expect(peer.raw(V, 'txns', 'a')).toBeDefined()                  // sync-peer marker SURVIVES
    db.close()
  })

  it('leaves out-of-window markers on the backup', async () => {
    const backup = toMemory()
    const { local, db, vault } = await makeVault([{ store: backup, role: 'backup', label: 'bkp' }])
    const marker = await realMarker(vault, local, 'txns', 'late')
    await backup.put(V, 'txns', 'late', { ...marker, _ts: '2026-09-01T00:00:00.000Z' })  // after endDate

    await vault.closePeriod({ name: 'FY26-Q1', endDate: '2026-03-31' })
    await vault.freezePeriod('FY26-Q1')
    await vault.purgePeriodTargets('FY26-Q1')
    expect(backup.raw(V, 'txns', 'late')).toBeDefined()
    db.close()
  })

  it('requires the period be frozen first', async () => {
    const backup = toMemory()
    const { db, vault } = await makeVault([{ store: backup, role: 'backup' }])
    await vault.closePeriod({ name: 'FY26-Q1', endDate: '2026-03-31' })   // not frozen
    await expect(vault.purgePeriodTargets('FY26-Q1')).rejects.toThrow(/frozen first|frozen/i)
    db.close()
  })

  it('no push-only targets → no companion; verifyBackupIntegrity ok', async () => {
    const { db, vault } = await makeVault([])   // no targets at all
    await vault.closePeriod({ name: 'FY26-Q1', endDate: '2026-03-31' })
    await vault.freezePeriod('FY26-Q1')
    const out = await vault.purgePeriodTargets('FY26-Q1')
    expect(out.targetsPurged).toBeUndefined()
    expect((await vault.verifyBackupIntegrity()).ok).toBe(true)
    db.close()
  })

  it('records the sweep to _period_target_purges (verifyBackupIntegrity stays ok)', async () => {
    const backup = toMemory()
    const { local, db, vault } = await makeVault([{ store: backup, role: 'backup', label: 'bkp' }])
    const marker = await realMarker(vault, local, 'txns', 'a')
    await backup.put(V, 'txns', 'a', { ...marker, _ts: '2026-02-15T00:00:00.000Z' })
    await vault.closePeriod({ name: 'FY26-Q1', endDate: '2026-03-31' })
    await vault.freezePeriod('FY26-Q1')
    await vault.purgePeriodTargets('FY26-Q1')
    expect((await vault.verifyBackupIntegrity()).ok).toBe(true)   // ledger attributed to _period_target_purges
    db.close()
  })
})
