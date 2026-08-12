/**
 * #1034 — per-target sync state.
 *
 * The consumer case: a three-tier topology (local, LAN share, cloud replica)
 * that must render "the LAN store is unavailable — synchronisation is
 * continuing via the cloud". `syncStatus()` cannot express that: it reads only
 * the primary engine, so `dirty`/`lastPush`/`lastPull` are one target's answer
 * presented as the vault's.
 */
import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { ConflictError } from '../src/kernel/errors.js'
import { createNoydb } from '../src/kernel/noydb.js'
import { withSync } from '../src/with-sync/index.js'

interface Doc { n: number }

function memStore(opts: { failWrites?: boolean } = {}): NoydbStore {
  const data = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const gc = (v: string, c: string) => {
    let vault = data.get(v); if (!vault) { vault = new Map(); data.set(v, vault) }
    let coll = vault.get(c); if (!coll) { coll = new Map(); vault.set(c, coll) }
    return coll
  }
  return {
    async get(v, c, id) { return data.get(v)?.get(c)?.get(id) ?? null },
    async put(v, c, id, env, ev) {
      if (opts.failWrites) throw new Error('EHOSTUNREACH: target is down')
      const coll = gc(v, c); const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(v, c, id) { data.get(v)?.get(c)?.delete(id) },
    async list(v, c) { const x = data.get(v)?.get(c); return x ? [...x.keys()] : [] },
    async loadAll(v) {
      const vault = data.get(v); const snap: VaultSnapshot = {}
      if (vault) for (const [n, coll] of vault) {
        if (n.startsWith('_')) continue
        const recs: Record<string, EncryptedEnvelope> = {}
        for (const [id, e] of coll) recs[id] = e
        snap[n] = recs
      }
      return snap
    },
    async saveAll(v, snap) {
      for (const [n, recs] of Object.entries(snap)) {
        const coll = gc(v, n)
        for (const [id, e] of Object.entries(recs)) coll.set(id, e)
      }
    },
  }
}

const VAULT = 'acme'

describe('#1034 — syncTargetStatus()', () => {
  it('1. reports one row per target, not one answer for the vault', async () => {
    const db = await createNoydb({
      store: memStore(),
      syncStrategy: withSync(),
      user: 'u', secret: 's',
      sync: [
        { store: memStore(), role: 'sync-peer', label: 'lan' },
        { store: memStore(), role: 'backup', label: 'cloud' },
      ],
    })
    await db.openVault(VAULT)

    const rows = db.syncTargetStatus(VAULT)
    expect(rows.length).toBeGreaterThanOrEqual(2)
    expect(rows.map(r => r.label)).toEqual(expect.arrayContaining(['lan', 'cloud']))
  })

  it('2. every row carries the fields a status list needs', async () => {
    const db = await createNoydb({
      store: memStore(),
      syncStrategy: withSync(),
      user: 'u', secret: 's',
      sync: [{ store: memStore(), role: 'sync-peer', label: 'lan' }],
    })
    await db.openVault(VAULT)

    for (const r of db.syncTargetStatus(VAULT)) {
      expect(r).toMatchObject({
        role: expect.any(String),
        dirty: expect.any(Number),
        caughtUp: expect.any(Boolean),
      })
      expect(['string', 'object']).toContain(typeof r.lastPush)   // string | null
      expect(['string', 'object']).toContain(typeof r.lastPull)
    }
  })

  it('3. deliberately carries no per-target `online` flag', async () => {
    // `SyncStatus.online` is the BROWSER's connectivity, set only by the global
    // online/offline events — no store outcome changes it. Surfacing it per
    // target would make a global signal look per-target. Pinned so it is not
    // "helpfully" added later.
    const db = await createNoydb({
      store: memStore(),
      syncStrategy: withSync(),
      user: 'u', secret: 's',
      sync: [{ store: memStore(), role: 'sync-peer', label: 'lan' }],
    })
    await db.openVault(VAULT)

    for (const r of db.syncTargetStatus(VAULT)) {
      expect(r).not.toHaveProperty('online')
    }
    // ...while the vault-wide answer still has it.
    expect(db.syncStatus(VAULT)).toHaveProperty('online')
  })

  it('4. caughtUp tracks the target\'s own dirty log', async () => {
    const db = await createNoydb({
      store: memStore(),
      syncStrategy: withSync(),
      user: 'u', secret: 's',
      sync: [{ store: memStore(), role: 'sync-peer', label: 'lan' }],
    })
    const vault = await db.openVault(VAULT)
    await vault.collection<Doc>('docs').put('d1', { n: 1 })

    for (const r of db.syncTargetStatus(VAULT)) {
      expect(r.caughtUp).toBe(r.dirty === 0)
    }
  })

  it('5. an unknown vault returns an empty list rather than throwing', async () => {
    const db = await createNoydb({ store: memStore(), syncStrategy: withSync(), user: 'u', secret: 's' })
    expect(db.syncTargetStatus('never-opened')).toEqual([])
  })

  it('6. a failing target does not hide the healthy one — the point of the API', async () => {
    const db = await createNoydb({
      store: memStore(),
      syncStrategy: withSync(),
      user: 'u', secret: 's',
      sync: [
        { store: memStore({ failWrites: true }), role: 'sync-peer', label: 'lan-down' },
        { store: memStore(), role: 'backup', label: 'cloud-up' },
      ],
    })
    const vault = await db.openVault(VAULT)
    await vault.collection<Doc>('docs').put('d1', { n: 1 })
    await db.sync(VAULT).catch(() => undefined)

    const rows = db.syncTargetStatus(VAULT)
    const labels = rows.map(r => r.label)
    expect(labels).toEqual(expect.arrayContaining(['lan-down', 'cloud-up']))
    // Both are still enumerable and independently inspectable — a consumer can
    // render one row per target instead of invalidating the whole view.
    expect(rows.every(r => typeof r.dirty === 'number')).toBe(true)
  })
})
