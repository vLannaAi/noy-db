/**
 * Cross-vault live query — ShardedQuery.live() reactive facade.
 * Task 9 of cross-vault-live-aggregate plan.
 * Spec: docs/superpowers/specs/2026-06-07-cross-vault-live-and-aggregate-design.md
 */
import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/types.js'
import { ConflictError } from '../src/errors.js'
import { createNoydb } from '../src/noydb.js'
import type { Vault } from '../src/vault.js'
import type { VaultRegistryRow } from '../src/federation/index.js'
import { sum, count, avg } from '../src/aggregate/reducers.js'

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
  db.withVaultTemplate('client-template', {
    version: opts.templateVersion ?? 1,
    configure(vault: Vault) {
      vault.collection<Invoice>('invoices')
    },
  })
  const stateVault = await db.openVault('state')
  const registry = stateVault.collection<VaultRegistryRow>('vault-registry')
  const firm = await db.openVaultGroup<Invoice>('firm-clients', {
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
