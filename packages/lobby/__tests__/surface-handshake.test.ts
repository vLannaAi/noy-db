import { describe, it, expect } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '@noy-db/hub'
import { ConflictError } from '@noy-db/hub'
import { StateManagementVault } from '../src/federation/state-vault.js'
import type { SurfaceDirection, SurfaceConflictPolicy } from '../src/federation/types.js'
import {
  proposeSurface,
  agreeSurface,
  SurfaceNotFoundError,
  SurfaceStateError,
} from '../src/interchange/surface.js'
import type { SurfaceDefinition } from '../src/interchange/surface.js'

function memory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function gc(c: string, col: string) {
    let comp = store.get(c); if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col); if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    name: 'memory',
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

const baseDef: SurfaceDefinition = {
  collections: ['clients', 'invoices'],
  direction: 'push' as SurfaceDirection,
  conflictPolicy: { strategy: 'take-incoming' } as SurfaceConflictPolicy,
}

describe('Surface propose/agree bilateral handshake', () => {
  it('proposeSurface writes a status:proposed SurfaceRow', async () => {
    const store = memory()
    const dbA = await createNoydb({ store, user: 'op', encrypt: false })
    const smvA = await StateManagementVault.open(dbA)

    const now = 1_000_000
    const row = await proposeSurface(smvA, baseDef, 'partyA', now)

    expect(row.status).toBe('proposed')
    expect(row.proposedBy).toBe('partyA')
    expect(row.createdAt).toBe(now)
    expect(row.collections).toEqual(['clients', 'invoices'])
    expect(row.direction).toBe('push')
    expect(typeof row.id).toBe('string')
    expect(row.id.length).toBeGreaterThan(0)
    expect(row.agreedBy).toBeUndefined()
  })

  it('proposeSurface uses provided id when def.id is set', async () => {
    const store = memory()
    const dbA = await createNoydb({ store, user: 'op', encrypt: false })
    const smvA = await StateManagementVault.open(dbA)

    const row = await proposeSurface(smvA, { ...baseDef, id: 'my-surface-id' }, 'partyA', 1_000_000)
    expect(row.id).toBe('my-surface-id')
  })

  it('two parties over a shared store: party B sees proposed surface and can agree', async () => {
    // Two Noydb instances over the SAME store (same pattern as federation-fleet-migration "session 2")
    const store = memory()
    const dbA = await createNoydb({ store, user: 'op', encrypt: false })
    const dbB = await createNoydb({ store, user: 'op', encrypt: false })

    const smvA = await StateManagementVault.open(dbA)
    const smvB = await StateManagementVault.open(dbB)

    const now1 = 1_000_000
    const now2 = 1_001_000

    // Party A proposes
    const proposed = await proposeSurface(smvA, baseDef, 'partyA', now1)
    expect(proposed.status).toBe('proposed')

    // Party B opens same SMV and can read the proposed surface
    const seen = await smvB.getSurface(proposed.id)
    expect(seen).not.toBeNull()
    expect(seen?.status).toBe('proposed')

    // Party B agrees
    const agreed = await agreeSurface(smvB, proposed.id, 'partyB', now2)
    expect(agreed.status).toBe('agreed')
    expect(agreed.agreedBy).toBe('partyB')
    expect(agreed.proposedBy).toBe('partyA')
    expect(agreed.id).toBe(proposed.id)

    // A third fresh Noydb over the same store sees the agreed state persisted correctly.
    // (Two separate Noydb instances share the same store but each has its own
    // in-memory eager cache — a fresh open is the correct way to verify persistence.)
    const dbC = await createNoydb({ store, user: 'op', encrypt: false })
    const smvC = await StateManagementVault.open(dbC)
    const reread = await smvC.getSurface(proposed.id)
    expect(reread?.status).toBe('agreed')
    expect(reread?.agreedBy).toBe('partyB')
  })

  it('agreeSurface on a missing id throws SurfaceNotFoundError', async () => {
    const store = memory()
    const dbB = await createNoydb({ store, user: 'op', encrypt: false })
    const smvB = await StateManagementVault.open(dbB)

    await expect(agreeSurface(smvB, 'no-such-id', 'partyB', 1_000_000)).rejects.toThrow(SurfaceNotFoundError)
  })

  it('agreeSurface on an already-agreed surface throws SurfaceStateError', async () => {
    const store = memory()
    const dbA = await createNoydb({ store, user: 'op', encrypt: false })
    const smvA = await StateManagementVault.open(dbA)

    const proposed = await proposeSurface(smvA, baseDef, 'partyA', 1_000_000)
    // First agree succeeds
    await agreeSurface(smvA, proposed.id, 'partyB', 1_001_000)
    // Second agree must throw SurfaceStateError (already agreed, not proposed)
    await expect(agreeSurface(smvA, proposed.id, 'partyC', 1_002_000)).rejects.toThrow(SurfaceStateError)
  })

  it('agreeSurface on a suspended surface throws SurfaceStateError', async () => {
    const store = memory()
    const dbA = await createNoydb({ store, user: 'op', encrypt: false })
    const smvA = await StateManagementVault.open(dbA)

    const proposed = await proposeSurface(smvA, baseDef, 'partyA', 1_000_000)
    // Manually patch to suspended
    await smvA.updateSurface(proposed.id, { status: 'suspended' })

    await expect(agreeSurface(smvA, proposed.id, 'partyB', 1_001_000)).rejects.toThrow(SurfaceStateError)
  })
})
