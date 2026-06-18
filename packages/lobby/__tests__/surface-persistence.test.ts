import { describe, it, expect } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '@noy-db/hub'
import { ConflictError } from '@noy-db/hub'
import { StateManagementVault } from '../src/federation/state-vault.js'
import type { SurfaceRow } from '../src/federation/types.js'

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

const baseSurface: SurfaceRow = {
  id: 'surf-001',
  collections: ['clients', 'invoices'],
  direction: 'push',
  conflictPolicy: { strategy: 'take-incoming' },
  status: 'proposed',
  proposedBy: 'partyA',
  createdAt: 1_000_000,
}

describe('StateManagementVault — surfaces collection', () => {
  it('createSurface + getSurface round-trips the full row', async () => {
    const db = await createNoydb({ store: memory(), user: 'op', encrypt: false })
    const sv = await StateManagementVault.open(db)

    await sv.createSurface(baseSurface)
    const retrieved = await sv.getSurface('surf-001')

    expect(retrieved).not.toBeNull()
    expect(retrieved?.id).toBe('surf-001')
    expect(retrieved?.collections).toEqual(['clients', 'invoices'])
    expect(retrieved?.direction).toBe('push')
    expect(retrieved?.status).toBe('proposed')
    expect(retrieved?.proposedBy).toBe('partyA')
    expect(retrieved?.createdAt).toBe(1_000_000)
    expect(retrieved?.conflictPolicy.strategy).toBe('take-incoming')
  })

  it('listSurfaces returns all persisted surfaces', async () => {
    const db = await createNoydb({ store: memory(), user: 'op', encrypt: false })
    const sv = await StateManagementVault.open(db)

    const s2: SurfaceRow = { ...baseSurface, id: 'surf-002', proposedBy: 'partyB' }
    await sv.createSurface(baseSurface)
    await sv.createSurface(s2)

    const list = await sv.listSurfaces()
    expect(list.length).toBe(2)
    const ids = list.map((r) => r.id)
    expect(ids).toContain('surf-001')
    expect(ids).toContain('surf-002')
  })

  it('updateSurface patches status and agreedBy', async () => {
    const db = await createNoydb({ store: memory(), user: 'op', encrypt: false })
    const sv = await StateManagementVault.open(db)

    await sv.createSurface(baseSurface)
    const updated = await sv.updateSurface('surf-001', { status: 'agreed', agreedBy: 'partyB' })

    expect(updated.status).toBe('agreed')
    expect(updated.agreedBy).toBe('partyB')
    // unchanged fields are preserved
    expect(updated.id).toBe('surf-001')
    expect(updated.direction).toBe('push')
    expect(updated.proposedBy).toBe('partyA')

    // persisted correctly
    const reread = await sv.getSurface('surf-001')
    expect(reread?.status).toBe('agreed')
    expect(reread?.agreedBy).toBe('partyB')
  })

  it('getSurface returns null for unknown id', async () => {
    const db = await createNoydb({ store: memory(), user: 'op', encrypt: false })
    const sv = await StateManagementVault.open(db)
    expect(await sv.getSurface('no-such-surface')).toBeNull()
  })

  it('persists optional fields: fields, cadenceMs, lastSyncAt, nextSyncDueAt', async () => {
    const db = await createNoydb({ store: memory(), user: 'op', encrypt: false })
    const sv = await StateManagementVault.open(db)

    const full: SurfaceRow = {
      ...baseSurface,
      id: 'surf-full',
      fields: { clients: ['name', 'email'] },
      cadenceMs: 60_000,
      lastSyncAt: 2_000_000,
      nextSyncDueAt: 2_060_000,
    }
    await sv.createSurface(full)
    const got = await sv.getSurface('surf-full')
    expect(got?.fields).toEqual({ clients: ['name', 'email'] })
    expect(got?.cadenceMs).toBe(60_000)
    expect(got?.lastSyncAt).toBe(2_000_000)
    expect(got?.nextSyncDueAt).toBe(2_060_000)
  })

  it('surfaces collection is isolated from existing SMV collections', async () => {
    const db = await createNoydb({ store: memory(), user: 'op', encrypt: false })
    const sv = await StateManagementVault.open(db)

    await sv.createSurface(baseSurface)
    // registry, schemaManifest, events are untouched
    expect(await sv.registry.get('surf-001')).toBeNull()
    expect(await sv.schemaManifest.get('surf-001')).toBeNull()
    expect((await sv.queryEvents().toArray()).length).toBe(0)
  })
})
