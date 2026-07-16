/**
 * #709 — tiers × indexing. Elevated records leave tier-0 indexes: their
 * persisted sidecars hold PLAINTEXT field values under the tier-0 DEK
 * (collection-facade.ts:370-377 + record-codec.ts:257), so leaving them in
 * place means elevating a record never hid what it was indexed by. Mirrors
 * the forget() → purgePersistedIndexes precedent (facade:426-429).
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, ConflictError } from '../src/index.js'
import { withTiers } from '../src/with-audit/tiers/index.js'
import { withIndexing } from '../src/with-lookup/indexing/index.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/index.js'

interface Emp {
  id: string
  salary: number
}

// Copied verbatim from hierarchical-tiers.test.ts.
function memoryStore(): NoydbStore {
  const data = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const getColl = (v: string, c: string): Map<string, EncryptedEnvelope> => {
    let vm = data.get(v); if (!vm) { vm = new Map(); data.set(v, vm) }
    let cm = vm.get(c); if (!cm) { cm = new Map(); vm.set(c, cm) }
    return cm
  }
  return {
    name: 'memory',
    async get(v, c, id) { return data.get(v)?.get(c)?.get(id) ?? null },
    async put(v, c, id, env, ev) {
      const coll = getColl(v, c); const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(v, c, id) { data.get(v)?.get(c)?.delete(id) },
    async list(v, c) { return [...(data.get(v)?.get(c)?.keys() ?? [])] },
    async loadAll(v) {
      const vm = data.get(v); const snap: VaultSnapshot = {}
      if (vm) for (const [cn, cm] of vm) {
        const r: Record<string, EncryptedEnvelope> = {}
        for (const [id, e] of cm) r[id] = e
        snap[cn] = r
      }
      return snap
    },
    async saveAll(v, snap) {
      const vm = new Map<string, Map<string, EncryptedEnvelope>>()
      for (const [cn, recs] of Object.entries(snap)) {
        const cm = new Map<string, EncryptedEnvelope>()
        for (const [id, e] of Object.entries(recs)) cm.set(id, e)
        vm.set(cn, cm)
      }
      data.set(v, vm)
    },
  }
}

const SECRET = 'tiers-indexing-passphrase-2026'

/**
 * A lazy, tiered, indexed collection: `prefetch: false` (side-cars are
 * durable, not just an in-memory mirror) + `tiers: [0, 1]` + `indexes:
 * ['salary']` + `perRecordKeys: true` (a record CEK exists to warm-cache —
 * without it there is no warm leak to pin, see the design brief).
 */
function lazyIndexedHarness() {
  const store = memoryStore()
  return {
    store,
    async open() {
      const db = await createNoydb({
        store,
        user: 'owner',
        secret: SECRET,
        indexStrategy: withIndexing(),
        tiersStrategy: withTiers(),
      })
      const vault = await db.openVault('v1')
      const docs = vault.collection<Emp>('docs', {
        prefetch: false,
        cache: { maxRecords: 100 },
        indexes: ['salary'],
        tiers: [0, 1],
        perRecordKeys: true,
      })
      return { db, vault, docs }
    },
  }
}

async function openLazyIndexed() {
  const h = lazyIndexedHarness()
  const opened = await h.open()
  return { store: h.store, ...opened }
}

describe('#709 facade loops skip elevated records', () => {
  it('rebuildIndexes: warm session must NOT mint a tier-0 sidecar from an elevated record', async () => {
    const { store, docs } = await openLazyIndexed()
    await docs.put('e1', { id: 'e1', salary: 200000 })
    await docs.elevate('e1', 1)                              // warm: seeds the CEK cache
    await docs.rebuildIndexes()
    // Pre-#709: the warm cekCache let the ungated decrypt succeed and MINTED a
    // tier-0-encrypted sidecar holding the elevated record's salary.
    expect(await store.get('v1', 'docs', '_idx/salary/e1')).toBeNull()
  })

  it('rebuildIndexes: cold session survives an elevated record (was a brick)', async () => {
    const h = lazyIndexedHarness()
    const { docs } = await h.open()
    await docs.put('e1', { id: 'e1', salary: 200000 })
    await docs.put('t0', { id: 't0', salary: 50000 })
    await docs.elevate('e1', 1)
    const cold = await h.open()
    // Pre-#709: unwrapCek under the tier-0 DEK threw → rebuildIndexes() bricked.
    await expect(cold.docs.rebuildIndexes()).resolves.not.toThrow()
    expect(await h.store.get('v1', 'docs', '_idx/salary/t0')).not.toBeNull()  // tier-0 sibling still indexed
  })

  it('reconcileIndex: does not re-create a purged sidecar for an elevated record', async () => {
    const { store, docs } = await openLazyIndexed()
    await docs.put('e1', { id: 'e1', salary: 200000 })
    await docs.elevate('e1', 1)
    await docs.reconcileIndex('salary')
    expect(await store.get('v1', 'docs', '_idx/salary/e1')).toBeNull()
  })
})
