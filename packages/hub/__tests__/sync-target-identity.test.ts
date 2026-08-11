/**
 * #1035 — two sync targets that share a role and carry no `label` collided in
 * the engine map, and the second silently evicted the first.
 *
 * The evicted engine was not inert: `startScheduler()` ran on it *after* the
 * `set()`, so it kept its own timer while being unreachable from every fan-out
 * path (dirty tracking, `sync()`, `listSyncTargets()`). Configuring two backups
 * therefore produced one replica plus a store that merely looked configured —
 * with no error, no event, and an introspection API that agreed with the loss.
 *
 * `label` is documented as cosmetic ("for DevTools and audit logs"), so the fix
 * keys engines by their position in the `sync` array rather than promoting
 * `label` to load-bearing. Position is also the stable per-target identity that
 * #1034's `syncTargetStatus()` will need.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/index.js'
import { withSync } from '../src/with-sync/index.js'
import type { NoydbStore, EncryptedEnvelope } from '../src/kernel/types.js'

type ProbeStore = NoydbStore & { records: (vault: string, coll: string) => string[] }

function toMemory(): ProbeStore {
  const data = new Map<string, EncryptedEnvelope>()
  const k = (v: string, c: string, i: string) => `${v}/${c}/${i}`
  return {
    records: (v, c) => [...data.keys()].filter(key => key.startsWith(`${v}/${c}/`)).sort(),
    capabilities: { casAtomic: true, auth: { kind: 'none', required: false, flow: 'static' } },
    async get(v, c, i) { return data.get(k(v, c, i)) ?? null },
    async put(v, c, i, env) { data.set(k(v, c, i), env) },
    async delete(v, c, i) { data.delete(k(v, c, i)) },
    async list(v, c) {
      const prefix = `${v}/${c}/`
      return [...data.keys()].filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length))
    },
    async loadAll(v) {
      const out: Record<string, Record<string, EncryptedEnvelope>> = {}
      for (const [key, env] of data) {
        const [vn, cn, id] = key.split('/')
        if (vn === v && cn !== undefined && id !== undefined) {
          out[cn] = out[cn] ?? {}
          out[cn]![id] = env
        }
      }
      return out
    },
    async saveAll(v, payload) {
      for (const c of Object.keys(payload)) {
        for (const i of Object.keys(payload[c]!)) data.set(k(v, c, i), payload[c]![i]!)
      }
    },
  }
}

const SECRET = 'sync-target-identity-1035'

async function open(sync: NonNullable<Parameters<typeof createNoydb>[0]['sync']>) {
  const db = await createNoydb({
    store: toMemory(), user: 'u', secret: SECRET, validateSecret: false,
    syncStrategy: withSync(), sync,
  })
  const vault = await db.openVault('v')
  return { db, vault }
}

describe('#1035 — per-target engine identity', () => {
  it('two UNLABELLED backups each receive the data', async () => {
    const b1 = toMemory()
    const b2 = toMemory()
    const { db, vault } = await open([
      { store: toMemory(), role: 'sync-peer', label: 'peer' },
      { store: b1, role: 'backup' },
      { store: b2, role: 'backup' },
    ])
    await vault.collection('t').put('r1', { id: 'r1', n: 1 })
    await db.sync('v')

    expect(b1.records('v', 't')).toEqual(['v/t/r1'])
    expect(b2.records('v', 't')).toEqual(['v/t/r1'])
  })

  it('two targets sharing an identical label are still distinct engines', async () => {
    // Duplicate labels collided for the same reason. Keying by position means a
    // label is free to be non-unique, matching its documented cosmetic role.
    const b1 = toMemory()
    const b2 = toMemory()
    const { db, vault } = await open([
      { store: toMemory(), role: 'sync-peer', label: 'peer' },
      { store: b1, role: 'backup', label: 'offsite' },
      { store: b2, role: 'backup', label: 'offsite' },
    ])
    await vault.collection('t').put('r1', { id: 'r1', n: 1 })
    await db.sync('v')

    expect(b1.records('v', 't')).toEqual(['v/t/r1'])
    expect(b2.records('v', 't')).toEqual(['v/t/r1'])
  })

  it('listSyncTargets() reports every configured target', async () => {
    const { db } = await open([
      { store: toMemory(), role: 'sync-peer', label: 'peer' },
      { store: toMemory(), role: 'backup' },
      { store: toMemory(), role: 'backup' },
      { store: toMemory(), role: 'archive' },
    ])
    const targets = db.listSyncTargets('v')

    expect(targets).toHaveLength(4)
    expect(targets.filter(t => t.role === 'backup')).toHaveLength(2)
    expect(targets.filter(t => t.role === 'archive')).toHaveLength(1)
  })

  it('dirty tracking reaches every colliding target, not just the survivor', async () => {
    // The eviction broke the `onDirty` fan-out, so the lost engine never even
    // learned a record had changed. Two writes with one sync between them
    // exercises tracking rather than a single flush.
    const b1 = toMemory()
    const b2 = toMemory()
    const { db, vault } = await open([
      { store: toMemory(), role: 'sync-peer', label: 'peer' },
      { store: b1, role: 'backup' },
      { store: b2, role: 'backup' },
    ])
    await vault.collection('t').put('r1', { id: 'r1', n: 1 })
    await db.sync('v')
    await vault.collection('t').put('r2', { id: 'r2', n: 2 })
    await db.sync('v')

    expect(b1.records('v', 't')).toEqual(['v/t/r1', 'v/t/r2'])
    expect(b2.records('v', 't')).toEqual(['v/t/r1', 'v/t/r2'])
  })

  it('the primary stays addressable by vault name', async () => {
    // push/pull/sync/syncStatus all resolve the primary via `get(vault)`, so the
    // primary's key must NOT move to the positional scheme.
    const peer = toMemory()
    const { db, vault } = await open([
      { store: peer, role: 'sync-peer', label: 'peer' },
      { store: toMemory(), role: 'backup' },
    ])
    await vault.collection('t').put('r1', { id: 'r1', n: 1 })
    await db.push('v')

    expect(peer.records('v', 't')).toEqual(['v/t/r1'])
    expect(db.syncStatus('v').lastPush).not.toBeNull()
  })

  it('a single unlabelled target is unaffected', async () => {
    // The common shape: one bare store. Nothing about it should change.
    const remote = toMemory()
    const { db, vault } = await open(remote)
    await vault.collection('t').put('r1', { id: 'r1', n: 1 })
    await db.sync('v')

    expect(remote.records('v', 't')).toEqual(['v/t/r1'])
    expect(db.listSyncTargets('v')).toHaveLength(1)
  })

  it('lockVault() stops every engine for the vault, not just the primary', async () => {
    // `lockVault` deleted only `syncEngines.get(vault)`, leaving each secondary
    // engine in the map with its scheduler still running — so re-opening the
    // vault stacked a second set of timers on top of the abandoned ones.
    const { db } = await open([
      { store: toMemory(), role: 'sync-peer', label: 'peer' },
      { store: toMemory(), role: 'backup' },
      { store: toMemory(), role: 'backup' },
    ])
    expect(db.listSyncTargets('v')).toHaveLength(3)

    db.lockVault('v')

    expect(db.listSyncTargets('v')).toHaveLength(0)
  })
})
