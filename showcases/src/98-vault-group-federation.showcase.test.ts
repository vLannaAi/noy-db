/**
 * Showcase 98 — Multi-vault partition federation (VaultGroup)
 *
 * What you'll learn
 * ─────────────────
 * A firm manages many independent client portfolios. Each client's data lives
 * in its OWN vault (its own DEKs, its own store namespace) — yet the firm wants
 * a single entry point to write and a single fan-out query to read across all
 * of them. `db.openVaultGroup()` provides exactly that: transparent routing by
 * partition key over per-client shard vaults, with shard discovery backed by a
 * `vault-registry` collection that is the single source of truth.
 *
 * This showcase exercises the whole milestone-16 MVP surface:
 *   1. `withVaultTemplate` — a versioned schema blueprint for shards
 *   2. `openVaultGroup` — the group entry point, registry-backed
 *   3. transparent write routing with `autoCreate` (shards stamped on demand)
 *   4. cross-shard fan-out reads → `{ results, skippedVaults }`
 *   5. `shard()` drill-down to one client's full Collection API
 *   6. idempotent `createShard`
 *   7. the `minVersion` schema-drift guard (mixed-version fleet)
 *   8. `UnknownShardError` when `autoCreate` is off
 *   9. partition-key validation (collision-safe shard ids)
 *
 * Why it matters
 * ──────────────
 * Per-client isolation is a cryptographic guarantee (one vault = one DEK
 * boundary), but isolated vaults are awkward to operate at fleet scale.
 * VaultGroup keeps the small-DB / one-vault-per-tenant philosophy intact while
 * giving the firm fleet-level ergonomics — no application-level ACLs, no manual
 * vault bookkeeping, and no silent mixing of records from shards sitting at
 * different schema generations.
 *
 * Spec mapping
 * ────────────
 * features.yaml → features → vault-group-federation
 * spec → docs/superpowers/specs/2026-06-07-mvf-vaultgroup-routing-mvp-design.md
 */

import { describe, it, expect } from 'vitest'
import { createNoydb, UnknownShardError, ValidationError } from '@noy-db/hub'
import type { VaultRegistryRow } from '@noy-db/hub'
import type { Vault } from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'

interface Invoice {
  clientId: string
  amount: number
  status: 'open' | 'overdue' | 'paid'
}

/**
 * Open a firm operator instance, register a client template at `version`,
 * and open a VaultGroup whose registry lives in a dedicated `state` vault.
 * The store is shared so a second operator instance can read what the first
 * wrote — this models a real deployment, not just one in-memory session.
 */
async function openFirm(store: ReturnType<typeof memory>, version = 1) {
  const db = await createNoydb({ store, user: 'firm-operator', secret: 'firm-secret-2026' })
  db.withVaultTemplate('client-template', {
    version,
    configure(vault: Vault) {
      // Every client shard gets an identically-shaped `invoices` collection.
      vault.collection<Invoice>('invoices')
    },
  })
  const state = await db.openVault('state')
  const registry = state.collection<VaultRegistryRow>('vault-registry')
  const firm = await db.openVaultGroup<Invoice>('firm-clients', {
    registry,
    sharding: { keyOf: (r) => r.clientId, vaultTemplate: 'client-template', autoCreate: true },
  })
  return { db, registry, firm }
}

describe('Showcase 98 — Multi-vault partition federation', () => {
  it('routes writes to per-client shards and fans out reads across all of them', async () => {
    const store = memory()
    const { registry, firm } = await openFirm(store)

    // Transparent writes. Each invoice is routed to its client's shard by
    // `keyOf(record) = record.clientId`. Unknown partitions are auto-created.
    const invoices = firm.collection('invoices')
    await invoices.put('acme-1', { clientId: 'acme', amount: 1200, status: 'overdue' })
    await invoices.put('acme-2', { clientId: 'acme', amount: 300, status: 'paid' })
    await invoices.put('globex-1', { clientId: 'globex', amount: 900, status: 'overdue' })
    await invoices.put('initech-1', { clientId: 'initech', amount: 50, status: 'open' })

    // Three shards were stamped on demand and recorded in the registry.
    await registry.list()
    const rows = registry.query().toArray()
    expect(rows.map((r) => r.partitionKey).sort()).toEqual(['acme', 'globex', 'initech'])
    expect(rows.every((r) => r.schemaVersion === 1)).toBe(true)
    expect(rows.find((r) => r.partitionKey === 'acme')!.vaultId).toBe('firm-clients--acme')

    // Cross-shard fan-out read: "every overdue invoice across all clients".
    const overdue = await firm.collection('invoices').query()
      .where('status', '==', 'overdue')
      .toArray()
    expect(overdue.skippedVaults).toEqual([])
    expect(overdue.results.map((r) => r.amount).sort((a, b) => a - b)).toEqual([900, 1200])

    // Drill down to one client's full Collection API for detail work.
    const acme = await firm.shard('acme')
    const detail = await acme.collection<Invoice>('invoices').get('acme-2')
    expect(detail).toEqual({ clientId: 'acme', amount: 300, status: 'paid' })
  })

  it('createShard is idempotent — re-provisioning a client is a no-op', async () => {
    const store = memory()
    const { registry, firm } = await openFirm(store)

    await firm.createShard('acme')
    await firm.createShard('acme') // safe to re-run (e.g. retried provisioning)

    await registry.list()
    const acmeRows = registry.query().toArray().filter((r) => r.partitionKey === 'acme')
    expect(acmeRows).toHaveLength(1)
  })

  it('the minVersion guard skips behind-version shards instead of mixing record shapes', async () => {
    const store = memory()

    // Firm starts at template v1; client "acme" is provisioned at v1.
    const v1 = await openFirm(store, 1)
    await v1.firm.collection('invoices').put('acme-1', { clientId: 'acme', amount: 1200, status: 'overdue' })

    // The firm rolls the template to v2 and onboards "globex" at v2. Now the
    // fleet is mixed: acme@v1, globex@v2 (a realistic mid-rollout window).
    const v2 = await openFirm(store, 2)
    await v2.firm.collection('invoices').put('globex-1', { clientId: 'globex', amount: 900, status: 'overdue' })

    // A v2-only report pre-filters by the registry-recorded schemaVersion:
    // acme (v1) lands in skippedVaults; only globex (v2) contributes results.
    const report = await v2.firm.collection('invoices').query()
      .where('status', '==', 'overdue')
      .toArray({ minVersion: 2 })

    expect(report.results.map((r) => r.amount)).toEqual([900])
    expect(report.skippedVaults).toEqual([
      { vaultId: 'firm-clients--acme', reason: 'schema-drift' },
    ])
  })

  it('rejects writes to unknown clients when autoCreate is off', async () => {
    const store = memory()
    const db = await createNoydb({ store, user: 'firm-operator', secret: 'firm-secret-2026' })
    db.withVaultTemplate('client-template', {
      version: 1,
      configure(vault: Vault) { vault.collection<Invoice>('invoices') },
    })
    const state = await db.openVault('state')
    const strictFirm = await db.openVaultGroup<Invoice>('firm-clients', {
      registry: state.collection<VaultRegistryRow>('vault-registry'),
      sharding: { keyOf: (r) => r.clientId, vaultTemplate: 'client-template', autoCreate: false },
    })

    await expect(
      strictFirm.collection('invoices').put('x-1', { clientId: 'unbooked', amount: 1, status: 'open' }),
    ).rejects.toBeInstanceOf(UnknownShardError)
  })

  it('validates partition keys so two clients can never collide into one shard', async () => {
    const store = memory()
    const { firm } = await openFirm(store)

    // "--" is the reserved shard-id separator; allowing it in a key would let
    // ("firm-clients", "a--b") and ("firm-clients--a", "b") collide.
    await expect(firm.createShard('a--b')).rejects.toBeInstanceOf(ValidationError)
    await expect(firm.createShard('bad/key')).rejects.toBeInstanceOf(ValidationError)

    // Ordinary hyphenated identifiers (UUID-like) are fine.
    await expect(firm.createShard('acme-corp-2026')).resolves.toBeDefined()
  })
})
