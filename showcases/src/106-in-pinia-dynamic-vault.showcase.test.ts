/**
 * Showcase 106 — in-pinia dynamic vault resolver (federation routing)
 *
 * What you'll learn
 * ─────────────────
 * `defineNoydbStore({ vault })` accepts a **resolver** — `() => string` —
 * evaluated at access time, so one logical store can follow the app's
 * active scope into a per-client shard vault. Drill into `/clients/C2`
 * and the same `useDisbursements` store re-binds to that client's vault
 * and re-hydrates, with no per-shard store instances.
 *
 *   1. `vault: () => 'clients-' + code.value` — reactive resolver.
 *   2. Flipping the scope ref re-opens the new vault and refreshes items.
 *   3. Writes land in whichever vault is currently resolved.
 *   4. A plain `vault: 'x'` string keeps working unchanged.
 *
 * Why it matters
 * ──────────────
 * Per-client vault federation shards data into one vault per client. A
 * fixed `vault: string` can't follow the focused client; the resolver lets
 * every existing store opt into federation routing with a one-line change.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 38 (in-pinia).
 *
 * Spec mapping
 * ────────────
 * features.yaml → frameworks → in-pinia
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { ref } from 'vue'
import { createNoydb } from '@noy-db/hub'
import { defineNoydbStore, setActiveNoydb } from '@noy-db/in-pinia'
import { memory } from '@noy-db/to-memory'

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface Disbursement { id: string; amount: number; client: string }

describe('Showcase 106 — in-pinia dynamic vault resolver', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('follows the active client scope into its shard vault', async () => {
    const db = await createNoydb({ store: memory(), user: 'a', secret: 'sc106' })
    setActiveNoydb(db)

    // Seed two per-client shard vaults.
    const c1 = await db.openVault('clients-C1')
    await c1.collection<Disbursement>('disbursements').put('d1', { id: 'd1', amount: 100, client: 'C1' })
    const c2 = await db.openVault('clients-C2')
    await c2.collection<Disbursement>('disbursements').put('d2', { id: 'd2', amount: 200, client: 'C2' })

    // The active client (e.g. from the route) drives the resolver.
    const clientCode = ref('C1')
    const useDisbursements = defineNoydbStore<Disbursement>('disbursements', {
      vault: () => `clients-${clientCode.value}`,
    })

    const store = useDisbursements()
    await store.$ready
    expect(store.items.map((d) => d.id)).toEqual(['d1'])

    // Navigate to client C2 → the store re-binds to clients-C2 and re-hydrates.
    clientCode.value = 'C2'
    for (let n = 0; n < 50 && store.items[0]?.id !== 'd2'; n++) await tick(10)
    expect(store.items.map((d) => d.id)).toEqual(['d2'])

    // A new disbursement is written into the currently-focused client's vault.
    await store.add('d3', { id: 'd3', amount: 50, client: 'C2' })
    const stillC2 = await db.openVault('clients-C2')
    expect((await stillC2.collection<Disbursement>('disbursements').list()).map((d) => d.id).sort())
      .toEqual(['d2', 'd3'])
    // C1's vault is untouched.
    const stillC1 = await db.openVault('clients-C1')
    expect((await stillC1.collection<Disbursement>('disbursements').list()).map((d) => d.id)).toEqual(['d1'])

    db.close()
  })
})
