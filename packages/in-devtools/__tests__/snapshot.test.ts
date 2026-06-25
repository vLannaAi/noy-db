/**
 * snapshot() enrichment — #483 Task 5
 *
 * Asserts that snapshot() surfaces describe()-derived fields, per-collection
 * config, per-collection meta, and vault-level meta on InspectorSnapshot.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, money } from '@noy-db/hub'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '@noy-db/hub'
import { ConflictError } from '@noy-db/hub'
import { snapshot } from '../src/snapshot.js'

// ── Minimal in-memory store (same pattern used by inspector.test.ts) ─────────

function memoryStore(): NoydbStore {
  const data = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const coll = (v: string, c: string) => {
    let vm = data.get(v); if (!vm) { vm = new Map(); data.set(v, vm) }
    let cm = vm.get(c); if (!cm) { cm = new Map(); vm.set(c, cm) }
    return cm
  }
  return {
    name: 'memory',
    async get(v, c, id) { return data.get(v)?.get(c)?.get(id) ?? null },
    async put(v, c, id, env, ev) {
      const m = coll(v, c); const ex = m.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      m.set(id, env)
    },
    async delete(v, c, id) { data.get(v)?.get(c)?.delete(id) },
    async list(v, c) { return [...(data.get(v)?.get(c)?.keys() ?? [])] },
    async listVaults() { return [...data.keys()] },
    async loadAll(v) {
      const vm = data.get(v); const snap: VaultSnapshot = {}
      if (vm) for (const [cn, cm] of vm) {
        const r: Record<string, EncryptedEnvelope> = {}
        for (const [id, e] of cm) r[id] = e
        snap[cn] = r
      }
      return snap
    },
    async saveAll() {},
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

async function buildVault() {
  const db = await createNoydb({ store: memoryStore(), user: 'owner', secret: 'pw' })
  const vault = await db.openVault('sales-db', { meta: { label: 'Acme Sales', description: 'All sales data' } })

  // Collection with meta + money field + textIndexes
  vault.collection<{ id: string; total: string; description: string }>('sales', {
    meta: { label: 'Sales' },
    moneyFields: { total: money({ currency: 'USD', scale: 2 }) },
    textIndexes: ['description'],
  })

  return vault
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('snapshot() enrichment (#483 Task 5)', () => {
  it('snapshot includes describe() per-field + config + meta', async () => {
    const vault = await buildVault()
    const snap = await snapshot(vault)

    // Vault-level meta
    expect(snap.meta?.label).toBeDefined()
    expect(snap.meta?.label).toBe('Acme Sales')

    // Collection-level assertions
    const c = snap.collections.find((x) => x.name === 'sales')!
    expect(c).toBeTruthy()

    // CollectionMeta
    expect(c.meta?.label).toBe('Sales')

    // describe() fields — money field → widget === 'money'
    expect(c.described?.some((f) => f.widget === 'money')).toBe(true)

    // config (textIndexes declared)
    expect(c.config).toBeDefined()
    expect(c.config?.textIndexes).toContain('description')
  })

  it('described field for money has semanticType currency', async () => {
    const vault = await buildVault()
    const snap = await snapshot(vault)
    const c = snap.collections.find((x) => x.name === 'sales')!
    const moneyField = c.described?.find((f) => f.key === 'total')
    expect(moneyField?.semanticType).toBe('currency')
    expect(moneyField?.money?.mode).toBe('fixed')
  })

  it('snapshot does not fail for undeclared collections appearing in dumpSchema', async () => {
    // A vault can have collections in the store that were not live-declared
    // (e.g. from a prior open). snapshot() must not throw.
    const db = await createNoydb({ store: memoryStore(), user: 'owner', secret: 'pw' })
    const vault = await db.openVault('v')
    // Declare nothing — the snapshot should still succeed
    const snap = await snapshot(vault)
    expect(snap).toBeDefined()
    expect(snap.collections).toBeInstanceOf(Array)
  })
})
