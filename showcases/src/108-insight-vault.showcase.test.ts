/**
 * Showcase 108 — Insight Vault (cross-vault derivation, push model)
 *
 * What you'll learn
 * ─────────────────
 * A firm shards each client into its own vault (own DEK boundary). The firm
 * also wants a fast, fleet-wide dashboard — overdue counts, revenue per
 * client — WITHOUT opening and decrypting every client vault on each read.
 * `firm.withCrossVaultDerivation()` registers a push-model aggregation:
 * `refreshInsights()` reads each shard, derives a per-shard summary, and
 * writes it into a separate analytics "Insight Vault" keyed by client.
 *
 *   1. `withCrossVaultDerivation({ source, target, derive })` — declare.
 *   2. `refreshInsights()` — drive it (explicit-refresh in v1).
 *   3. Read the Insight Vault directly — one tiny row per client, fast.
 *   4. Shard ciphertext never leaves its vault; only the summary is written.
 *
 * Why it matters
 * ──────────────
 * Per-client isolation is a cryptographic guarantee, but a fleet dashboard
 * shouldn't require N per-client decryptions on every page load. The push
 * model keeps each shard's DEK boundary intact while giving analysts a
 * single small vault to query.
 *
 * Zero-knowledge note
 * ───────────────────
 * The Insight Vault backend sees AGGREGATED structure across clients (totals,
 * counts) — a weaker ZK profile than the per-client vaults. Opt-in; keep
 * summaries to aggregate scalars.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 98 (VaultGroup federation).
 *
 * Spec mapping
 * ────────────
 * features.yaml → features → vault-group-federation
 */

import { describe, it, expect } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import type { Vault } from '@noy-db/hub'
import { createLobby } from '@klum-db/lobby'
import type { VaultRegistryRow } from '@klum-db/lobby'
import { memory } from '@noy-db/to-memory'

interface Invoice { clientId: string; amount: number; status: 'open' | 'overdue' | 'paid' }
interface ClientSummary { clientId: string; totalRevenue: number; overdueCount: number; schemaVersion: number }

describe('Showcase 108 — Insight Vault', () => {
  it('derives one fast summary row per client into a separate analytics vault', async () => {
    const db = await createNoydb({ store: memory(), user: 'firm-operator', secret: 'firm-secret-2026' })
    const lobby = createLobby(db)
    lobby.withVaultTemplate('client-template', {
      version: 1,
      configure(vault: Vault) { vault.collection<Invoice>('invoices') },
    })
    const state = await db.openVault('state')
    const firm = await lobby.openVaultGroup<Invoice>('firm-clients', {
      registry: state.collection<VaultRegistryRow>('vault-registry'),
      sharding: { keyOf: (r) => r.clientId, vaultTemplate: 'client-template', autoCreate: true },
    })

    // Each invoice routes to its client's own shard vault.
    const invoices = firm.collection('invoices')
    await invoices.put('acme-1', { clientId: 'acme', amount: 1200, status: 'overdue' })
    await invoices.put('acme-2', { clientId: 'acme', amount: 300, status: 'paid' })
    await invoices.put('globex-1', { clientId: 'globex', amount: 900, status: 'overdue' })

    // Declare the cross-vault derivation (Insight Vault), then drive it.
    firm.withCrossVaultDerivation<Invoice, ClientSummary>({
      source: 'invoices',
      target: { vault: 'firm-insights', collection: 'client-summary' },
      derive: (records, ctx) => ({
        clientId: ctx.partitionKey,
        totalRevenue: records.reduce((s, r) => s + r.amount, 0),
        overdueCount: records.filter((r) => r.status === 'overdue').length,
        schemaVersion: ctx.schemaVersion,
      }),
    })
    const { written, skippedVaults } = await firm.refreshInsights()
    expect(written).toBe(2)
    expect(skippedVaults).toEqual([])

    // The analyst reads ONE small vault — no per-client decryption.
    const insights = await db.openVault('firm-insights')
    const summary = insights.collection<ClientSummary>('client-summary')
    expect(await summary.get('acme')).toMatchObject({ totalRevenue: 1500, overdueCount: 1 })
    expect(await summary.get('globex')).toMatchObject({ totalRevenue: 900, overdueCount: 1 })

    // The summary is the ONLY thing in the Insight Vault — no raw invoices crossed over.
    expect(await insights.collection<Invoice>('invoices').query().toArray()).toEqual([])

    // Re-refresh after a new write keeps exactly one row per client, updated.
    await invoices.put('acme-3', { clientId: 'acme', amount: 500, status: 'overdue' })
    await firm.refreshInsights()
    expect(await summary.get('acme')).toMatchObject({ totalRevenue: 2000, overdueCount: 2 })
    expect(await summary.query().toArray()).toHaveLength(2)

    db.close()
  })
})
