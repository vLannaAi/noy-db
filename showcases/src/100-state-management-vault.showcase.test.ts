/**
 * Showcase 100 — StateManagement Vault (federation control plane)
 *
 * What you'll learn
 * ─────────────────
 * `lobby.openVaultGroup(name)` with no explicit `registry` auto-opens a reserved,
 * fleet-wide control-plane vault (`__noydb_state__`) that OWNS three things:
 *   1. vault-registry    — the authoritative shard list (group-qualified ids)
 *   2. schema-manifest   — a per-(template,version) blueprint + fingerprint
 *   3. deployment-events — an append-only operational log
 *
 * Access the control plane with `lobby.openStateManagementVault()`.
 *
 * Why it matters
 * ──────────────
 * The control plane removes hand-rolled registry boilerplate, makes the
 * registry portable (works on backends where `listAccessibleVaults()` is
 * unavailable), and gives drift detection + an audit trail for fleet ops —
 * the foundation the schema-migration runner (next slice) builds on.
 *
 * Spec mapping
 * ────────────
 * features.yaml → features → vault-group-federation (showcase 100)
 * spec → docs/superpowers/specs/2026-06-08-statemanagement-vault-design.md
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { createLobby } from '@klum-db/lobby'
import { memory } from '@noy-db/to-memory'

describe('Showcase 100 — StateManagement Vault', () => {
  it('auto-opens the control plane and records registry + manifest + event', async () => {
    const store = memory()
    const db = await createNoydb({ store, user: 'firm-operator', secret: 'firm-secret-2026' })
    const lobby = createLobby(db)
    lobby.withVaultTemplate('client', { version: 1, configure: (v) => { v.collection('invoices', { indexes: ['buyerId'] }) } })

    const firm = await lobby.openVaultGroup<{ buyerId: string }>('firm', {
      sharding: { keyOf: (r) => r.buyerId, vaultTemplate: 'client' },
    })
    await firm.collection('invoices').put('inv-1', { buyerId: 'acme' })

    const state = await lobby.openStateManagementVault()
    // 1. authoritative, group-qualified registry row
    expect((await state.registry.get('firm--acme'))?.group).toBe('firm')
    // 2. fingerprinted manifest for the template version
    const manifest = await state.schemaManifest.get('client:1')
    expect(manifest?.collections).toEqual(['invoices'])
    expect(manifest?.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    // 3. append-only deployment log captured the shard creation
    const events = await state.queryEvents().toArray()
    expect(events.some((e) => e.type === 'shard-created' && e.vaultId === 'firm--acme')).toBe(true)
  })

  it('detects schema drift against a recorded manifest', async () => {
    const store = memory()
    const db = await createNoydb({ store, user: 'firm-operator', secret: 'firm-secret-2026' })
    const lobby = createLobby(db)
    const state = await lobby.openStateManagementVault()
    await state.recordManifest('client', { version: 1, configure: (v) => { v.collection('invoices') } })
    expect(await state.detectDrift('client', { version: 1, configure: (v) => { v.collection('invoices'); v.collection('audit') } })).toBe(true)
  })
})
