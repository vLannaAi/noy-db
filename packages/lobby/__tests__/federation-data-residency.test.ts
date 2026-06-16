/**
 * VaultGroup data-residency placement guard (#271).
 * sharding.regionOf + StoreCapabilities.region + DataResidencyError, on top
 * of routeStore vault-prefix routing.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot, StoreCapabilities } from '@noy-db/hub'
import { ConflictError, DataResidencyError } from '@noy-db/hub'
import { routeStore } from '@noy-db/hub/store'
import { createNoydb } from '@noy-db/hub'
import type { Vault } from '@noy-db/hub'
import type { VaultRegistryRow } from '../src/federation/index.js'
import { createLobby } from '../src/index.js'

function memory(region?: string): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function gc(c: string, col: string) {
    let comp = store.get(c); if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col); if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  const capabilities: StoreCapabilities = { casAtomic: false, auth: { kind: 'none', required: false, flow: 'static' }, ...(region ? { region } : {}) }
  return {
    name: `memory${region ? `-${region}` : ''}`,
    capabilities,
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

// A record carries its required region; `routeKey` lets a test deliberately
// drive a routing/region MISMATCH (key routes one way, regionOf says another).
interface Doc extends Record<string, unknown> { id: string; region: string; routeKey?: string }

async function harness() {
  // Region-encoded shard ids: `firm--eu-*` → EU backend, `firm--us-*` → US.
  const eu = memory('eu')
  const us = memory('us')
  const control = memory() // no region — the registry/state vault lives here
  const store = routeStore({ vaultRoutes: { 'firm--eu-': eu, 'firm--us-': us }, default: control })
  const db = await createNoydb({ store, user: 'operator', secret: 'op-pass' })
  const lobby = createLobby(db)
  lobby.withVaultTemplate('client', { version: 1, configure: (v: Vault) => { v.collection<Doc>('docs') } })
  const stateVault = await db.openVault('state')
  const registry = stateVault.collection<VaultRegistryRow>('vault-registry')
  const firm = await lobby.openVaultGroup<Doc>('firm', {
    registry,
    sharding: {
      keyOf: (r) => r.routeKey ?? `${r.region}-${r.id}`,
      regionOf: (r) => r.region,
      vaultTemplate: 'client',
      autoCreate: true,
    },
  })
  return { db, firm, eu, us }
}

describe('VaultGroup data-residency placement guard (#271)', () => {
  let h: Awaited<ReturnType<typeof harness>>
  beforeEach(async () => { h = await harness() })

  it('allows a shard whose placement backend region matches regionOf', async () => {
    await h.firm.collection<Doc>('docs').put('a1', { id: 'acme', region: 'eu' }) // key eu-acme → firm--eu-acme → EU
    const acme = await h.firm.shard('eu-acme')
    expect((await acme.collection<Doc>('docs').get('a1'))?.region).toBe('eu')
  })

  it('refuses a shard landing on a wrong-region backend (DataResidencyError, before provisioning)', async () => {
    // routeKey 'us-acme' routes to the US backend, but regionOf says 'eu' → mismatch.
    await expect(
      h.firm.collection<Doc>('docs').put('x1', { id: 'acme', region: 'eu', routeKey: 'us-acme' }),
    ).rejects.toBeInstanceOf(DataResidencyError)
    // Nothing was provisioned.
    await expect(h.firm.shard('us-acme')).rejects.toThrow()
  })

  it('refuses when the backend declares no region at all', async () => {
    // key 'xx-acme' matches neither prefix → default (control, no region); regionOf 'eu' → mismatch.
    await expect(
      h.firm.collection<Doc>('docs').put('y1', { id: 'acme', region: 'eu', routeKey: 'xx-acme' }),
    ).rejects.toBeInstanceOf(DataResidencyError)
  })

  it('is a no-op without regionOf — placement unguarded', async () => {
    const eu = memory('eu')
    const store = routeStore({ vaultRoutes: { 'plain--': eu }, default: memory() })
    const db = await createNoydb({ store, user: 'op', secret: 'op-pass' })
    const lobby = createLobby(db)
    lobby.withVaultTemplate('client', { version: 1, configure: (v: Vault) => { v.collection<Doc>('docs') } })
    const sv = await db.openVault('state')
    const firm = await lobby.openVaultGroup<Doc>('plain', {
      registry: sv.collection<VaultRegistryRow>('vault-registry'),
      sharding: { keyOf: (r) => r.id, vaultTemplate: 'client', autoCreate: true }, // no regionOf
    })
    await firm.collection<Doc>('docs').put('z1', { id: 'acme', region: 'eu' }) // no guard → succeeds
    expect((await (await firm.shard('acme')).collection<Doc>('docs').get('z1'))?.id).toBe('acme')
    db.close()
  })

  it('resolveBackend maps a vault id to its region-correct backend', () => {
    const eu = memory('eu'), us = memory('us'), def = memory()
    const store = routeStore({ vaultRoutes: { 'firm--eu-': eu, 'firm--us-': us }, default: def })
    expect(store.resolveBackend('firm--eu-acme').capabilities?.region).toBe('eu')
    expect(store.resolveBackend('firm--us-globex').capabilities?.region).toBe('us')
    expect(store.resolveBackend('firm--xx-foo').capabilities?.region).toBeUndefined()
  })
})
