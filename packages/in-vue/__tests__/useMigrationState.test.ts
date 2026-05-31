import { describe, it, expect } from 'vitest'
import { effectScope } from 'vue'
import {
  createNoydb,
  ConflictError,
  type Noydb,
  type NoydbStore,
  type EncryptedEnvelope,
  type VaultSnapshot,
} from '@noy-db/hub'
import { useMigrationState } from '../src/useMigrationState.js'

function memory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function bucket(v: string, c: string) {
    let comp = store.get(v); if (!comp) { comp = new Map(); store.set(v, comp) }
    let coll = comp.get(c); if (!coll) { coll = new Map(); comp.set(c, coll) }
    return coll
  }
  return {
    name: 'memory',
    async get(v, c, id) { return store.get(v)?.get(c)?.get(id) ?? null },
    async put(v, c, id, env, ev) {
      const b = bucket(v, c)
      const ex = b.get(id)
      if (ev !== undefined && (ex?._v ?? 0) !== ev) throw new ConflictError(ex?._v ?? 0)
      b.set(id, env)
    },
    async delete(v, c, id) { bucket(v, c).delete(id) },
    async list(v, c) { return [...bucket(v, c).keys()] },
    async loadAll(v) {
      const comp = store.get(v); const s: VaultSnapshot = {}
      if (comp) for (const [n, coll] of comp) {
        const r: Record<string, EncryptedEnvelope> = {}
        for (const [id, e] of coll) r[id] = e
        s[n] = r
      }
      return s
    },
    async saveAll(v, data) {
      for (const [n, recs] of Object.entries(data)) {
        const b = bucket(v, n)
        for (const [id, e] of Object.entries(recs)) b.set(id, e)
      }
    },
  }
}

/** Write the plaintext fence envelope directly (the shape saveFence produces). */
async function seedFence(store: NoydbStore, vault: string, currentSchemaVersion: number, fenceState: string) {
  await store.put(vault, '_meta', 'schema-fence', {
    _noydb: 1, _v: 1, _ts: new Date(0).toISOString(), _iv: '',
    _data: JSON.stringify({ currentSchemaVersion, fenceState }),
  } as EncryptedEnvelope)
}

async function open(store: NoydbStore): Promise<Noydb> {
  return createNoydb({ store, user: 'a', secret: 'mig-state-pass-1234' })
}

describe('useMigrationState', () => {
  it('seeds from the live fence on mount (including a non-normal state)', async () => {
    const store = memory()
    const db = await open(store)
    await db.openVault('demo')
    await seedFence(store, 'demo', 2, 'draining')

    const scope = effectScope()
    const state = scope.run(() => useMigrationState(db, 'demo'))!
    await new Promise((r) => setTimeout(r, 0)) // let the async seed resolve
    expect(state.fenceState.value).toBe('draining')
    expect(state.schemaVersion.value).toBe(2)
    scope.stop()
  })

  it('updates the refs when schema:fence-changed fires', async () => {
    const store = memory()
    const db = await open(store)
    const vault = await db.openVault('demo')
    await seedFence(store, 'demo', 2, 'draining')

    const scope = effectScope()
    const state = scope.run(() => useMigrationState(db, 'demo'))!
    await new Promise((r) => setTimeout(r, 0))
    expect(state.fenceState.value).toBe('draining')

    // abort emits schema:fence-changed { fenceState: 'normal', currentSchemaVersion: 2 }
    await vault.abortSchemaCutover()
    expect(state.fenceState.value).toBe('normal')
    expect(state.schemaVersion.value).toBe(2)
    scope.stop()
  })

  it('ignores events for a different vault', async () => {
    const store = memory()
    const db = await open(store)
    const vault = await db.openVault('demo')
    const scope = effectScope()
    const state = scope.run(() => useMigrationState(db, 'other'))! // watching a different vault
    await new Promise((r) => setTimeout(r, 0))
    await vault.abortSchemaCutover() // fires for 'demo', not 'other'
    expect(state.fenceState.value).toBe('normal') // unchanged default
    expect(state.schemaVersion.value).toBe(0)
    scope.stop()
  })

  it('unsubscribes on scope dispose (no update after stop)', async () => {
    const store = memory()
    const db = await open(store)
    const vault = await db.openVault('demo')
    await seedFence(store, 'demo', 3, 'draining')
    const scope = effectScope()
    const state = scope.run(() => useMigrationState(db, 'demo'))!
    await new Promise((r) => setTimeout(r, 0))
    expect(state.fenceState.value).toBe('draining')
    scope.stop()
    await vault.abortSchemaCutover() // emitted after dispose → handler removed
    expect(state.fenceState.value).toBe('draining') // unchanged
  })
})
