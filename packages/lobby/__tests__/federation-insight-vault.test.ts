/**
 * Insight Vault — push-model cross-vault derivation (#271 Layer 4).
 * withCrossVaultDerivation() + refreshInsights().
 */
import { describe, it, expect, beforeEach } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '@noy-db/hub'
import { ConflictError, ValidationError } from '@noy-db/hub'
import { createNoydb } from '@noy-db/hub'
import type { Noydb } from '@noy-db/hub'
import type { Vault } from '@noy-db/hub'
import type { VaultRegistryRow } from '../src/federation/index.js'
import { createLobby } from '../src/index.js'

function memory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function gc(c: string, col: string) {
    let comp = store.get(c); if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col); if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    name: 'memory',
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
      if (comp) for (const [n, coll] of comp) {
        if (!n.startsWith('_')) {
          const r: Record<string, EncryptedEnvelope> = {}
          for (const [id, e] of coll) r[id] = e
          s[n] = r
        }
      }
      return s
    },
    async saveAll(c, data) {
      for (const [n, recs] of Object.entries(data)) {
        const coll = gc(c, n)
        for (const [id, e] of Object.entries(recs)) coll.set(id, e)
      }
    },
  }
}

interface Invoice extends Record<string, unknown> { id: string; clientId: string; amount: number; status: string }
interface Summary extends Record<string, unknown> { clientId: string; totalRevenue: number; overdueCount: number; schemaVersion: number }

async function harness(templateVersion = 1) {
  const adapter = memory()
  const db = await createNoydb({ store: adapter, user: 'operator', secret: 'op-pass' })
  const lobby = createLobby(db)
  lobby.withVaultTemplate('client-template', {
    version: templateVersion,
    configure(vault: Vault) { vault.collection<Invoice>('invoices') },
  })
  const stateVault = await db.openVault('state')
  const registry = stateVault.collection<VaultRegistryRow>('vault-registry')
  const firm = await lobby.openVaultGroup<Invoice>('firm-clients', {
    registry,
    sharding: { keyOf: (r) => r.clientId, vaultTemplate: 'client-template', autoCreate: true },
  })
  return { adapter, db, registry, firm }
}

describe('Insight Vault — withCrossVaultDerivation / refreshInsights (#271)', () => {
  let h: Awaited<ReturnType<typeof harness>>
  beforeEach(async () => { h = await harness() })

  function registerSummary() {
    h.firm.withCrossVaultDerivation<Invoice, Summary>({
      source: 'invoices',
      target: { vault: 'firm-insights', collection: 'client-summary' },
      derive: (records, ctx) => ({
        clientId: ctx.partitionKey,
        totalRevenue: records.reduce((s, r) => s + r.amount, 0),
        overdueCount: records.filter((r) => r.status === 'overdue').length,
        schemaVersion: ctx.schemaVersion,
      }),
    })
  }

  it('refuses a target.vault that is the group itself or one of its shards (Insight-write isolation)', () => {
    // The group is 'firm-clients'; its shards are 'firm-clients--<key>'.
    expect(() =>
      h.firm.withCrossVaultDerivation<Invoice, Summary>({
        source: 'invoices',
        target: { vault: 'firm-clients', collection: 'x' },
        derive: () => ({}) as Summary,
      }),
    ).toThrow(ValidationError)
    expect(() =>
      h.firm.withCrossVaultDerivation<Invoice, Summary>({
        source: 'invoices',
        target: { vault: 'firm-clients--acme', collection: 'x' },
        derive: () => ({}) as Summary,
      }),
    ).toThrow(ValidationError)
    // A separate analytics vault is fine.
    expect(() =>
      h.firm.withCrossVaultDerivation<Invoice, Summary>({
        source: 'invoices',
        target: { vault: 'firm-insights', collection: 'client-summary' },
        derive: () => ({}) as Summary,
      }),
    ).not.toThrow()
  })

  it('writes one summary row per shard into the Insight Vault', async () => {
    const inv = h.firm.collection<Invoice>('invoices')
    await inv.put('a1', { id: 'a1', clientId: 'acme', amount: 100, status: 'paid' })
    await inv.put('a2', { id: 'a2', clientId: 'acme', amount: 250, status: 'overdue' })
    await inv.put('b1', { id: 'b1', clientId: 'globex', amount: 70, status: 'overdue' })

    registerSummary()
    const res = await h.firm.refreshInsights()
    expect(res.written).toBe(2)
    expect(res.skippedVaults).toEqual([])

    const insights = await h.db.openVault('firm-insights')
    const summaries = insights.collection<Summary>('client-summary')
    expect(await summaries.get('acme')).toMatchObject({ clientId: 'acme', totalRevenue: 350, overdueCount: 1, schemaVersion: 1 })
    expect(await summaries.get('globex')).toMatchObject({ clientId: 'globex', totalRevenue: 70, overdueCount: 1 })
  })

  it('is idempotent and reflects new writes on re-refresh', async () => {
    const inv = h.firm.collection<Invoice>('invoices')
    await inv.put('a1', { id: 'a1', clientId: 'acme', amount: 100, status: 'paid' })
    registerSummary()
    await h.firm.refreshInsights()

    const summaries = (await h.db.openVault('firm-insights')).collection<Summary>('client-summary')
    expect((await summaries.get('acme'))?.totalRevenue).toBe(100)

    await inv.put('a2', { id: 'a2', clientId: 'acme', amount: 400, status: 'paid' })
    await h.firm.refreshInsights()
    expect((await summaries.get('acme'))?.totalRevenue).toBe(500)
    // still exactly one row for acme
    expect(await summaries.query().toArray()).toHaveLength(1)
  })

  it('no registered derivation → refreshInsights is a no-op', async () => {
    const res = await h.firm.refreshInsights()
    expect(res).toEqual({ written: 0, skippedVaults: [] })
  })

  it('skips shards behind minVersion (schema drift) and does not write their summary', async () => {
    // acme created at v1
    await h.firm.collection<Invoice>('invoices').put('a1', { id: 'a1', clientId: 'acme', amount: 100, status: 'paid' })
    registerSummary()
    const res = await h.firm.refreshInsights({ minVersion: 2 }) // acme is v1 < 2
    expect(res.written).toBe(0)
    expect(res.skippedVaults).toEqual([{ vaultId: 'firm-clients--acme', reason: 'schema-drift' }])
    const summaries = (await h.db.openVault('firm-insights')).collection<Summary>('client-summary')
    expect(await summaries.get('acme')).toBeNull()
  })

  it('the shard ciphertext stays in its own vault — the Insight Vault holds only the summary', async () => {
    const inv = h.firm.collection<Invoice>('invoices')
    await inv.put('a1', { id: 'a1', clientId: 'acme', amount: 100, status: 'paid' })
    registerSummary()
    await h.firm.refreshInsights()
    // The Insight Vault has the summary collection, NOT the source 'invoices' collection.
    const insights = await h.db.openVault('firm-insights')
    expect(await insights.collection<Summary>('client-summary').query().toArray()).toHaveLength(1)
    expect(await insights.collection<Invoice>('invoices').query().toArray()).toEqual([])
  })

  it('supports multiple registered derivations', async () => {
    const inv = h.firm.collection<Invoice>('invoices')
    await inv.put('a1', { id: 'a1', clientId: 'acme', amount: 100, status: 'overdue' })
    registerSummary()
    h.firm.withCrossVaultDerivation<Invoice, { clientId: string; count: number }>({
      source: 'invoices',
      target: { vault: 'firm-insights', collection: 'client-count' },
      derive: (records, ctx) => ({ clientId: ctx.partitionKey, count: records.length }),
    })
    const res = await h.firm.refreshInsights()
    expect(res.written).toBe(2) // 1 shard × 2 derivations
    const insights = await h.db.openVault('firm-insights')
    expect((await insights.collection<Summary>('client-summary').get('acme'))?.overdueCount).toBe(1)
    expect((await insights.collection<{ clientId: string; count: number }>('client-count').get('acme'))?.count).toBe(1)
  })
})
