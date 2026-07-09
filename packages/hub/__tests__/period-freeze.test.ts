/**
 * Tests for `vault.freezePeriod()` (#604).
 *
 * Freeze physically purges the delete markers that fall inside a
 * CLOSED period's window and records that fact in a companion
 * `_period_freezes/<name>` record — kept OFF the hash-chained
 * `_periods/<name>` record so freezing never mutates a chained
 * record's bytes (load-bearing: see "leaves ... byte-immutable"
 * below). `frozenAt` / `frozenBy` / `purgedMarkerCount` are merged
 * into `PeriodRecord`s on read only (`getPeriod` / `listPeriods`).
 *
 * Harness mirrors delete-tombstone-convergence.test.ts's white-box
 * `memory()` store (exposes `.raw()`) wired with `withSync()` so
 * `delete()` leaves a marker instead of a physical removal.
 */
import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { ConflictError } from '../src/kernel/errors.js'
import { createNoydb } from '../src/kernel/noydb.js'
import { withSync } from '../src/with-party/sync/index.js'
import { withPeriods } from '../src/with-audit/periods/index.js'
import { withHistory } from '../src/with-commit/history/index.js'
import { isDeleteMarker } from '../src/kernel/enclave/record-keys/tombstone.js'

/** In-memory store exposing raw stored envelopes for white-box assertions. */
function memory(): NoydbStore & { raw(c: string, col: string, id: string): EncryptedEnvelope | undefined } {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function gc(c: string, col: string) {
    let comp = store.get(c); if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col); if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    raw(c, col, id) { return store.get(c)?.get(col)?.get(id) },
    async get(c, col, id) { return store.get(c)?.get(col)?.get(id) ?? null },
    async put(c, col, id, env, ev) {
      const coll = gc(c, col); const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(c, col, id) { store.get(c)?.get(col)?.delete(id) },
    async list(c, col) { const coll = store.get(c)?.get(col); return coll ? [...coll.keys()] : [] },
    async loadAll(c) {
      const comp = store.get(c); const s: VaultSnapshot = {}
      if (comp) for (const [n, coll] of comp) { if (!n.startsWith('_')) { const r: Record<string, EncryptedEnvelope> = {}; for (const [id, e] of coll) r[id] = e; s[n] = r } }
      return s
    },
    async saveAll(c, data) {
      for (const [n, recs] of Object.entries(data)) { const coll = gc(c, n); for (const [id, e] of Object.entries(recs)) coll.set(id, e) }
    },
  }
}

interface Row { amount: number; date: string }
const V = 'V1'

async function makeVault() {
  const local = memory(); const remote = memory()
  const db = await createNoydb({
    store: local,
    sync: remote,
    user: 'alice',
    syncStrategy: withSync(),
    periodsStrategy: withPeriods(),
    historyStrategy: withHistory(),
    secret: 'hunter2',
  })
  const vault = await db.openVault(V)
  return { local, remote, db, vault }
}

describe('freezePeriod (#604)', () => {
  it('purges in-window delete markers, records the companion + count, leaves the chained record byte-immutable', async () => {
    const { local, db, vault } = await makeVault()
    const t = vault.collection<Row>('txns')
    await t.put('a', { amount: 1, date: '2026-02-01' }); await db.push(V)
    await t.delete('a'); await db.push(V)                          // delete marker, _ts ~ now (2026-07)
    // Force the marker's _ts into the period window for the test:
    const m = local.raw(V, 'txns', 'a')!; expect(isDeleteMarker(m)).toBe(true)
    await local.put(V, 'txns', 'a', { ...m, _ts: '2026-02-15T00:00:00.000Z' })
    await vault.closePeriod({ name: 'FY26-Q1', endDate: '2026-03-31' })
    const before = local.raw(V, '_periods', 'FY26-Q1')!            // snapshot the chained record bytes

    const frozen = await vault.freezePeriod('FY26-Q1')

    expect(frozen.frozenAt).toBeTruthy()
    expect(frozen.frozenBy).toBe('alice')
    expect(frozen.purgedMarkerCount).toBe(1)
    expect(local.raw(V, 'txns', 'a')).toBeUndefined()             // marker physically gone
    expect(local.raw(V, '_period_freezes', 'FY26-Q1')).toBeDefined()
    const after = local.raw(V, '_periods', 'FY26-Q1')!
    expect(after._iv).toBe(before._iv); expect(after._data).toBe(before._data)  // chained record UNCHANGED
    db.close()
  })

  it('leaves out-of-window markers and live records untouched', async () => {
    const { local, db, vault } = await makeVault()
    const t = vault.collection<Row>('txns', { perRecordKeys: true })
    await t.put('live', { amount: 5, date: '2026-02-01' })
    await t.put('late', { amount: 2, date: '2026-02-01' }); await db.push(V)
    await t.delete('late'); await db.push(V)
    const late = local.raw(V, 'txns', 'late')!
    await local.put(V, 'txns', 'late', { ...late, _ts: '2026-05-10T00:00:00.000Z' })  // deleted AFTER Q1 window
    await vault.closePeriod({ name: 'FY26-Q1', endDate: '2026-03-31' })

    const frozen = await vault.freezePeriod('FY26-Q1')
    expect(frozen.purgedMarkerCount).toBe(0)                      // 'late' marker is out of window
    expect(local.raw(V, 'txns', 'late')).toBeDefined()           // out-of-window marker kept
    expect((await t.get('live'))!.amount).toBe(5)                 // live untouched
    db.close()
  })

  it('requires a closed period: throws on absent or opened', async () => {
    const { db, vault } = await makeVault()
    await expect(vault.freezePeriod('nope')).rejects.toThrow(/no period named/)
    await vault.closePeriod({ name: 'FY26-Q1', endDate: '2026-03-31' })
    await vault.openPeriod({ name: 'FY26-Q2', startDate: '2026-04-01', fromPeriod: 'FY26-Q1', carryForward: async () => ({}) })
    await expect(vault.freezePeriod('FY26-Q2')).rejects.toThrow(/only a closed period/)
    db.close()
  })

  it('refuses to freeze a period whose purge window reaches into the future (#610)', async () => {
    const { db, vault } = await makeVault()
    // closePeriod does not validate endDate against now, so a future window is reachable.
    await vault.closePeriod({ name: 'FY99', endDate: '2099-12-31' })
    await expect(vault.freezePeriod('FY99')).rejects.toThrow(/future/)
    db.close()
  })

  it('is idempotent: a second freeze is a no-op (no re-purge, no second ledger entry)', async () => {
    const { local, db, vault } = await makeVault()
    const t = vault.collection<Row>('txns')
    await t.put('a', { amount: 1, date: '2026-02-01' }); await db.push(V); await t.delete('a'); await db.push(V)
    const m = local.raw(V, 'txns', 'a')!; await local.put(V, 'txns', 'a', { ...m, _ts: '2026-02-15T00:00:00.000Z' })
    await vault.closePeriod({ name: 'FY26-Q1', endDate: '2026-03-31' })
    const first = await vault.freezePeriod('FY26-Q1')
    const companionBefore = local.raw(V, '_period_freezes', 'FY26-Q1')!
    const second = await vault.freezePeriod('FY26-Q1')
    expect(second.frozenAt).toBe(first.frozenAt)                  // same freeze time (no re-write)
    expect(second.purgedMarkerCount).toBe(1)
    expect(local.raw(V, '_period_freezes', 'FY26-Q1')!._data).toBe(companionBefore._data)  // companion unchanged
    db.close()
  })

  it('getPeriod / listPeriods return the merged freeze fields; a frozen period still rejects writes', async () => {
    const { local, db, vault } = await makeVault()
    const t = vault.collection<Row>('txns')
    await t.put('a', { amount: 1, date: '2026-02-01' }); await db.push(V); await t.delete('a'); await db.push(V)
    const m = local.raw(V, 'txns', 'a')!; await local.put(V, 'txns', 'a', { ...m, _ts: '2026-02-15T00:00:00.000Z' })
    await vault.closePeriod({ name: 'FY26-Q1', endDate: '2026-03-31', dateField: 'date' })
    await vault.freezePeriod('FY26-Q1')

    expect((await vault.getPeriod('FY26-Q1'))!.frozenAt).toBeTruthy()
    expect((await vault.listPeriods()).find(p => p.name === 'FY26-Q1')!.purgedMarkerCount).toBe(1)
    await expect(t.put('b', { amount: 2, date: '2026-02-02' })).rejects.toThrow()  // seal intact
    db.close()
  })

  it('the freeze ledger entry is attributed to _period_freezes, not _periods — verifyBackupIntegrity stays ok, re-freeze appends no extra entry (review C1)', async () => {
    const { local, db, vault } = await makeVault()
    const t = vault.collection<Row>('txns')
    await t.put('a', { amount: 1, date: '2026-02-01' }); await db.push(V)
    await t.delete('a'); await db.push(V)
    const m = local.raw(V, 'txns', 'a')!
    await local.put(V, 'txns', 'a', { ...m, _ts: '2026-02-15T00:00:00.000Z' })
    await vault.closePeriod({ name: 'FY26-Q1', endDate: '2026-03-31' })

    // Sanity: clean before freeze.
    expect((await vault.verifyBackupIntegrity()).ok).toBe(true)

    await vault.freezePeriod('FY26-Q1')

    // The freeze's ledger entry must record the _period_freezes companion
    // it actually wrote, not the untouched _periods/<name> chained record.
    const entriesAfterFirstFreeze = await vault.ledger().loadAllEntries()
    const freezeEntry = entriesAfterFirstFreeze[entriesAfterFirstFreeze.length - 1]!
    expect(freezeEntry.collection).toBe('_period_freezes')
    expect(freezeEntry.id).toBe('FY26-Q1')

    // A cross-check on the latest put per (collection, id) must not
    // mistake the freeze entry for a rewrite of _periods/<name> — that
    // would hash-mismatch against the actually-stored (unchanged) close
    // envelope and falsely brick backup/restore.
    const verifyAfterFreeze = await vault.verifyBackupIntegrity()
    expect(verifyAfterFreeze.ok).toBe(true)

    // Idempotent re-freeze: no additional ledger entry.
    await vault.freezePeriod('FY26-Q1')
    const entriesAfterSecondFreeze = await vault.ledger().loadAllEntries()
    expect(entriesAfterSecondFreeze.length).toBe(entriesAfterFirstFreeze.length)

    db.close()
  })
})
