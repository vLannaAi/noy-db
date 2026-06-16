/**
 * Cross-vault live query — ShardedQuery.live() reactive facade.
 * Task 9 of cross-vault-live-aggregate plan.
 * Spec: docs/superpowers/specs/2026-06-07-cross-vault-live-and-aggregate-design.md
 */
import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '@noy-db/hub'
import { ConflictError, NoAccessError } from '@noy-db/hub'
import { createNoydb } from '@noy-db/hub'
import type { Vault } from '@noy-db/hub'
import type { VaultRegistryRow } from '../src/federation/index.js'
import { sum, count, avg } from '@noy-db/hub/aggregate'
import { createLobby } from '../src/index.js'

// ─── Shared in-memory adapter (copied from federation-vault-group.test.ts) ───

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

interface Invoice { clientId: string; amount: number; status: string }

/** Build an operator db with the registry vault opened and a v1 client template registered. */
async function harness(opts: { autoCreate?: boolean; templateVersion?: number } = {}) {
  const adapter = memory()
  const db = await createNoydb({ store: adapter, user: 'operator', secret: 'op-pass' })
  const lobby = createLobby(db)
  lobby.withVaultTemplate('client-template', {
    version: opts.templateVersion ?? 1,
    configure(vault: Vault) {
      vault.collection<Invoice>('invoices')
    },
  })
  const stateVault = await db.openVault('state')
  const registry = stateVault.collection<VaultRegistryRow>('vault-registry')
  const firm = await lobby.openVaultGroup<Invoice>('firm-clients', {
    registry,
    sharding: {
      keyOf: (r) => r.clientId,
      vaultTemplate: 'client-template',
      ...(opts.autoCreate !== undefined ? { autoCreate: opts.autoCreate } : {}),
    },
  })
  return { adapter, db, registry, firm }
}

// ─── Polling helper (never assert on fixed ticks) ─────────────────────────

async function waitFor(pred: () => boolean, { timeout = 2000, interval = 5 } = {}) {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout')
    await new Promise<void>((r) => setTimeout(r, interval))
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('ShardedQuery.live()', () => {
  it('reflects initial snapshot after ready, reacts to writes, picks up new shard, stop() halts updates', async () => {
    const h = await harness()
    await h.firm.collection('invoices').put('a1', { clientId: 'acme', amount: 100, status: 'overdue' })

    const lq = h.firm.collection('invoices').query().where('status', '==', 'overdue').live()
    await lq.ready
    expect(lq.value.map((r) => r.amount)).toEqual([100])
    expect(lq.skippedVaults).toEqual([])

    // Write to an existing shard — should react
    await h.firm.collection('invoices').put('a2', { clientId: 'acme', amount: 150, status: 'overdue' })
    await waitFor(() => lq.value.length === 2)
    expect(lq.value.map((r) => r.amount).sort((x, y) => x - y)).toEqual([100, 150])

    // Write to a NEW shard (autoCreate) — new partition should appear
    await h.firm.collection('invoices').put('b1', { clientId: 'beta', amount: 200, status: 'overdue' })
    await waitFor(() => lq.value.length === 3)
    expect(lq.value.map((r) => r.amount).sort((x, y) => x - y)).toEqual([100, 150, 200])

    // stop() halts updates
    lq.stop()
    await h.firm.collection('invoices').put('a3', { clientId: 'acme', amount: 300, status: 'overdue' })
    await new Promise<void>((r) => setTimeout(r, 30))
    expect(lq.value.length).toBe(3) // no update after stop
  })
})

// ─── Task 10: one-shot aggregate ─────────────────────────────────────────────

describe('ShardedQuery.aggregate() one-shot', () => {
  it('aggregate across shards: sum/count/avg correct (avg = central reduce, not avg-of-avgs)', async () => {
    const h = await harness()
    const inv = h.firm.collection('invoices')
    await inv.put('a1', { clientId: 'acme', amount: 100, status: 'open' })
    await inv.put('a2', { clientId: 'acme', amount: 200, status: 'open' })
    await inv.put('b1', { clientId: 'beta', amount: 300, status: 'open' })
    const { result, skippedVaults } = await h.firm.collection('invoices').query()
      .aggregate({ total: sum('amount'), n: count(), mean: avg('amount') }).run()
    expect(skippedVaults).toEqual([])
    expect(result.total).toBe(600)
    expect(result.n).toBe(3)
    expect(result.mean).toBe(200) // NOT (150+300)/2 = 225 — central reduce, not avg-of-avgs
  })

  it('groupBy(status).aggregate sums per status across shards', async () => {
    const h = await harness()
    const inv = h.firm.collection('invoices')
    await inv.put('a1', { clientId: 'acme', amount: 100, status: 'overdue' })
    await inv.put('b1', { clientId: 'beta', amount: 300, status: 'overdue' })
    await inv.put('b2', { clientId: 'beta', amount: 50, status: 'open' })
    const { results } = await h.firm.collection('invoices').query()
      .groupBy('status').aggregate({ total: sum('amount') }).run()
    const overdue = results.find((r) => r.status === 'overdue')
    expect(overdue?.total).toBe(400)
  })
})

// ─── Task 11: reactive aggregate (.live()) ────────────────────────────────────

describe('ShardedQuery.aggregate().live()', () => {
  it('updates the scalar aggregate on write, then stop() halts updates', async () => {
    const h = await harness()
    await h.firm.collection('invoices').put('a1', { clientId: 'acme', amount: 100, status: 'open' })
    const la = h.firm.collection('invoices').query().aggregate({ total: sum('amount') }).live()
    await la.ready
    expect(la.value?.total).toBe(100)

    await h.firm.collection('invoices').put('b1', { clientId: 'beta', amount: 50, status: 'open' })
    await waitFor(() => la.value?.total === 150)
    la.stop()

    // After stop, writes do not update the aggregate
    await h.firm.collection('invoices').put('b2', { clientId: 'beta', amount: 999, status: 'open' })
    await new Promise<void>((r) => setTimeout(r, 30))
    expect(la.value?.total).toBe(150)
  })

  it('groupBy().aggregate().live() updates grouped rows on write', async () => {
    const h = await harness()
    await h.firm.collection('invoices').put('a1', { clientId: 'acme', amount: 100, status: 'overdue' })
    const lg = h.firm.collection('invoices').query()
      .groupBy('status').aggregate({ total: sum('amount') }).live()
    await lg.ready
    const overdueRow = lg.value.find((r) => r.status === 'overdue')
    expect(overdueRow?.total).toBe(100)

    await h.firm.collection('invoices').put('b1', { clientId: 'beta', amount: 200, status: 'overdue' })
    await waitFor(() => {
      const row = lg.value.find((r) => r.status === 'overdue')
      return row !== undefined && row.total === 300
    })
    lg.stop()
  })
})

// ─── Review follow-up 5: no-grant assertion on the live/aggregate surface ─────

describe('ShardedQuery.live() — no-grant scoped access', () => {
  it('live() skips non-granted shard as no-grant + only shows granted shard rows after ready', async () => {
    // Operator creates two shards (firm-clients--acme and firm-clients--beta),
    // then grants advisor access to only one shard + the state registry vault.
    const adapter = memory()
    const op = await createNoydb({ store: adapter, user: 'operator', secret: 'op-pass' })
    const oplobby = createLobby(op)
    oplobby.withVaultTemplate('client-template', { version: 1, configure: (v: Vault) => { v.collection<Invoice>('invoices') } })
    const opState = await op.openVault('state')
    const opFirm = await oplobby.openVaultGroup<Invoice>('firm-clients', {
      registry: opState.collection<VaultRegistryRow>('vault-registry'),
      sharding: { keyOf: (r) => r.clientId, vaultTemplate: 'client-template' },
    })
    await opFirm.collection('invoices').put('a1', { clientId: 'acme', amount: 100, status: 'overdue' })
    await opFirm.collection('invoices').put('b1', { clientId: 'beta', amount: 200, status: 'overdue' })
    // Grant advisor only to firm-clients--acme and the state registry vault
    await op.grant('firm-clients--acme', { userId: 'advisor', displayName: 'Adv', role: 'viewer', passphrase: 'adv-pass' })
    await op.grant('state', { userId: 'advisor', displayName: 'Adv', role: 'viewer', passphrase: 'adv-pass' })

    // Advisor opens the same group
    const adv = await createNoydb({ store: adapter, user: 'advisor', secret: 'adv-pass' })
    const advlobby = createLobby(adv)
    advlobby.withVaultTemplate('client-template', { version: 1, configure: (v: Vault) => { v.collection<Invoice>('invoices') } })
    const advState = await adv.openVault('state')
    const advFirm = await advlobby.openVaultGroup<Invoice>('firm-clients', {
      registry: advState.collection<VaultRegistryRow>('vault-registry'),
      sharding: { keyOf: (r) => r.clientId, vaultTemplate: 'client-template' },
    })

    const lq = advFirm.collection('invoices').query().where('status', '==', 'overdue').live()
    await lq.ready

    // Only acme (granted) rows appear; beta (non-granted) is in skippedVaults with reason 'no-grant'
    expect(lq.value.map((r) => r.amount)).toEqual([100])
    const skip = lq.skippedVaults.find((s) => s.vaultId === 'firm-clients--beta')
    expect(skip?.reason).toBe('no-grant')
    // Advisor must NOT have self-provisioned a keyring into the non-granted shard
    expect(await adapter.get('firm-clients--beta', '_keyring', 'advisor')).toBeNull()

    lq.stop()
  })
})
