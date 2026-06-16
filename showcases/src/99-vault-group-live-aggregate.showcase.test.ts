/**
 * Showcase 99 — VaultGroup: live cross-shard queries + distributed aggregates
 *
 * What you'll learn
 * ─────────────────
 * Building on Showcase 98 (basic VaultGroup fan-out), this showcase adds the
 * reactive and aggregate dimensions of the cross-vault federation surface:
 *
 *   1. `.query().where().live()` — a reactive cross-shard query that emits an
 *      updated `value` array whenever any shard's matching records change.
 *      `await lq.ready` settles the initial snapshot; `waitFor` polls for
 *      subsequent reactive updates.
 *
 *   2. `.aggregate({ total: sum('amount'), n: count() }).run()` — one-shot
 *      distributed aggregate that collects all shard records into a central
 *      reduce pass (no avg-of-avgs: mean is computed over the full union).
 *
 *   3. `.groupBy('clientId').aggregate({ total: sum('amount') }).run()` —
 *      one-shot grouped aggregate; one output row per distinct `clientId`
 *      across all shards.
 *
 * Why it matters
 * ──────────────
 * Per-shard isolation is cryptographic (one vault = one DEK boundary), yet
 * the firm needs fleet-level visibility without merging data stores. The
 * live and aggregate surfaces bridge the two: reactive UI bindings stay
 * coherent as data arrives from any shard, and reporting numbers are always
 * correct because the reduce runs over the full union — not an average of
 * per-shard averages.
 *
 * Spec mapping
 * ────────────
 * features.yaml → features → vault-group-federation
 * spec → docs/superpowers/specs/2026-06-07-cross-vault-live-and-aggregate-design.md
 */

import { describe, it, expect, afterEach } from 'vitest'
import { createNoydb, sum, count, avg } from '@noy-db/hub'
import type { Vault } from '@noy-db/hub'
import { createLobby } from '@klum-db/lobby'
import type { VaultRegistryRow } from '@klum-db/lobby'
import { memory } from '@noy-db/to-memory'

// ─── Domain model ───────────────────────────────────────────────────────────

interface Invoice {
  clientId: string
  amount: number
  status: 'open' | 'overdue' | 'paid'
}

// ─── Polling helper ──────────────────────────────────────────────────────────

async function waitFor(pred: () => boolean, { timeout = 2000, interval = 5 } = {}) {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timeout')
    await new Promise<void>((r) => setTimeout(r, interval))
  }
}

// ─── Harness ─────────────────────────────────────────────────────────────────

/**
 * Open a firm operator with a client template (v1) and a vault-registry–backed
 * VaultGroup. Partition key is `clientId` (opaque internal id — NOT a human
 * identifier, per the roster-visibility contract).
 */
async function openFirm(store: ReturnType<typeof memory>) {
  const db = await createNoydb({ store, user: 'firm-operator', secret: 'firm-secret-2026' })
  const lobby = createLobby(db)
  lobby.withVaultTemplate('client-template', {
    version: 1,
    configure(vault: Vault) {
      vault.collection<Invoice>('invoices')
    },
  })
  const state = await db.openVault('state')
  const registry = state.collection<VaultRegistryRow>('vault-registry')
  const firm = await lobby.openVaultGroup<Invoice>('firm-clients', {
    registry,
    sharding: { keyOf: (r) => r.clientId, vaultTemplate: 'client-template', autoCreate: true },
  })
  return { db, firm }
}

// ─── Showcase tests ──────────────────────────────────────────────────────────

describe('Showcase 99 — VaultGroup live + distributed aggregate', () => {
  // Track live handles for cleanup
  const liveHandles: Array<{ stop(): void }> = []
  afterEach(() => {
    for (const h of liveHandles) h.stop()
    liveHandles.length = 0
  })

  it('live() reflects the initial snapshot and reacts to writes across shards', async () => {
    const store = memory()
    const { firm } = await openFirm(store)

    // Seed an invoice on one shard before starting the live query.
    await firm.collection('invoices').put('c1-inv1', { clientId: 'c1', amount: 500, status: 'overdue' })

    // Start the live query — `await lq.ready` settles the initial snapshot.
    const lq = firm.collection('invoices').query().where('status', '==', 'overdue').live()
    liveHandles.push(lq)
    await lq.ready

    expect(lq.value.map((r) => r.amount)).toEqual([500])
    expect(lq.skippedVaults).toEqual([])

    // Write to the same shard — live query must update.
    await firm.collection('invoices').put('c1-inv2', { clientId: 'c1', amount: 300, status: 'overdue' })
    await waitFor(() => lq.value.length === 2)
    expect(lq.value.map((r) => r.amount).sort((a, b) => a - b)).toEqual([300, 500])

    // Write to a NEW shard (auto-created) — live query picks it up.
    await firm.collection('invoices').put('c2-inv1', { clientId: 'c2', amount: 750, status: 'overdue' })
    await waitFor(() => lq.value.length === 3)
    expect(lq.value.map((r) => r.amount).sort((a, b) => a - b)).toEqual([300, 500, 750])

    // stop() halts updates — subsequent writes do not propagate.
    lq.stop()
    await firm.collection('invoices').put('c1-inv3', { clientId: 'c1', amount: 999, status: 'overdue' })
    await new Promise<void>((r) => setTimeout(r, 30))
    expect(lq.value.length).toBe(3)
  })

  it('aggregate().run() performs a central reduce — sum/count/avg correct across shards', async () => {
    const store = memory()
    const { firm } = await openFirm(store)

    // Two invoices on shard c1 (amounts 100 + 200) and one on shard c2 (300).
    // avg must be (100+200+300)/3 = 200, NOT avg-of-avgs (150+300)/2 = 225.
    await firm.collection('invoices').put('c1-inv1', { clientId: 'c1', amount: 100, status: 'open' })
    await firm.collection('invoices').put('c1-inv2', { clientId: 'c1', amount: 200, status: 'open' })
    await firm.collection('invoices').put('c2-inv1', { clientId: 'c2', amount: 300, status: 'open' })

    const { result, skippedVaults } = await firm.collection('invoices')
      .query()
      .aggregate({ total: sum('amount'), n: count(), mean: avg('amount') })
      .run()

    expect(skippedVaults).toEqual([])
    expect(result.total).toBe(600)
    expect(result.n).toBe(3)
    // Central reduce: mean = 600/3 = 200 (not avg-of-avgs)
    expect(result.mean).toBe(200)
  })

  it('groupBy().aggregate().run() produces one row per distinct clientId across all shards', async () => {
    const store = memory()
    const { firm } = await openFirm(store)

    // Invoices spread across two client shards, two statuses.
    await firm.collection('invoices').put('c1-inv1', { clientId: 'c1', amount: 100, status: 'overdue' })
    await firm.collection('invoices').put('c1-inv2', { clientId: 'c1', amount: 200, status: 'open' })
    await firm.collection('invoices').put('c2-inv1', { clientId: 'c2', amount: 400, status: 'overdue' })
    await firm.collection('invoices').put('c3-inv1', { clientId: 'c3', amount: 50, status: 'open' })

    const { results, skippedVaults } = await firm.collection('invoices')
      .query()
      .groupBy('clientId')
      .aggregate({ total: sum('amount') })
      .run()

    expect(skippedVaults).toEqual([])

    // One row per clientId; each row has the sum of that client's invoices.
    const byClient = Object.fromEntries(results.map((r) => [r.clientId, r.total]))
    expect(byClient['c1']).toBe(300)  // 100 + 200
    expect(byClient['c2']).toBe(400)
    expect(byClient['c3']).toBe(50)
    expect(results).toHaveLength(3)
  })
})
