/**
 * Showcase 110 — Data-residency placement guard (VaultGroup)
 *
 * What you'll learn
 * ─────────────────
 * A regulated firm must keep each client's shard vault on a backend in a
 * specific region (GDPR / data locality): `eu-*` clients → an EU store,
 * `us-*` clients → a US store. The federation layer enforces this at
 * PLACEMENT time — a shard can never be provisioned on a wrong-region backend.
 *
 *   1. `routeStore({ vaultRoutes })` routes shard vault ids by name prefix
 *      to a regional backend (the existing geographic-routing seam).
 *   2. A backend declares the region it serves via `capabilities.region`.
 *   3. `sharding.regionOf(record)` states the region a record requires.
 *   4. On auto-create, the group compares the two and throws
 *      `DataResidencyError` BEFORE provisioning on a mismatch.
 *
 * Why it matters
 * ──────────────
 * Residency is a placement invariant, not a runtime filter. Catching a
 * wrong-region placement loudly — before any client data is written — is the
 * compliance-relevant event; a region-encoded partition key keeps naming and
 * routing from drifting silently apart.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 98 (VaultGroup routing).
 *
 * Spec mapping
 * ────────────
 * features.yaml → features → vault-group-federation
 */

import { describe, it, expect } from 'vitest'
import { createNoydb, routeStore, DataResidencyError } from '@noy-db/hub'
import type { Vault, NoydbStore } from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'
import type { VaultRegistryRow } from '@noy-db/hub'

/** A real in-memory store tagged with the region it serves. */
function regional(region?: string): NoydbStore {
  const base = memory()
  return {
    ...base,
    name: `mem${region ? `-${region}` : ''}`,
    capabilities: { casAtomic: false, auth: { kind: 'none', required: false, flow: 'static' }, ...(region ? { region } : {}) },
  }
}

interface Client extends Record<string, unknown> {
  id: string
  region: string        // the legally-required residency region
  placementKey: string  // region-encoded partition key set upstream (can drift → guard catches it)
  name: string
}

describe('Showcase 110 — Data-residency placement guard', () => {
  it('routes EU/US shards to region-correct backends and refuses non-compliant placement', async () => {
    const eu = regional('eu')
    const us = regional('us')
    const control = regional() // registry/state vault — region-neutral

    // Geographic routing by shard-id prefix: firm--eu-* → EU, firm--us-* → US.
    const store = routeStore({ vaultRoutes: { 'firm--eu-': eu, 'firm--us-': us }, default: control })
    const db = await createNoydb({ store, user: 'firm-op', secret: 'firm-2026' })
    db.withVaultTemplate('client', { version: 1, configure: (v: Vault) => { v.collection<Client>('clients') } })

    const state = await db.openVault('state')
    const firm = await db.openVaultGroup<Client>('firm', {
      registry: state.collection<VaultRegistryRow>('vault-registry'),
      sharding: {
        // Routing follows the upstream-provided placement key; the residency
        // requirement comes from `region` — the guard catches any drift.
        keyOf: (r) => r.placementKey,
        regionOf: (r) => r.region,
        vaultTemplate: 'client',
        autoCreate: true,
      },
    })

    // ── Compliant placement: each client lands on its region's backend ──
    await firm.collection<Client>('clients').put('c1', { id: 'acme', region: 'eu', placementKey: 'eu-acme', name: 'Acme GmbH' })
    await firm.collection<Client>('clients').put('c2', { id: 'globex', region: 'us', placementKey: 'us-globex', name: 'Globex Inc' })

    const acme = await firm.shard('eu-acme')
    expect((await acme.collection<Client>('clients').get('c1'))?.name).toBe('Acme GmbH')

    // The EU client's data physically lives on the EU backend, not the US one.
    expect(store.resolveBackend('firm--eu-acme').capabilities?.region).toBe('eu')
    expect(store.resolveBackend('firm--us-globex').capabilities?.region).toBe('us')

    // ── Non-compliant placement is refused before provisioning ──
    // An EU-required client whose placement key routes to the US backend
    // (an upstream mislabel). The guard refuses it before any vault is made.
    await expect(
      firm.collection<Client>('clients').put('bad', { id: 'bphar', region: 'eu', placementKey: 'us-bphar', name: 'Mislabeled' }),
    ).rejects.toBeInstanceOf(DataResidencyError)

    db.close()
  })
})
