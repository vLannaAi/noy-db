import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { ConflictError } from '../src/kernel/errors.js'
import { createNoydb } from '../src/kernel/noydb.js'
import { withSync } from '../src/with-party/sync/index.js'

// Plaintext memory store — copied from sync-conflict-policy.test.ts's inlineMemory().
function inlineMemory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function gc(c: string, col: string) {
    let comp = store.get(c); if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col); if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
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
      if (comp) for (const [n, coll] of comp) { if (!n.startsWith('_')) { const r: Record<string, EncryptedEnvelope> = {}; for (const [id, e] of coll) r[id] = e; s[n] = r } }
      return s
    },
    async saveAll(c, data) {
      for (const [n, recs] of Object.entries(data)) { const coll = gc(c, n); for (const [id, e] of Object.entries(recs)) coll.set(id, e) }
    },
  }
}

interface Note { title: string }
const V = 'V1'

function liveEnv(data: object, v = 1): EncryptedEnvelope {
  return { _noydb: 1, _v: v, _ts: new Date().toISOString(), _iv: '', _data: JSON.stringify(data) }
}

describe('sync role-gate: push-only sinks are never pulled from (#616)', () => {
  it('db.pull() on a backup-only config is a no-op (does not import from the backup)', async () => {
    const local = inlineMemory(), backup = inlineMemory()
    const db = await createNoydb({ store: local, sync: [{ store: backup, role: 'backup' }], user: 'u', syncStrategy: withSync(), encrypt: false })
    await db.openVault(V)
    await backup.put(V, 'notes', 'x', liveEnv({ title: 'from-backup' }))   // record only on the backup
    const result = await db.pull(V)
    expect(result.pulled).toBe(0)
    expect(await local.get(V, 'notes', 'x')).toBeNull()                    // NOT imported
  })

  it('db.sync() on a backup-only config is push-only', async () => {
    const local = inlineMemory(), backup = inlineMemory()
    const db = await createNoydb({ store: local, sync: [{ store: backup, role: 'backup' }], user: 'u', syncStrategy: withSync(), encrypt: false })
    const v = await db.openVault(V)
    await v.collection<Note>('notes').put('mine', { title: 'local' })      // local record
    await backup.put(V, 'notes', 'theirs', liveEnv({ title: 'from-backup' }))
    const result = await db.sync(V)
    expect(result.pull.pulled).toBe(0)                                     // nothing pulled
    expect(await backup.get(V, 'notes', 'mine')).not.toBeNull()           // local pushed to backup
    expect(await local.get(V, 'notes', 'theirs')).toBeNull()              // backup record NOT pulled
  })

  it('resurrection prevented: a locally-deleted record is not pulled back from a backup', async () => {
    const local = inlineMemory(), backup = inlineMemory()
    const db = await createNoydb({ store: local, sync: [{ store: backup, role: 'backup' }], user: 'u', syncStrategy: withSync(), encrypt: false })
    const v = await db.openVault(V)
    await v.collection<Note>('notes').put('a', { title: 'live' })
    await v.collection<Note>('notes').delete('a')                          // locally deleted (marker under withSync)
    await backup.put(V, 'notes', 'a', liveEnv({ title: 'stale-live' }, 5)) // stale live copy on the backup, higher _v
    await db.pull(V)                                                       // no-op — a sink is never pulled
    expect(await v.collection<Note>('notes').get('a')).toBeNull()         // stays deleted, NOT resurrected
  })

  it('regression: a sync-peer primary still pulls (unchanged)', async () => {
    const local = inlineMemory(), remote = inlineMemory()
    const db = await createNoydb({ store: local, sync: remote, user: 'u', syncStrategy: withSync(), encrypt: false })  // bare store ⇒ sync-peer
    await db.openVault(V)
    await remote.put(V, 'notes', 'x', liveEnv({ title: 'from-peer' }))
    const result = await db.pull(V)
    expect(result.pulled).toBe(1)
    expect(await local.get(V, 'notes', 'x')).not.toBeNull()               // imported
  })

  it('regression: sync-peer primary + backup secondary — primary pulls+pushes, backup push-only', async () => {
    const local = inlineMemory(), remote = inlineMemory(), backup = inlineMemory()
    const db = await createNoydb({
      store: local,
      sync: [{ store: remote, role: 'sync-peer' }, { store: backup, role: 'backup' }],
      user: 'u', syncStrategy: withSync(), encrypt: false,
    })
    const v = await db.openVault(V)
    await v.collection<Note>('notes').put('mine', { title: 'local' })     // local record
    await remote.put(V, 'notes', 'peer', liveEnv({ title: 'from-peer' })) // record on the sync-peer
    await backup.put(V, 'notes', 'sink', liveEnv({ title: 'from-backup' }))
    await db.sync(V)
    expect(await local.get(V, 'notes', 'peer')).not.toBeNull()            // pulled from the sync-peer
    expect(await remote.get(V, 'notes', 'mine')).not.toBeNull()           // pushed to the sync-peer
    expect(await backup.get(V, 'notes', 'mine')).not.toBeNull()           // pushed to the backup
    expect(await local.get(V, 'notes', 'sink')).toBeNull()               // backup secondary NOT pulled from
  })
})
