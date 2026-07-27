/**
 * #722 — derived outputs must follow the source's tier. Elevating a source
 * record must remove its contribution from every derived output (MV rows,
 * rollup/aggregate values, derivation outputs) — those output rows live in
 * tier-0 output collections and held the source's tier-0-era plaintext.
 * Reuses the forget-fanout recompute; recompute reads the elevated-excluding
 * cache so it drops the now-invisible source.
 */
import { describe, it, expect, vi } from 'vitest'
import { createNoydb, withMaterializedView, withRollup, withDerivation, ConflictError, type GroupedAggregation } from '../src/index.js'
import { withTiers } from '../src/with-audit/tiers/index.js'
import { withAggregate } from '../src/with-lookup/aggregate/index.js'
import { sum } from '../src/with-lookup/aggregate/reducers.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/index.js'

function memoryStore(): NoydbStore {
  const data = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const getColl = (v: string, c: string): Map<string, EncryptedEnvelope> => {
    let vm = data.get(v); if (!vm) { vm = new Map(); data.set(v, vm) }
    let cm = vm.get(c); if (!cm) { cm = new Map(); vm.set(c, cm) }
    return cm
  }
  return {
    name: 'memory',
    async get(v, c, id) { return data.get(v)?.get(c)?.get(id) ?? null },
    async put(v, c, id, env, ev) {
      const coll = getColl(v, c); const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(v, c, id) { data.get(v)?.get(c)?.delete(id) },
    async list(v, c) { return [...(data.get(v)?.get(c)?.keys() ?? [])] },
    async loadAll(v) {
      const vm = data.get(v); const snap: VaultSnapshot = {}
      if (vm) for (const [cn, cm] of vm) {
        const r: Record<string, EncryptedEnvelope> = {}
        for (const [id, e] of cm) r[id] = e
        snap[cn] = r
      }
      return snap
    },
    async saveAll(v, snap) {
      const vm = new Map<string, Map<string, EncryptedEnvelope>>()
      for (const [cn, recs] of Object.entries(snap)) {
        const cm = new Map<string, EncryptedEnvelope>()
        for (const [id, e] of Object.entries(recs)) cm.set(id, e)
        vm.set(cn, cm)
      }
      data.set(v, vm)
    },
  }
}

describe('#722 elevate removes the source from derived outputs', () => {
  it('record-grain MV: the elevated source’s output row vanishes; the output collection holds no source plaintext', async () => {
    interface Invoice extends Record<string, unknown> { id: string; clientId: string; amount: number; status: 'open' | 'paid' }
    const openInvoicesMV = withMaterializedView<Invoice>({
      name: 'open-invoices',
      // The MV's query callback runs at REGISTRATION time (inside
      // `openVault`) and its `db.collection(name)` call is what FIRST
      // constructs + caches the source collection — a later
      // `vault.collection('invoices', { tiers: ... })` call is a no-op
      // (first-construction wins). So the tiered options must be supplied
      // HERE, on this first construction; the untyped call below is
      // side-effect-only (cache warm), the typed call just re-reads it.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      query: (db) => { (db as any).collection('invoices', { tiers: [0, 1], perRecordKeys: true }); return db.collection<Invoice>('invoices').query().where('status', '==', 'open') },
      rowKey: (r) => r.id,
      refresh: 'eager',
    })
    const db = await createNoydb({
      store: memoryStore(),
      user: 'owner',
      secret: 'tiers-derived-mv-secret-2026',
      tiersStrategy: withTiers(),
      materializedViewStrategies: [openInvoicesMV],
    })
    const vault = await db.openVault('demo')
    const invoices = vault.collection<Invoice>('invoices', { tiers: [0, 1], perRecordKeys: true })
    const openMV = vault.collection<Invoice>('open-invoices')

    await invoices.put('inv-a', { id: 'inv-a', clientId: 'acme', amount: 100, status: 'open' })
    await invoices.put('inv-b', { id: 'inv-b', clientId: 'acme', amount: 50, status: 'open' })

    expect((await openMV.get('inv-a'))?.amount).toBe(100)
    expect((await openMV.get('inv-b'))?.amount).toBe(50)

    await invoices.elevate('inv-a', 1)

    expect(await openMV.get('inv-a')).toBeNull()
    expect((await openMV.get('inv-b'))?.amount).toBe(50)

    // No source plaintext remains — the output row itself is gone.
    const store = (db as unknown as { options: { store: NoydbStore } }).options.store
    expect(await store.get('demo', 'open-invoices', 'inv-a')).toBeNull()
  })

  it('aggregate MV: elevating a contributor drops it from the group aggregate', async () => {
    interface Compensation extends Record<string, unknown> { id: string; clientId: string; taxAmount: number }
    interface ClientTotalRow extends Record<string, unknown> { clientId: string; taxTotal: number }
    const mv = withMaterializedView<ClientTotalRow>({
      name: 'client-totals',
      sources: ['compensations'],
      // See the record-grain MV test above: tiered options must be supplied
      // on the FIRST `collection()` call the query callback makes (which
      // happens at registration time, before the test can reach it).
      query: (db) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(db as any).collection('compensations', { tiers: [0, 1], perRecordKeys: true })
        return db.collection<Compensation>('compensations')
          .query()
          .groupBy('clientId')
          .aggregate({ taxTotal: sum('taxAmount') }) as GroupedAggregation<ClientTotalRow>
      },
      rowKey: (r) => r.clientId,
      refresh: 'eager',
    })
    const db = await createNoydb({
      store: memoryStore(),
      user: 'owner',
      secret: 'tiers-derived-aggregate-secret-2026',
      tiersStrategy: withTiers(),
      aggregateStrategy: withAggregate(),
      materializedViewStrategies: [mv],
    })
    const vault = await db.openVault('demo')
    const compensations = vault.collection<Compensation>('compensations', { tiers: [0, 1], perRecordKeys: true })
    const totals = vault.collection<ClientTotalRow>('client-totals')

    await compensations.put('c1', { id: 'c1', clientId: 'acme', taxAmount: 100 })
    await compensations.put('c2', { id: 'c2', clientId: 'acme', taxAmount: 50 })
    expect((await totals.get('acme'))?.taxTotal).toBe(150)

    await compensations.elevate('c1', 1)

    // The aggregate drops the elevated contributor's amount (owner-accepted
    // inference channel — see the arc's design doc).
    expect((await totals.get('acme'))?.taxTotal).toBe(50)
  })

  it('rollup: elevating a child drops its contribution from the parent rollup field', async () => {
    interface Buyer extends Record<string, unknown> { id: string; companyName: string; totalSpent?: number }
    interface Sale extends Record<string, unknown> { id: string; buyerId: string; total: number }
    const totalSpentRollup = withRollup<Sale, Buyer>({
      from: 'sales', key: 'buyerId', into: 'buyers', field: 'totalSpent',
      compute: (sales) => sales.reduce((t, s) => t + s.total, 0),
    })
    const db = await createNoydb({
      store: memoryStore(),
      user: 'owner',
      secret: 'tiers-derived-rollup-secret-2026',
      tiersStrategy: withTiers(),
      derivationStrategies: [totalSpentRollup],
    })
    const vault = await db.openVault('firm')
    const buyers = vault.collection<Buyer>('buyers')
    const sales = vault.collection<Sale>('sales', { tiers: [0, 1], perRecordKeys: true })

    await buyers.put('b1', { id: 'b1', companyName: 'Acme' })
    await sales.put('s1', { id: 's1', buyerId: 'b1', total: 100 })
    await sales.put('s2', { id: 's2', buyerId: 'b1', total: 200 })
    expect((await buyers.get('b1'))?.totalSpent).toBe(300)

    await sales.elevate('s1', 1)

    expect((await buyers.get('b1'))?.totalSpent).toBe(200)
  })

  it('record/array withDerivation: the elevated source’s derived output is removed', async () => {
    interface Worker extends Record<string, unknown> { id: string; clientId: string; period: string; baseSalary: number }
    interface ActivePeriod extends Record<string, unknown> { id: string; workerId: string; period: string }
    const strategy = withDerivation<Worker, { activeInPeriod: ActivePeriod[] }>({
      source: 'workers',
      deterministic: true,
      outputs: {
        activeInPeriod: {
          shape: 'array',
          collection: 'workerActiveInPeriod',
          key: (o) => `${o.workerId as string}|${o.period as string}`,
        },
      },
      derive: (worker) => ({
        activeInPeriod: [{ id: `${worker.id}|${worker.period}`, workerId: worker.id, period: worker.period }],
      }),
      lifecycle: 'eager',
    })
    const db = await createNoydb({
      store: memoryStore(),
      user: 'owner',
      secret: 'tiers-derived-array-secret-2026',
      tiersStrategy: withTiers(),
      derivationStrategies: [strategy],
    })
    const vault = await db.openVault('acme')
    const workers = vault.collection<Worker>('workers', { tiers: [0, 1], perRecordKeys: true })
    const activePeriods = vault.collection<ActivePeriod>('workerActiveInPeriod')

    await workers.put('w1', { id: 'w1', clientId: 'cl-A', period: '2026-03', baseSalary: 30000 })
    expect(await activePeriods.get('w1|2026-03')).not.toBeNull()

    await workers.elevate('w1', 1)

    expect(await activePeriods.get('w1|2026-03')).toBeNull()
  })

  it('a sibling non-elevated source’s derived outputs are untouched', async () => {
    interface Buyer extends Record<string, unknown> { id: string; companyName: string; totalSpent?: number }
    interface Sale extends Record<string, unknown> { id: string; buyerId: string; total: number }
    const totalSpentRollup = withRollup<Sale, Buyer>({
      from: 'sales', key: 'buyerId', into: 'buyers', field: 'totalSpent',
      compute: (sales) => sales.reduce((t, s) => t + s.total, 0),
    })
    const db = await createNoydb({
      store: memoryStore(),
      user: 'owner',
      secret: 'tiers-derived-sibling-secret-2026',
      tiersStrategy: withTiers(),
      derivationStrategies: [totalSpentRollup],
    })
    const vault = await db.openVault('firm')
    const buyers = vault.collection<Buyer>('buyers')
    const sales = vault.collection<Sale>('sales', { tiers: [0, 1], perRecordKeys: true })

    await buyers.put('b1', { id: 'b1', companyName: 'Acme' })
    await buyers.put('b2', { id: 'b2', companyName: 'Beta' })
    await sales.put('s1', { id: 's1', buyerId: 'b1', total: 100 })
    await sales.put('s2', { id: 's2', buyerId: 'b2', total: 75 })

    await sales.elevate('s1', 1)

    expect((await buyers.get('b1'))?.totalSpent).toBe(0)
    expect((await buyers.get('b2'))?.totalSpent).toBe(75) // sibling untouched
  })

  it('a collection with NO derivations is unaffected (syncDerived is a fast no-op)', async () => {
    interface Doc extends Record<string, unknown> { id: string; title: string }
    const db = await createNoydb({
      store: memoryStore(),
      user: 'owner',
      secret: 'tiers-derived-noop-secret-2026',
      tiersStrategy: withTiers(),
    })
    const vault = await db.openVault('demo')
    const docs = vault.collection<Doc>('docs', { tiers: [0, 1], perRecordKeys: true })

    await docs.put('d1', { id: 'd1', title: 'Public' })

    await expect(docs.elevate('d1', 1)).resolves.toEqual({ searchResidue: false })
    expect(await docs.getAtTier('d1')).toEqual({ id: 'd1', title: 'Public' })
  })
})

/**
 * #722 Task 2 — demote (and putAtTier(0)) must RESTORE what elevate removed:
 * the source's plaintext survives the elevate/demote rewrap round-trip, so
 * its contribution can be re-added to every derived output. Reuses the
 * ordinary local-write add-dispatchers (`dispatchDerivations`/
 * `dispatchMaterializedViews`) — the same ones a plain `put()` fires.
 */
describe('#722 demote restores the source to derived outputs (reversible)', () => {
  it('record-grain MV: demote re-creates the output row', async () => {
    interface Invoice extends Record<string, unknown> { id: string; clientId: string; amount: number; status: 'open' | 'paid' }
    const openInvoicesMV = withMaterializedView<Invoice>({
      name: 'open-invoices',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      query: (db) => { (db as any).collection('invoices', { tiers: [0, 1], perRecordKeys: true }); return db.collection<Invoice>('invoices').query().where('status', '==', 'open') },
      rowKey: (r) => r.id,
      refresh: 'eager',
    })
    const db = await createNoydb({
      store: memoryStore(),
      user: 'owner',
      secret: 'tiers-derived-mv-demote-secret-2026',
      tiersStrategy: withTiers(),
      materializedViewStrategies: [openInvoicesMV],
    })
    const vault = await db.openVault('demo')
    const invoices = vault.collection<Invoice>('invoices', { tiers: [0, 1], perRecordKeys: true })
    const openMV = vault.collection<Invoice>('open-invoices')

    await invoices.put('inv-a', { id: 'inv-a', clientId: 'acme', amount: 100, status: 'open' })
    await invoices.elevate('inv-a', 1)
    expect(await openMV.get('inv-a')).toBeNull()

    await invoices.demote('inv-a', 0)

    expect((await openMV.get('inv-a'))?.amount).toBe(100)
    expect((await openMV.get('inv-a'))?.status).toBe('open')
  })

  it('aggregate MV: demote restores the contribution to the group aggregate', async () => {
    interface Compensation extends Record<string, unknown> { id: string; clientId: string; taxAmount: number }
    interface ClientTotalRow extends Record<string, unknown> { clientId: string; taxTotal: number }
    const mv = withMaterializedView<ClientTotalRow>({
      name: 'client-totals',
      sources: ['compensations'],
      query: (db) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(db as any).collection('compensations', { tiers: [0, 1], perRecordKeys: true })
        return db.collection<Compensation>('compensations')
          .query()
          .groupBy('clientId')
          .aggregate({ taxTotal: sum('taxAmount') }) as GroupedAggregation<ClientTotalRow>
      },
      rowKey: (r) => r.clientId,
      refresh: 'eager',
    })
    const db = await createNoydb({
      store: memoryStore(),
      user: 'owner',
      secret: 'tiers-derived-aggregate-demote-secret-2026',
      tiersStrategy: withTiers(),
      aggregateStrategy: withAggregate(),
      materializedViewStrategies: [mv],
    })
    const vault = await db.openVault('demo')
    const compensations = vault.collection<Compensation>('compensations', { tiers: [0, 1], perRecordKeys: true })
    const totals = vault.collection<ClientTotalRow>('client-totals')

    await compensations.put('c1', { id: 'c1', clientId: 'acme', taxAmount: 100 })
    await compensations.put('c2', { id: 'c2', clientId: 'acme', taxAmount: 50 })
    await compensations.elevate('c1', 1)
    expect((await totals.get('acme'))?.taxTotal).toBe(50)

    await compensations.demote('c1', 0)

    expect((await totals.get('acme'))?.taxTotal).toBe(150)
  })

  it('rollup + derivation: demote restores the contribution/output', async () => {
    interface Buyer extends Record<string, unknown> { id: string; companyName: string; totalSpent?: number }
    interface Sale extends Record<string, unknown> { id: string; buyerId: string; total: number }
    const totalSpentRollup = withRollup<Sale, Buyer>({
      from: 'sales', key: 'buyerId', into: 'buyers', field: 'totalSpent',
      compute: (sales) => sales.reduce((t, s) => t + s.total, 0),
    })
    const rollupDb = await createNoydb({
      store: memoryStore(),
      user: 'owner',
      secret: 'tiers-derived-rollup-demote-secret-2026',
      tiersStrategy: withTiers(),
      derivationStrategies: [totalSpentRollup],
    })
    const rollupVault = await rollupDb.openVault('firm')
    const buyers = rollupVault.collection<Buyer>('buyers')
    const sales = rollupVault.collection<Sale>('sales', { tiers: [0, 1], perRecordKeys: true })

    await buyers.put('b1', { id: 'b1', companyName: 'Acme' })
    await sales.put('s1', { id: 's1', buyerId: 'b1', total: 100 })
    await sales.put('s2', { id: 's2', buyerId: 'b1', total: 200 })
    await sales.elevate('s1', 1)
    expect((await buyers.get('b1'))?.totalSpent).toBe(200)

    await sales.demote('s1', 0)

    expect((await buyers.get('b1'))?.totalSpent).toBe(300)

    interface Worker extends Record<string, unknown> { id: string; clientId: string; period: string; baseSalary: number }
    interface ActivePeriod extends Record<string, unknown> { id: string; workerId: string; period: string }
    const derivationStrategy = withDerivation<Worker, { activeInPeriod: ActivePeriod[] }>({
      source: 'workers',
      deterministic: true,
      outputs: {
        activeInPeriod: {
          shape: 'array',
          collection: 'workerActiveInPeriod',
          key: (o) => `${o.workerId as string}|${o.period as string}`,
        },
      },
      derive: (worker) => ({
        activeInPeriod: [{ id: `${worker.id}|${worker.period}`, workerId: worker.id, period: worker.period }],
      }),
      lifecycle: 'eager',
    })
    const derivationDb = await createNoydb({
      store: memoryStore(),
      user: 'owner',
      secret: 'tiers-derived-array-demote-secret-2026',
      tiersStrategy: withTiers(),
      derivationStrategies: [derivationStrategy],
    })
    const derivationVault = await derivationDb.openVault('acme')
    const workers = derivationVault.collection<Worker>('workers', { tiers: [0, 1], perRecordKeys: true })
    const activePeriods = derivationVault.collection<ActivePeriod>('workerActiveInPeriod')

    await workers.put('w1', { id: 'w1', clientId: 'cl-A', period: '2026-03', baseSalary: 30000 })
    await workers.elevate('w1', 1)
    expect(await activePeriods.get('w1|2026-03')).toBeNull()

    await workers.demote('w1', 0)

    expect(await activePeriods.get('w1|2026-03')).not.toBeNull()
  })

  it('putAtTier(0) over an elevated record restores its derived outputs', async () => {
    interface Buyer extends Record<string, unknown> { id: string; companyName: string; totalSpent?: number }
    interface Sale extends Record<string, unknown> { id: string; buyerId: string; total: number }
    const totalSpentRollup = withRollup<Sale, Buyer>({
      from: 'sales', key: 'buyerId', into: 'buyers', field: 'totalSpent',
      compute: (sales) => sales.reduce((t, s) => t + s.total, 0),
    })
    const db = await createNoydb({
      store: memoryStore(),
      user: 'owner',
      secret: 'tiers-derived-putattier0-secret-2026',
      tiersStrategy: withTiers(),
      derivationStrategies: [totalSpentRollup],
    })
    const vault = await db.openVault('firm')
    const buyers = vault.collection<Buyer>('buyers')
    const sales = vault.collection<Sale>('sales', { tiers: [0, 1], perRecordKeys: true })

    await buyers.put('b1', { id: 'b1', companyName: 'Acme' })
    await sales.put('s1', { id: 's1', buyerId: 'b1', total: 100 })
    await sales.put('s2', { id: 's2', buyerId: 'b1', total: 200 })
    await sales.elevate('s1', 1)
    expect((await buyers.get('b1'))?.totalSpent).toBe(200)

    await sales.putAtTier('s1', { id: 's1', buyerId: 'b1', total: 100 }, 0)

    expect((await buyers.get('b1'))?.totalSpent).toBe(300)
  })

  it('elevate → demote → elevate round-trips cleanly (outputs match the current tier each time)', async () => {
    interface Invoice extends Record<string, unknown> { id: string; clientId: string; amount: number; status: 'open' | 'paid' }
    const openInvoicesMV = withMaterializedView<Invoice>({
      name: 'open-invoices',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      query: (db) => { (db as any).collection('invoices', { tiers: [0, 1], perRecordKeys: true }); return db.collection<Invoice>('invoices').query().where('status', '==', 'open') },
      rowKey: (r) => r.id,
      refresh: 'eager',
    })
    const db = await createNoydb({
      store: memoryStore(),
      user: 'owner',
      secret: 'tiers-derived-roundtrip-secret-2026',
      tiersStrategy: withTiers(),
      materializedViewStrategies: [openInvoicesMV],
    })
    const vault = await db.openVault('demo')
    const invoices = vault.collection<Invoice>('invoices', { tiers: [0, 1], perRecordKeys: true })
    const openMV = vault.collection<Invoice>('open-invoices')

    await invoices.put('inv-a', { id: 'inv-a', clientId: 'acme', amount: 100, status: 'open' })
    expect((await openMV.get('inv-a'))?.amount).toBe(100)

    await invoices.elevate('inv-a', 1)
    expect(await openMV.get('inv-a')).toBeNull()

    await invoices.demote('inv-a', 0)
    expect((await openMV.get('inv-a'))?.amount).toBe(100)

    await invoices.elevate('inv-a', 1)
    expect(await openMV.get('inv-a')).toBeNull()
  })
})

/**
 * Review finding (Arc 9, #722): the tier ops decoded the record body to feed
 * `syncDerived` UNCONDITIONALLY, even for collections with no MV/derivation
 * source attached — the dispatchers self-guard, but only AFTER the expensive
 * `decryptRecord` already ran. `elevate()` never decrypted the body before
 * this arc (it only re-keyed the ciphertext). Fixed by gating the pre-move
 * decode behind `TiersContext.hasDerivedOutputs`. This locks the guard by
 * counting the underlying `crypto.subtle.decrypt` calls a rewrap makes:
 * `rewrapBodyToDek` always makes exactly one (the body re-key, required
 * regardless of derivations); a collection WITH a derivation/MV source makes
 * exactly one MORE (the gated `syncDerived` decode) — a collection with NONE
 * must not.
 */
describe('#722 review fix: syncDerived pre-move decode is gated by hasDerivedOutputs', () => {
  it('elevate() on a vault with NO derivation/MV registries performs zero extra record-body decrypts vs an otherwise-identical elevate on a vault WITH one', async () => {
    interface Doc extends Record<string, unknown> { id: string; title: string }
    interface Buyer extends Record<string, unknown> { id: string; companyName: string; totalSpent?: number }
    interface Sale extends Record<string, unknown> { id: string; buyerId: string; total: number }

    // `hasDerivedOutputs` is computed per-collection from whether THIS
    // collection is itself a registered source (`registry.strategiesForSource(this.name)`
    // / `registry.mvsForSource(this.name)`, #737 — source-grained, was
    // vault-grained), not from whether the vault has any derivation/MV
    // registry configured at all — so the two elevates must run against two
    // SEPARATE vaults (one with no derivation strategy configured at all,
    // one with) to observe the gate.
    const plainDb = await createNoydb({
      store: memoryStore(),
      user: 'owner',
      secret: 'tiers-derived-decode-guard-plain-secret-2026',
      tiersStrategy: withTiers(),
    })
    const plainVault = await plainDb.openVault('demo')
    const docs = plainVault.collection<Doc>('docs', { tiers: [0, 1], perRecordKeys: true })

    const totalSpentRollup = withRollup<Sale, Buyer>({
      from: 'sales', key: 'buyerId', into: 'buyers', field: 'totalSpent',
      compute: (sales) => sales.reduce((t, s) => t + s.total, 0),
    })
    const derivedDb = await createNoydb({
      store: memoryStore(),
      user: 'owner',
      secret: 'tiers-derived-decode-guard-derived-secret-2026',
      tiersStrategy: withTiers(),
      derivationStrategies: [totalSpentRollup],
    })
    const derivedVault = await derivedDb.openVault('demo')
    const buyers = derivedVault.collection<Buyer>('buyers')
    // Same shape as `docs` (tiered, per-record-key) so its elevate() rewrap
    // makes the SAME one decrypt call as `docs`'s, plus the gated decode.
    const sales = derivedVault.collection<Sale>('sales', { tiers: [0, 1], perRecordKeys: true })

    await docs.put('d1', { id: 'd1', title: 'Public' })
    await buyers.put('b1', { id: 'b1', companyName: 'Acme' })
    await sales.put('s1', { id: 's1', buyerId: 'b1', total: 100 })

    const decryptSpy = vi.spyOn(crypto.subtle, 'decrypt')

    const before1 = decryptSpy.mock.calls.length
    await docs.elevate('d1', 1)
    const noDerivationDecryptCalls = decryptSpy.mock.calls.length - before1

    const before2 = decryptSpy.mock.calls.length
    await sales.elevate('s1', 1)
    const withDerivationDecryptCalls = decryptSpy.mock.calls.length - before2

    decryptSpy.mockRestore()

    // Both elevates perform the identical body rewrap (one decrypt). `sales`
    // (its vault has a derivation registry) additionally pays the
    // syncDerived pre-move decode; `docs` (its vault has none) must not —
    // this is the whole point of the `hasDerivedOutputs` gate.
    expect(noDerivationDecryptCalls).toBeGreaterThan(0) // sanity: the rewrap itself still decrypts
    expect(withDerivationDecryptCalls - noDerivationDecryptCalls).toBe(1)

    // Behavior is unchanged either way: both moves still land at tier 1 and
    // the rollup on the derivation-vault side still reflects the removal.
    expect(await docs.getAtTier('d1')).toEqual({ id: 'd1', title: 'Public' })
    expect((await buyers.get('b1'))?.totalSpent).toBe(0)
  })
})

/**
 * Whole-branch review (Arc 9, #722): the pre-move decode the three tier ops
 * added to feed `syncDerived`'s remove path (`ctx.codec.decryptRecord(...,
 * { sealedAsHandles: true })`) is TIER-UNAWARE — it resolves the CEK via the
 * cekCache or falls back to `ctx.codec`'s DEFAULT (tier-0/collection) DEK,
 * never `envelope._tier`. That only "works" when the SAME op's own
 * `rewrapBodyToDek` call already primed the cekCache with THIS record's CEK
 * (the ordinary put()-then-elevate(0→1) shape every existing test uses). A
 * `putAtTier`-origin record (body encrypted directly under its tier DEK, no
 * `_cek` ever minted) or a non-`perRecordKeys` collection has nothing to
 * prime the cache with, and a from-tier>0 read throws `TamperedError`
 * instead of a `TierNotGrantedError`/similar expected failure — a CRITICAL
 * regression: the throw lands AFTER `adapter.put`, so the tier move itself
 * already landed (half-applied op).
 */
describe('#722 whole-branch review: pre-move decode must be tier-aware (not just cekCache-primed)', () => {
  it('putAtTier-origin record: elevate() from a from-tier>0 read does not throw (no _cek was ever minted to prime the cache)', async () => {
    interface Buyer extends Record<string, unknown> { id: string; companyName: string; totalSpent?: number }
    interface Sale extends Record<string, unknown> { id: string; buyerId: string; total: number }
    const totalSpentRollup = withRollup<Sale, Buyer>({
      from: 'sales', key: 'buyerId', into: 'buyers', field: 'totalSpent',
      compute: (sales) => sales.reduce((t, s) => t + s.total, 0),
    })
    const db = await createNoydb({
      store: memoryStore(),
      user: 'owner',
      secret: 'tiers-review-putattier-elevate-secret-2026',
      tiersStrategy: withTiers(),
      derivationStrategies: [totalSpentRollup],
    })
    const vault = await db.openVault('firm')
    const buyers = vault.collection<Buyer>('buyers')
    const sales = vault.collection<Sale>('sales', { tiers: [0, 1, 2], perRecordKeys: true })

    await buyers.put('b1', { id: 'b1', companyName: 'Acme' })
    await sales.put('s2', { id: 's2', buyerId: 'b1', total: 200 })
    // s1 is born directly at tier 1 — putAtTier mints no `_cek`, so nothing
    // primes the cekCache for the elevate() below.
    await sales.putAtTier('s1', { id: 's1', buyerId: 'b1', total: 100 }, 1)
    expect((await buyers.get('b1'))?.totalSpent).toBe(200) // s1 never contributed (born above tier 0)

    await expect(sales.elevate('s1', 2)).resolves.toEqual({ searchResidue: false })

    // s1 stays excluded — no crash, no double-count, no corruption of the
    // sibling's contribution.
    expect((await buyers.get('b1'))?.totalSpent).toBe(200)
  })

  it('non-perRecordKeys collection: elevate() from a from-tier>0 read does not throw (no `_cek` exists at all)', async () => {
    interface Buyer extends Record<string, unknown> { id: string; companyName: string; totalSpent?: number }
    interface Sale extends Record<string, unknown> { id: string; buyerId: string; total: number }
    const totalSpentRollup = withRollup<Sale, Buyer>({
      from: 'sales', key: 'buyerId', into: 'buyers', field: 'totalSpent',
      compute: (sales) => sales.reduce((t, s) => t + s.total, 0),
    })
    const db = await createNoydb({
      store: memoryStore(),
      user: 'owner',
      secret: 'tiers-review-nonperrecord-elevate-secret-2026',
      tiersStrategy: withTiers(),
      derivationStrategies: [totalSpentRollup],
    })
    const vault = await db.openVault('firm')
    const buyers = vault.collection<Buyer>('buyers')
    // NON-perRecordKeys: body always decrypts directly under the tier DEK,
    // never a per-record CEK.
    const sales = vault.collection<Sale>('sales', { tiers: [0, 1, 2] })

    await buyers.put('b1', { id: 'b1', companyName: 'Acme' })
    await sales.put('s2', { id: 's2', buyerId: 'b1', total: 200 })
    await sales.putAtTier('s1', { id: 's1', buyerId: 'b1', total: 100 }, 1)
    expect((await buyers.get('b1'))?.totalSpent).toBe(200)

    await expect(sales.elevate('s1', 2)).resolves.toEqual({ searchResidue: false })

    expect((await buyers.get('b1'))?.totalSpent).toBe(200)
  })

  it('putAtTier over an existing tier-1 record does not throw', async () => {
    interface Buyer extends Record<string, unknown> { id: string; companyName: string; totalSpent?: number }
    interface Sale extends Record<string, unknown> { id: string; buyerId: string; total: number }
    const totalSpentRollup = withRollup<Sale, Buyer>({
      from: 'sales', key: 'buyerId', into: 'buyers', field: 'totalSpent',
      compute: (sales) => sales.reduce((t, s) => t + s.total, 0),
    })
    const db = await createNoydb({
      store: memoryStore(),
      user: 'owner',
      secret: 'tiers-review-putattier-over-existing-secret-2026',
      tiersStrategy: withTiers(),
      derivationStrategies: [totalSpentRollup],
    })
    const vault = await db.openVault('firm')
    const buyers = vault.collection<Buyer>('buyers')
    const sales = vault.collection<Sale>('sales', { tiers: [0, 1, 2], perRecordKeys: true })

    await buyers.put('b1', { id: 'b1', companyName: 'Acme' })
    await sales.put('s2', { id: 's2', buyerId: 'b1', total: 200 })
    // Establish s1 at tier 1 directly (no `_cek`).
    await sales.putAtTier('s1', { id: 's1', buyerId: 'b1', total: 100 }, 1)
    expect((await buyers.get('b1'))?.totalSpent).toBe(200)

    // putAtTier's OWN pre-write decode of the pre-existing tier-1 envelope
    // is the buggy site under test here.
    await expect(sales.putAtTier('s1', { id: 's1', buyerId: 'b1', total: 150 }, 2)).resolves.toEqual({ searchResidue: false })

    expect((await buyers.get('b1'))?.totalSpent).toBe(200)
  })

  it('demote() to an intermediate tier > 0 does not throw', async () => {
    interface Buyer extends Record<string, unknown> { id: string; companyName: string; totalSpent?: number }
    interface Sale extends Record<string, unknown> { id: string; buyerId: string; total: number }
    const totalSpentRollup = withRollup<Sale, Buyer>({
      from: 'sales', key: 'buyerId', into: 'buyers', field: 'totalSpent',
      compute: (sales) => sales.reduce((t, s) => t + s.total, 0),
    })
    const db = await createNoydb({
      store: memoryStore(),
      user: 'owner',
      secret: 'tiers-review-demote-intermediate-secret-2026',
      tiersStrategy: withTiers(),
      derivationStrategies: [totalSpentRollup],
    })
    const vault = await db.openVault('firm')
    const buyers = vault.collection<Buyer>('buyers')
    // NON-perRecordKeys, so the record's body carries no `_cek` at any tier.
    const sales = vault.collection<Sale>('sales', { tiers: [0, 1, 2] })

    await buyers.put('b1', { id: 'b1', companyName: 'Acme' })
    await sales.put('s2', { id: 's2', buyerId: 'b1', total: 200 })
    // Born directly at tier 2 (first write — no pre-write decode needed here).
    await sales.putAtTier('s1', { id: 's1', buyerId: 'b1', total: 100 }, 2)
    expect((await buyers.get('b1'))?.totalSpent).toBe(200)

    // demote() to an INTERMEDIATE tier (still > 0) is the buggy site: it
    // must decrypt the fromTier(=2) envelope, not the collection's
    // default (tier-0) DEK.
    await expect(sales.demote('s1', 1)).resolves.toEqual({ searchResidue: false })

    // s1 stays elevated (tier 1 > 0) — still excluded from the rollup.
    expect((await buyers.get('b1'))?.totalSpent).toBe(200)
  })
})

/**
 * #737 — `hasDerivedOutputs` (`with-audit/tiers/index.ts`'s `TiersContext`
 * field, bound in `collection.ts`'s `tiersContext()`) was VAULT-grained
 * (`materializedViewSource !== undefined || derivationSource !== undefined`):
 * a tiered collection with NO derivations of its OWN still paid the pre-move
 * decode on every tier op whenever ANY derivation existed anywhere in the
 * vault. Fixed to be SOURCE-grained: gate on whether THIS collection is a
 * registered MV source (`registry.mvsForSource(this.name)`) or derivation
 * source (`registry.strategiesForSource(this.name)`).
 *
 * Observable: `putAtTier(id, record, tier>0)`'s pre-write `existing`-decode
 * is the one site where the gated decode is decoupled from an unconditional
 * decrypt of the SAME ciphertext elsewhere in the op — the write re-encrypts
 * the CALLER-supplied plaintext `record`, never `existing`'s stored body, so
 * `existing` is decoded ONLY to feed `syncDerived`, exactly when
 * `hasDerivedOutputs` says to. (`elevate()`/`demote()` can't be used for
 * this: their OWN body rewrap — `rewrapBodyToDek` — unconditionally decrypts
 * the very same pre-move ciphertext the gated decode would, so a corrupted
 * body throws `TamperedError` from the rewrap regardless of the gate — see
 * the "Both elevates perform the identical body rewrap" comment above.)
 * Corrupting `existing`'s stored `_data` therefore isolates the gate: with
 * today's vault-grained gate, a derivation-free collection A still decodes
 * (because SOME OTHER collection in the vault has a derivation) and throws;
 * source-grained, A has no registered derivation of its own and skips the
 * decode entirely, so the corrupted body never gets read.
 */
describe('#737 hasDerivedOutputs is source-grained', () => {
  it('putAtTier(tier>0) on a derivation-free collection succeeds even when its stored body is corrupted, despite another collection in the same vault having a derivation', async () => {
    interface Buyer extends Record<string, unknown> { id: string; companyName: string; totalSpent?: number }
    interface Sale extends Record<string, unknown> { id: string; buyerId: string; total: number }
    interface Doc extends Record<string, unknown> { id: string; title: string }
    const totalSpentRollup = withRollup<Sale, Buyer>({
      from: 'sales', key: 'buyerId', into: 'buyers', field: 'totalSpent',
      compute: (sales) => sales.reduce((t, s) => t + s.total, 0),
    })
    const store = memoryStore()
    const db = await createNoydb({
      store,
      user: 'owner',
      secret: 'source-grained-derived-outputs-secret-2026',
      tiersStrategy: withTiers(),
      // The rollup's `spec.source` (parent) is 'buyers' and its
      // `spec.rollup.from` (child/trigger) is 'sales' — 'docs' below is
      // neither, nor an extra source, nor a trigger, so it is NOT a
      // registered derivation source. Under the old vault-grained gate,
      // `docs` still paid the pre-move decode solely because THIS vault has
      // a derivation registered (on a different collection).
      derivationStrategies: [totalSpentRollup],
    })
    const vault = await db.openVault('demo')
    const docs = vault.collection<Doc>('docs', { tiers: [0, 1], perRecordKeys: true })

    await docs.put('d1', { id: 'd1', title: 'Public' })

    // Corrupt the STORED envelope's ciphertext body — any decode of it
    // throws `TamperedError`. `putAtTier`'s write re-encrypts the fresh
    // plaintext argument below, never this stored body — the corruption is
    // only reachable through the gated `existing`-decode.
    const stored = await store.get('demo', 'docs', 'd1')
    expect(stored).not.toBeNull()
    const goodChar = stored!._data[0]
    const badChar = goodChar === 'A' ? 'B' : 'A'
    await store.put('demo', 'docs', 'd1', { ...stored!, _data: badChar + stored!._data.slice(1) })

    // GREEN: source-grained — `docs` has no derivation of its own, so the
    // gated decode is skipped and the corrupted body is never read.
    await expect(docs.putAtTier('d1', { id: 'd1', title: 'Renamed' }, 1)).resolves.toEqual({ searchResidue: false })
  })
})
