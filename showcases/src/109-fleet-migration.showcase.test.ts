/**
 * Showcase 109 — Fleet schema migration (VaultGroup.migrateFleet)
 *
 * What you'll learn
 * ─────────────────
 * When a sharded schema evolves (the `invoices` schema gains a richer
 * `amount` shape), every per-client shard vault must migrate — safely, at
 * its own pace, without blocking reads across a mixed-version fleet. The
 * fleet runner orchestrates M12's per-vault cutover across all shards and
 * records each shard's progress in the StateManagement Vault.
 *
 *   1. `migrateFleet({ cohort? })` — active batch runner; staged via `cohort`.
 *   2. `migrateShard(key)` — one shard; `migrateOnOpen` — lazy on access.
 *   3. The `minVersion` fan-out guard skips behind-version shards until migrated.
 *   4. Resumable: a re-run only touches shards not yet at the target.
 *
 * Why it matters
 * ──────────────
 * Migrating thousands of independent vaults is the operational hard part of
 * per-tenant isolation. Each vault still uses M12's single-vault cutover
 * internally; the fleet runner adds the orchestration + crash-safe status,
 * and the `minVersion` guard means reads never silently mix record shapes
 * from shards sitting at different schema generations.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 98 (VaultGroup), 96/coordinatedCutover (M12 per-vault cutover).
 *
 * Spec mapping
 * ────────────
 * features.yaml → features → vault-group-federation
 */

import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { createNoydb, coordinatedCutover } from '@noy-db/hub'
import type { Vault } from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'

const oldSchema = z.object({ id: z.string(), clientId: z.string(), total: z.number() })
const newSchema = z.object({ id: z.string(), clientId: z.string(), amount: z.object({ gross: z.number() }) })
const transform = (d: Record<string, unknown>) => ({ id: d['id'], clientId: d['clientId'], amount: { gross: d['total'] } })
const sharding = { keyOf: (r: { clientId: string }) => r.clientId, vaultTemplate: 'client', autoCreate: true }

describe('Showcase 109 — Fleet schema migration', () => {
  it('migrates a sharded fleet from v1 to v2, staged then complete', async () => {
    const store = memory()

    // ── v1: a firm with three client shards on the old schema ──
    const db1 = await createNoydb({ store, user: 'firm-op', secret: 'firm-2026' })
    db1.withVaultTemplate('client', { version: 1, configure: (v: Vault) => { v.collection('invoices', { schema: oldSchema, persistJsonSchema: true }) } })
    const firmV1 = await db1.openVaultGroup('firm', { sharding })
    for (const [client, total] of [['acme', 100], ['globex', 250], ['initech', 70]] as const) {
      await firmV1.collection('invoices').put(`${client}-1`, { id: `${client}-1`, clientId: client, total })
      await (await firmV1.shard(client))._drainPendingSchemaWrites() // persist the v1 baseline
    }

    // ── v2: publish the new schema + cutover transform (operator restart) ──
    const db2 = await createNoydb({ store, user: 'firm-op', secret: 'firm-2026' })
    db2.withVaultTemplate('client', {
      version: 2,
      configure: (v: Vault) => { v.collection('invoices', { schema: newSchema, persistJsonSchema: true, schemaUpdate: [coordinatedCutover({ transform })] }) },
    })
    const firm = await db2.openVaultGroup('firm', { sharding })

    // A mixed-version read is safe: minVersion:2 skips the not-yet-migrated shards.
    const beforeMigration = await firm.collection('invoices').query().toArray({ minVersion: 2 })
    expect(beforeMigration.results).toEqual([])
    expect(beforeMigration.skippedVaults).toHaveLength(3) // all still v1

    // ── Staged rollout: canary one client, verify, then the rest ──
    const canary = await firm.migrateFleet({ cohort: ['acme'] })
    expect(canary.migrated).toEqual(['firm--acme'])
    const acme = await firm.shard('acme')
    expect((await acme.collection<{ amount: { gross: number } }>('invoices').get('acme-1'))?.amount.gross).toBe(100)

    // Roll out the rest; failed shards (none here) would be in `failed`.
    const rest = await firm.migrateFleet()
    expect(rest.migrated.sort()).toEqual(['firm--globex', 'firm--initech'])

    // The whole fleet now answers the v2 fan-out.
    const afterMigration = await firm.collection('invoices').query().toArray({ minVersion: 2 })
    expect(afterMigration.results).toHaveLength(3)
    expect(afterMigration.skippedVaults).toEqual([])

    // Resumable: another run is a no-op now that all shards are current.
    expect((await firm.migrateFleet()).migrated).toEqual([])

    db1.close()
    db2.close()
  })
})
