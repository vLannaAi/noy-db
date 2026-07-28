import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { createNoydb } from '../src/kernel/noydb.js'
import { withPeriods } from '../src/with-audit/periods/index.js'
import { withHistory } from '../src/with-commit/history/index.js'
import { routeStore } from '../src/with-store/route-store.js'

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

interface Row { amount: number; date: string }
const V = 'V1'

async function makeVault() {
  const hot = toMemory(), cold = toMemory()
  const db = await createNoydb({
    store: routeStore({ default: hot, age: { cold } }),
    user: 'alice',
    periodsStrategy: withPeriods(),
    historyStrategy: withHistory(),
    secret: 'hunter2',
  })
  const vault = await db.openVault(V)
  return { hot, cold, db, vault }
}

describe('archivePeriod (#613)', () => {
  it('relocates in-window records hot → cold; reads still resolve; count recorded', async () => {
    const { hot, cold, db, vault } = await makeVault()
    const t = vault.collection<Row>('txns')
    await t.put('a', { amount: 1, date: '2026-02-01' })
    // force the record's _ts into the period window (white-box, like period-freeze.test.ts)
    const raw = hot.raw(V, 'txns', 'a')!; await hot.put(V, 'txns', 'a', { ...raw, _ts: '2026-02-15T00:00:00.000Z' })

    await vault.closePeriod({ name: 'FY26-Q1', endDate: '2026-03-31' })
    const archived = await vault.archivePeriod('FY26-Q1')

    expect(archived.archivedRecordCount).toBe(1)
    expect(hot.raw(V, 'txns', 'a')).toBeUndefined()               // gone from hot
    expect(cold.raw(V, 'txns', 'a')).toBeDefined()                // now in cold
    expect((await t.get('a'))?.amount).toBe(1)                    // read-through still resolves
    db.close()
  })

  it('leaves out-of-window records hot and summaries hot', async () => {
    const { hot, db, vault } = await makeVault()
    const t = vault.collection<Row>('txns')
    await t.put('late', { amount: 9, date: '2026-02-01' })         // _ts = now (2026+, after endDate)
    await vault.closePeriod({ name: 'FY26-Q1', endDate: '2026-03-31' })
    await vault.archivePeriod('FY26-Q1')
    expect(hot.raw(V, 'txns', 'late')).toBeDefined()               // late _ts stays hot
    expect(hot.raw(V, '_periods', 'FY26-Q1')).toBeDefined()        // summary stays hot
    db.close()
  })

  it('throws when the store is not a cold-capable routeStore', async () => {
    const db = await createNoydb({ store: toMemory(), user: 'alice', periodsStrategy: withPeriods(), secret: 'hunter2' })
    const vault = await db.openVault(V)
    await vault.closePeriod({ name: 'FY26-Q1', endDate: '2026-03-31' })
    await expect(vault.archivePeriod('FY26-Q1')).rejects.toThrow(/cold archival requires a routeStore/i)
    db.close()
  })

  it('composes with freeze and keeps verifyBackupIntegrity ok (ledger attributed to _period_archives)', async () => {
    const { db, vault } = await makeVault()
    const t = vault.collection<Row>('txns')
    await t.put('a', { amount: 1, date: '2026-02-01' }); await t.delete('a')
    await vault.closePeriod({ name: 'FY26-Q1', endDate: '2026-03-31' })
    await vault.freezePeriod('FY26-Q1')      // purge markers
    await vault.archivePeriod('FY26-Q1')     // relocate records
    const report = await vault.verifyBackupIntegrity()
    expect(report.ok).toBe(true)             // ledger entry attributed to _period_archives, not _periods
    db.close()
  })

  it('is idempotent (second archive: no re-migration, count stable)', async () => {
    const { db, vault } = await makeVault()
    const t = vault.collection<Row>('txns')
    await t.put('a', { amount: 1, date: '2026-02-01' })
    await vault.closePeriod({ name: 'FY26-Q1', endDate: '2026-03-31' })
    const first = await vault.archivePeriod('FY26-Q1')
    const second = await vault.archivePeriod('FY26-Q1')
    expect(second.archivedAt).toBe(first.archivedAt)
    expect(second.archivedRecordCount).toBe(first.archivedRecordCount)
    db.close()
  })

  it('preserves the write-seal: an archived period still rejects writes (#613 spec §6)', async () => {
    const { db, vault } = await makeVault()
    const t = vault.collection<Row>('txns')
    await vault.closePeriod({ name: 'FY26-Q1', endDate: '2026-03-31', dateField: 'date' })
    await vault.archivePeriod('FY26-Q1')
    await expect(t.put('b', { amount: 2, date: '2026-02-02' })).rejects.toThrow()  // seal intact
    db.close()
  })
})
