/**
 * #807 — period-scoped sync pull (thin-client bootstrap).
 *
 * A fresh device pulls the CURRENT period's records + the period summaries
 * (`_periods` + companions — the navigation index) first, and backfills
 * historical periods on demand via `pull({ periods: ['<name>'] })`.
 *
 * Period membership at the sync tier is by envelope write-time `_ts` against
 * the closed periods' windows (`periodExclusiveUpperBound`) — the same
 * store-tier law freeze/archive use, because the engine only ever sees
 * ciphertext envelopes. Delete markers and tombstones are NEVER period-
 * filtered (an erasure or delete must never be skipped by partial sync,
 * mirroring the modifiedSince exemption), which is what makes a
 * never-pulled-then-backfilled period converge instead of resurrecting.
 * Push is NEVER period-filtered — `PushOptions` has no `periods` at all.
 */
import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot, PullOptions } from '../src/kernel/types.js'
import { ConflictError, ValidationError } from '../src/kernel/errors.js'
import { createNoydb } from '../src/kernel/noydb.js'
import { NoydbEventEmitter } from '../src/kernel/events.js'
import { withSync } from '../src/with-party/sync/index.js'
import { withPeriods } from '../src/with-audit/periods/index.js'
import { SyncEngine } from '../src/with-party/team/sync.js'

// ─── Inline memory adapter (mirrors sync-partial.test.ts harness) ──────────

function inlineMemory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function gc(c: string, col: string) {
    let comp = store.get(c); if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col); if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
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

// ─── Seeding helpers (encrypt:false — plaintext `_data`) ────────────────────

const env = (data: object, ts: string, v = 1): EncryptedEnvelope =>
  ({ _noydb: 1, _v: v, _ts: ts, _iv: '', _data: JSON.stringify(data) })

/** #589 ordinary-delete marker (version-ordered, reads as absent). */
const marker = (ts: string, v: number): EncryptedEnvelope =>
  ({ _noydb: 1, _v: v, _ts: ts, _iv: '', _data: '', _del: true })

/** A closed `_periods/<name>` record, as `closePeriod()` persists it. */
const closedPeriod = (name: string, endDate: string, closedAt: string, priorPeriodName?: string): EncryptedEnvelope =>
  env({
    name, kind: 'closed', endDate, closedAt, closedBy: 'server', priorPeriodHash: '',
    ...(priorPeriodName !== undefined ? { priorPeriodName } : {}),
  }, closedAt)

interface Invoice { amount: number; label?: string }

const COMP = 'COMP-PERIOD-SCOPE'

// Timeline: Q1 = (-∞, 2026-04-01); Q2 = [2026-04-01, 2026-07-01); current = [2026-07-01, ∞)
const Q1_TS = '2026-02-10T00:00:00.000Z'
const Q2_TS = '2026-05-10T00:00:00.000Z'
const CUR_TS = '2026-07-10T00:00:00.000Z'

/** Remote seeded with two closed periods + one invoice per window. */
function seedRemote(remote: NoydbStore): Promise<unknown> {
  return Promise.all([
    remote.put(COMP, '_periods', 'Q1', closedPeriod('Q1', '2026-03-31', '2026-04-01T00:00:00.000Z')),
    remote.put(COMP, '_periods', 'Q2', closedPeriod('Q2', '2026-06-30', '2026-07-01T00:00:00.000Z', 'Q1')),
    remote.put(COMP, 'invoices', 'inv-q1', env({ amount: 1 }, Q1_TS)),
    remote.put(COMP, 'invoices', 'inv-q2', env({ amount: 2 }, Q2_TS)),
    remote.put(COMP, 'invoices', 'inv-cur', env({ amount: 3 }, CUR_TS)),
  ])
}

async function thinClient(local: NoydbStore, remote: NoydbStore) {
  return createNoydb({
    store: local, sync: remote, user: 'client', encrypt: false,
    syncStrategy: withSync(), periodsStrategy: withPeriods(),
  })
}

describe('period-scoped pull (#807)', () => {
  describe('bootstrap: pull({ periods: { current: true } })', () => {
    it('pulls current-period records + period summaries only', async () => {
      const local = inlineMemory(); const remote = inlineMemory()
      await seedRemote(remote)

      const db = await thinClient(local, remote)
      await db.openVault(COMP)
      const result = await db.pull(COMP, { periods: { current: true } })

      // current-window record arrives; historical ones don't
      expect(await local.get(COMP, 'invoices', 'inv-cur')).not.toBeNull()
      expect(await local.get(COMP, 'invoices', 'inv-q1')).toBeNull()
      expect(await local.get(COMP, 'invoices', 'inv-q2')).toBeNull()

      // period summaries (the navigation index) always sync
      expect(await local.get(COMP, '_periods', 'Q1')).not.toBeNull()
      expect(await local.get(COMP, '_periods', 'Q2')).not.toBeNull()

      // the pulled summaries are visible as the navigation index
      const vault = await db.openVault(COMP)
      const periods = await vault.listPeriods()
      expect(periods.map((p) => p.name).sort()).toEqual(['Q1', 'Q2'])

      expect(result.errors).toHaveLength(0)
      expect(result.pulled).toBe(3) // 2 summaries + 1 current record
    })

    it('exposes per-phase KPI counters (records + bytes)', async () => {
      const local = inlineMemory(); const remote = inlineMemory()
      await seedRemote(remote)

      const db = await thinClient(local, remote)
      await db.openVault(COMP)
      const result = await db.pull(COMP, { periods: { current: true } })

      expect(result.phases).toBeDefined()
      expect(result.phases!.summaries.records).toBe(2)
      expect(result.phases!.summaries.bytes).toBeGreaterThan(0)
      expect(result.phases!.records.records).toBe(1)
      expect(result.phases!.records.bytes).toBeGreaterThan(0)
    })

    it('an unscoped pull is unchanged (no phases, no period filtering, no summary enumeration)', async () => {
      const local = inlineMemory(); const remote = inlineMemory()
      await seedRemote(remote)

      const db = await thinClient(local, remote)
      await db.openVault(COMP)
      const result = await db.pull(COMP)

      expect(result.phases).toBeUndefined()
      expect(result.pulled).toBe(3) // all three invoices; `_periods` untouched (pre-#807 behavior)
      expect(await local.get(COMP, 'invoices', 'inv-q1')).not.toBeNull()
      expect(await local.get(COMP, '_periods', 'Q1')).toBeNull()
    })

    it('with no closed periods, { current: true } pulls everything (nothing is silently dropped)', async () => {
      const local = inlineMemory(); const remote = inlineMemory()
      // config-style collection written long ago, but NO closed periods anywhere
      await remote.put(COMP, 'config', 'settings', env({ amount: 0 }, '2024-01-01T00:00:00.000Z'))
      await remote.put(COMP, 'invoices', 'inv-cur', env({ amount: 3 }, CUR_TS))

      const db = await thinClient(local, remote)
      await db.openVault(COMP)
      const result = await db.pull(COMP, { periods: { current: true } })

      expect(await local.get(COMP, 'config', 'settings')).not.toBeNull()
      expect(await local.get(COMP, 'invoices', 'inv-cur')).not.toBeNull()
      expect(result.pulled).toBe(2)
    })
  })

  describe('backfill: pull({ periods: [name] })', () => {
    it('fetches exactly one historical period, idempotently', async () => {
      const local = inlineMemory(); const remote = inlineMemory()
      await seedRemote(remote)

      const db = await thinClient(local, remote)
      await db.openVault(COMP)
      await db.pull(COMP, { periods: { current: true } })

      const backfill = await db.pull(COMP, { periods: ['Q1'] })
      expect(await local.get(COMP, 'invoices', 'inv-q1')).not.toBeNull()
      expect(await local.get(COMP, 'invoices', 'inv-q2')).toBeNull() // Q2 still not pulled
      expect(backfill.phases!.records.records).toBe(1)

      // idempotent: a second identical backfill applies nothing
      const again = await db.pull(COMP, { periods: ['Q1'] })
      expect(again.pulled).toBe(0)
      expect(again.phases!.records.records).toBe(0)
    })

    it('deep-link-style late access: data reads normally after backfill', async () => {
      const local = inlineMemory(); const remote = inlineMemory()
      await seedRemote(remote)

      const db = await thinClient(local, remote)
      const vault = await db.openVault(COMP)
      await db.pull(COMP, { periods: { current: true } })

      const invoices = vault.collection<Invoice>('invoices')
      expect(await invoices.get('inv-q2')).toBeNull()

      await db.pull(COMP, { periods: ['Q2'] })
      const rec = await invoices.get('inv-q2')
      expect(rec).not.toBeNull()
      expect((rec as Invoice).amount).toBe(2)
    })

    it('a middle period window is bounded on both sides', async () => {
      const local = inlineMemory(); const remote = inlineMemory()
      await seedRemote(remote)

      const db = await thinClient(local, remote)
      await db.openVault(COMP)
      const result = await db.pull(COMP, { periods: ['Q2'] })

      expect(await local.get(COMP, 'invoices', 'inv-q2')).not.toBeNull()
      expect(await local.get(COMP, 'invoices', 'inv-q1')).toBeNull() // before Q2's window
      expect(await local.get(COMP, 'invoices', 'inv-cur')).toBeNull() // after Q2's window
      expect(result.phases!.records.records).toBe(1)
    })
  })

  describe('composability', () => {
    it('collections filter AND periods filter = intersection (summaries still always pull)', async () => {
      const local = inlineMemory(); const remote = inlineMemory()
      await seedRemote(remote)
      await remote.put(COMP, 'payments', 'pay-q1', env({ amount: 10 }, Q1_TS))
      await remote.put(COMP, 'payments', 'pay-cur', env({ amount: 30 }, CUR_TS))

      const db = await thinClient(local, remote)
      await db.openVault(COMP)
      await db.pull(COMP, { collections: ['invoices'], periods: { current: true } })

      expect(await local.get(COMP, 'invoices', 'inv-cur')).not.toBeNull()
      expect(await local.get(COMP, 'invoices', 'inv-q1')).toBeNull() // wrong period
      expect(await local.get(COMP, 'payments', 'pay-cur')).toBeNull() // wrong collection
      expect(await local.get(COMP, 'payments', 'pay-q1')).toBeNull() // both wrong
      // summaries exempt from BOTH filters
      expect(await local.get(COMP, '_periods', 'Q1')).not.toBeNull()
    })

    it('modifiedSince composes with periods (AND)', async () => {
      const local = inlineMemory(); const remote = inlineMemory()
      await seedRemote(remote)
      await remote.put(COMP, 'invoices', 'inv-cur-old', env({ amount: 4 }, '2026-07-02T00:00:00.000Z'))

      const db = await thinClient(local, remote)
      await db.openVault(COMP)
      await db.pull(COMP, { periods: { current: true }, modifiedSince: '2026-07-05T00:00:00.000Z' })

      expect(await local.get(COMP, 'invoices', 'inv-cur')).not.toBeNull() // current + recent
      expect(await local.get(COMP, 'invoices', 'inv-cur-old')).toBeNull() // current but before cutoff
      expect(await local.get(COMP, 'invoices', 'inv-q1')).toBeNull() // outside window
    })
  })

  describe('push is never period-filtered', () => {
    it('push flows the whole dirty queue while pull is period-scoped', async () => {
      const local = inlineMemory(); const remote = inlineMemory()
      await seedRemote(remote)

      const db = await thinClient(local, remote)
      const vault = await db.openVault(COMP)
      await vault.collection<Invoice>('drafts').put('d-1', { amount: 7 })
      await vault.collection<Invoice>('drafts').put('d-2', { amount: 8 })
      expect(db.syncStatus(COMP).dirty).toBe(2)

      const result = await db.sync(COMP, { pull: { periods: { current: true } } })
      expect(result.push.pushed).toBe(2)
      expect(db.syncStatus(COMP).dirty).toBe(0)
      expect(await remote.get(COMP, 'drafts', 'd-1')).not.toBeNull()
      expect(await remote.get(COMP, 'drafts', 'd-2')).not.toBeNull()
      // and the period-scoped pull still filtered
      expect(await local.get(COMP, 'invoices', 'inv-q1')).toBeNull()
    })
  })

  describe('delete-marker convergence', () => {
    it('bootstrap carries historical delete markers (never period-filtered)', async () => {
      const local = inlineMemory(); const remote = inlineMemory()
      await seedRemote(remote)
      // a record created + deleted inside Q1: only the marker row remains at remote
      await remote.put(COMP, 'invoices', 'inv-deleted', marker(Q1_TS, 2))

      const db = await thinClient(local, remote)
      const vault = await db.openVault(COMP)
      await db.pull(COMP, { periods: { current: true } })

      // the Q1-window marker arrived despite the current-only scope
      const localMarker = await local.get(COMP, 'invoices', 'inv-deleted')
      expect(localMarker).not.toBeNull()
      expect(localMarker!._del).toBe(true)
      expect(await vault.collection<Invoice>('invoices').get('inv-deleted')).toBeNull()
    })

    it('a device that never pulled period P does not resurrect P\'s deleted records on backfill', async () => {
      const local = inlineMemory(); const remote = inlineMemory()
      await seedRemote(remote)
      await remote.put(COMP, 'invoices', 'inv-deleted', marker(Q1_TS, 2))

      const db = await thinClient(local, remote)
      const vault = await db.openVault(COMP)
      await db.pull(COMP, { periods: { current: true } })

      // later: deep link into Q1 → backfill
      await db.pull(COMP, { periods: ['Q1'] })
      expect(await vault.collection<Invoice>('invoices').get('inv-deleted')).toBeNull()
      const localMarker = await local.get(COMP, 'invoices', 'inv-deleted')
      expect(localMarker!._del).toBe(true)
      // live Q1 record did arrive
      expect(await local.get(COMP, 'invoices', 'inv-q1')).not.toBeNull()
    })

    it('tolerates a period whose markers were already purged at the remote (frozen there)', async () => {
      const local = inlineMemory(); const remote = inlineMemory()
      await seedRemote(remote)
      // remote froze Q1: the deleted record's marker row is GONE entirely —
      // backfill simply pulls the surviving live records; nothing resurrects.
      const db = await thinClient(local, remote)
      const vault = await db.openVault(COMP)
      await db.pull(COMP, { periods: { current: true } })

      const result = await db.pull(COMP, { periods: ['Q1'] })
      expect(result.errors).toHaveLength(0)
      expect(await local.get(COMP, 'invoices', 'inv-q1')).not.toBeNull()
      expect(await vault.collection<Invoice>('invoices').get('inv-deleted')).toBeNull()
    })
  })

  describe('end-to-end with a real closePeriod() on the authority device', () => {
    it('a period closed via the vault API scopes a thin client\'s pull', async () => {
      const remote = inlineMemory()
      // authority device writes STRAIGHT to the shared/remote store
      const server = await createNoydb({
        store: remote, user: 'server', encrypt: false, periodsStrategy: withPeriods(),
      })
      const sVault = await server.openVault(COMP)
      await sVault.collection<Invoice>('invoices').put('inv-now', { amount: 42 })
      await sVault.closePeriod({ name: 'HIST', endDate: '2026-03-31' })
      // seed one historical record under the closed window (controlled _ts)
      await remote.put(COMP, 'invoices', 'inv-hist', env({ amount: 1 }, Q1_TS))

      const local = inlineMemory()
      const db = await thinClient(local, remote)
      const vault = await db.openVault(COMP)
      await db.pull(COMP, { periods: { current: true } })

      expect(await local.get(COMP, 'invoices', 'inv-now')).not.toBeNull()
      expect(await local.get(COMP, 'invoices', 'inv-hist')).toBeNull()
      expect((await vault.listPeriods()).map((p) => p.name)).toEqual(['HIST'])

      await db.pull(COMP, { periods: ['HIST'] })
      expect(await local.get(COMP, 'invoices', 'inv-hist')).not.toBeNull()
    })
  })

  describe('#822 — a closure made on a private-store authority PUSHES', () => {
    it('closePeriod marks _periods dirty so push carries the summary to the shared store', async () => {
      // The authority device here does NOT write straight to the shared
      // store: it has its own local store and syncs. Before #822 the
      // closure never left this device, because writeReserved bypasses
      // Collection.put and so never marked the record dirty.
      const remote = inlineMemory()
      const authorityLocal = inlineMemory()
      const authority = await createNoydb({
        store: authorityLocal, sync: remote, user: 'server', encrypt: false,
        syncStrategy: withSync(), periodsStrategy: withPeriods(),
      })
      const aVault = await authority.openVault(COMP)
      await aVault.collection<Invoice>('invoices').put('inv-now', { amount: 42 })
      await aVault.closePeriod({ name: 'HIST', endDate: '2026-03-31' })

      await authority.push(COMP)

      // The summary reached the shared store...
      expect(await remote.get(COMP, '_periods', 'HIST')).not.toBeNull()

      // ...so a second device sees the closure and can scope its pull by it.
      const local = inlineMemory()
      const db = await thinClient(local, remote)
      const vault = await db.openVault(COMP)
      await db.pull(COMP, { periods: { current: true } })
      expect((await vault.listPeriods()).map((p) => p.name)).toEqual(['HIST'])
    })

    it('leaves the other reserved collections device-local', async () => {
      // freezes / archives / target-purges are deliberately NOT pushed —
      // see the writeReserved comment for why each stays put.
      const remote = inlineMemory()
      const authorityLocal = inlineMemory()
      const authority = await createNoydb({
        store: authorityLocal, sync: remote, user: 'server', encrypt: false,
        syncStrategy: withSync(), periodsStrategy: withPeriods(),
      })
      const aVault = await authority.openVault(COMP)
      await aVault.collection<Invoice>('invoices').put('inv-now', { amount: 1 })
      await aVault.closePeriod({ name: 'HIST', endDate: '2026-03-31' })
      await aVault.freezePeriod('HIST')
      await authority.push(COMP)

      expect(await remote.get(COMP, '_periods', 'HIST')).not.toBeNull()
      expect(await remote.get(COMP, '_period_freezes', 'HIST')).toBeNull()
    })
  })

  describe('option validation', () => {
    it('rejects an unknown period name', async () => {
      const local = inlineMemory(); const remote = inlineMemory()
      await seedRemote(remote)
      const db = await thinClient(local, remote)
      await db.openVault(COMP)
      await expect(db.pull(COMP, { periods: ['NOPE'] })).rejects.toThrow(ValidationError)
    })

    it('rejects an opened-kind period name (only closed periods have a backfill window)', async () => {
      const local = inlineMemory(); const remote = inlineMemory()
      await seedRemote(remote)
      await remote.put(COMP, '_periods', 'Q3-open', env({
        name: 'Q3-open', kind: 'opened', startDate: '2026-07-01', endDate: '2026-06-30',
        closedAt: '2026-07-01T00:00:01.000Z', closedBy: 'server', priorPeriodHash: '', priorPeriodName: 'Q2',
      }, '2026-07-01T00:00:01.000Z'))
      const db = await thinClient(local, remote)
      await db.openVault(COMP)
      await expect(db.pull(COMP, { periods: ['Q3-open'] })).rejects.toThrow(ValidationError)
    })

    it('rejects malformed shapes', async () => {
      const local = inlineMemory(); const remote = inlineMemory()
      await seedRemote(remote)
      const db = await thinClient(local, remote)
      await db.openVault(COMP)
      await expect(db.pull(COMP, { periods: { current: false } } as unknown as PullOptions)).rejects.toThrow(ValidationError)
      await expect(db.pull(COMP, { periods: {} } as unknown as PullOptions)).rejects.toThrow(ValidationError)
      await expect(db.pull(COMP, { periods: [42] } as unknown as PullOptions)).rejects.toThrow(ValidationError)
    })

    it('rejects a period-scoped pull when the vault holds _periods records the periods service cannot read', async () => {
      const local = inlineMemory(); const remote = inlineMemory()
      await seedRemote(remote)
      // client WITHOUT withPeriods(): summaries arrive, but no window source
      const db = await createNoydb({
        store: local, sync: remote, user: 'client', encrypt: false, syncStrategy: withSync(),
      })
      await db.openVault(COMP)
      await expect(db.pull(COMP, { periods: { current: true } })).rejects.toThrow(ValidationError)
    })

    it('rejects a period-scoped pull on a non-vault-attached engine', async () => {
      const local = inlineMemory(); const remote = inlineMemory()
      const engine = new SyncEngine({
        local, remote, vault: COMP, strategy: 'version', emitter: new NoydbEventEmitter(),
      })
      await expect(engine.pull({ periods: { current: true } })).rejects.toThrow(ValidationError)
    })

    it('an empty periods array pulls only summaries (and markers)', async () => {
      const local = inlineMemory(); const remote = inlineMemory()
      await seedRemote(remote)
      const db = await thinClient(local, remote)
      await db.openVault(COMP)
      const result = await db.pull(COMP, { periods: [] })
      expect(await local.get(COMP, '_periods', 'Q1')).not.toBeNull()
      expect(await local.get(COMP, 'invoices', 'inv-cur')).toBeNull()
      expect(result.phases!.records.records).toBe(0)
    })
  })
})
