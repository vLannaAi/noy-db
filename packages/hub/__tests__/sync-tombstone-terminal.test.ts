import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot, ErasureEnforcement } from '../src/kernel/types.js'
import { ConflictError } from '../src/kernel/errors.js'
import { createNoydb } from '../src/kernel/noydb.js'
import { withSync } from '../src/with-party/sync/index.js'
import { withForgetCascade } from '../src/with-audit/forget/index.js'
import { withHistory } from '../src/with-commit/history/index.js'
import { isTombstoneShape } from '../src/kernel/enclave/record-keys/tombstone.js'

/** In-memory store (mirrors the harness in sync.test.ts). */
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

/** A crypto-shred tombstone as `buildTombstone` mints it. */
function tombstoneEnv(v: number, ts = new Date().toISOString()): EncryptedEnvelope {
  return { _noydb: 1, _v: v, _ts: ts, _iv: '', _data: '' }
}

interface Note { body: string; subjectId?: string }
const V = 'V1'

describe('isTombstoneShape', () => {
  it('recognises the buildTombstone shape and nothing else', () => {
    expect(isTombstoneShape(tombstoneEnv(3))).toBe(true)
    // live encrypted envelope: non-empty _data
    expect(isTombstoneShape({ _noydb: 1, _v: 1, _ts: 'x', _iv: 'abc', _data: 'ciphertext' })).toBe(false)
    // unencrypted record envelope: non-empty JSON _data, empty _iv
    expect(isTombstoneShape({ _noydb: 1, _v: 1, _ts: 'x', _iv: '', _data: '{"a":1}' })).toBe(false)
    // _sync meta shape: empty _iv, non-empty _data
    expect(isTombstoneShape({ _noydb: 1, _v: 1, _ts: 'x', _iv: '', _data: '{"dirty":[]}' })).toBe(false)
    // empty _data but a wrapped CEK present → not a shred
    expect(isTombstoneShape({ _noydb: 1, _v: 1, _ts: 'x', _iv: '', _data: '', _cek: 'wrapped' })).toBe(false)
  })
})

describe('pull tombstone-terminal rule (#590)', () => {
  async function setup(conflict?: 'local-wins') {
    const local = inlineMemory(); const remote = inlineMemory()
    const db = await createNoydb({
      store: local, sync: remote, user: 'u', syncStrategy: withSync(), encrypt: false,
      ...(conflict ? { conflict } : {}),
    })
    const vault = await db.openVault(V)
    const notes = vault.collection<Note>('notes')
    return { local, remote, db, notes }
  }

  it('a remote tombstone beats a newer dirty local edit — enforced, dirty dropped, reported, resolver bypassed', async () => {
    const { local, remote, db, notes } = await setup('local-wins')
    await notes.put('n1', { body: 'v1' })
    await db.push(V)                                      // both sides at _v=1
    await notes.put('n1', { body: 'offline edit' })       // dirty, _v=2
    await remote.put(V, 'notes', 'n1', tombstoneEnv(1))   // another device shredded it

    const events: ErasureEnforcement[] = []
    db.on('sync:erasure', e => events.push(e))
    const pull = await db.pull(V)

    expect((await local.get(V, 'notes', 'n1'))!._data).toBe('')  // enforced despite local-wins + higher local _v
    expect(pull.erasures).toHaveLength(1)
    expect(pull.erasures![0]!.direction).toBe('pull')
    expect(pull.erasures![0]!.suppressed._v).toBe(2)
    expect(pull.conflicts).toHaveLength(0)                       // never a resolvable conflict
    expect(events).toHaveLength(1)

    const push = await db.push(V)
    expect(push.pushed).toBe(0)                                  // suppressed edit is not pushed
    db.close()
  })

  it('a remote tombstone over a non-dirty stale copy applies silently (no erasure report)', async () => {
    const { local, remote, db, notes } = await setup()
    await notes.put('n1', { body: 'v1' })
    await db.push(V)                                      // clean
    await remote.put(V, 'notes', 'n1', tombstoneEnv(1))
    const pull = await db.pull(V)
    expect((await local.get(V, 'notes', 'n1'))!._data).toBe('')
    expect(pull.erasures ?? []).toHaveLength(0)
    db.close()
  })

  it('a local tombstone is never overwritten by a higher-_v live remote — re-asserted outward with a bumped _v', async () => {
    const { local, remote, db, notes } = await setup()
    await notes.put('n1', { body: 'v1' })
    await db.push(V)
    const live = (await remote.get(V, 'notes', 'n1'))!
    await local.put(V, 'notes', 'n1', tombstoneEnv(1))    // local shred residue
    await remote.put(V, 'notes', 'n1', { ...live, _v: 3 }) // offline peer's later edit

    const pull = await db.pull(V)

    expect((await local.get(V, 'notes', 'n1'))!._data).toBe('')
    const remoteEnv = (await remote.get(V, 'notes', 'n1'))!
    expect(remoteEnv._data).toBe('')                       // remote re-tombstoned
    expect(remoteEnv._v).toBe(3)                           // bumped to the suppressed _v
    expect((await local.get(V, 'notes', 'n1'))!._v).toBe(3)
    expect(pull.erasures).toHaveLength(1)
    expect(pull.erasures![0]!.suppressed._v).toBe(3)
    db.close()
  })

  it('re-assert at equal _v: remote live copy is tombstoned without a bump', async () => {
    const { local, remote, db, notes } = await setup()
    await notes.put('n1', { body: 'v1' })
    await db.push(V)
    await local.put(V, 'notes', 'n1', tombstoneEnv(1))
    const pull = await db.pull(V)
    const remoteEnv = (await remote.get(V, 'notes', 'n1'))!
    expect(remoteEnv._data).toBe('')
    expect(remoteEnv._v).toBe(1)
    expect(pull.erasures).toHaveLength(1)
    db.close()
  })

  it('both sides tombstoned: higher _v wins, nothing reported', async () => {
    const { local, remote, db } = await setup()
    await local.put(V, 'notes', 'n1', tombstoneEnv(1))
    await remote.put(V, 'notes', 'n1', tombstoneEnv(4))
    const pull = await db.pull(V)
    expect((await local.get(V, 'notes', 'n1'))!._v).toBe(4)
    expect(pull.erasures ?? []).toHaveLength(0)
    db.close()
  })

  it('modifiedSince never skips an arriving tombstone (but still skips old live envelopes)', async () => {
    const { local, remote, db, notes } = await setup()
    await notes.put('n1', { body: 'v1' })
    await notes.put('n2', { body: 'v1' })
    await db.push(V)
    await remote.put(V, 'notes', 'n1', tombstoneEnv(2, '2000-01-01T00:00:00.000Z'))
    const oldLive = (await remote.get(V, 'notes', 'n2'))!
    await remote.put(V, 'notes', 'n2', { ...oldLive, _v: 2, _ts: '2000-01-01T00:00:00.000Z' })

    await db.pull(V, { modifiedSince: '2020-01-01T00:00:00.000Z' })

    expect((await local.get(V, 'notes', 'n1'))!._data).toBe('')  // tombstone exempt from the filter
    expect((await local.get(V, 'notes', 'n2'))!._v).toBe(1)      // old live envelope still filtered
    db.close()
  })
})

describe('push tombstone-terminal rule (#590)', () => {
  async function setup(conflict?: 'local-wins') {
    const local = inlineMemory(); const remote = inlineMemory()
    const db = await createNoydb({
      store: local, sync: remote, user: 'u', syncStrategy: withSync(), encrypt: false,
      ...(conflict ? { conflict } : {}),
    })
    const vault = await db.openVault(V)
    const notes = vault.collection<Note>('notes')
    return { local, remote, db, notes }
  }

  it('a dirty entry whose local envelope is a tombstone pushes unconditionally (no CAS)', async () => {
    const { local, remote, db, notes } = await setup()
    await notes.put('n1', { body: 'v1' })                  // dirty at _v=1
    // remote meanwhile holds a much newer live copy — CAS would refuse
    const liveRemote: EncryptedEnvelope = { _noydb: 1, _v: 9, _ts: new Date().toISOString(), _iv: '', _data: '{"body":"other"}' }
    await remote.put(V, 'notes', 'n1', liveRemote)
    await local.put(V, 'notes', 'n1', tombstoneEnv(1))     // shredded before the push ran

    const push = await db.push(V)

    expect(push.pushed).toBe(1)
    expect((await remote.get(V, 'notes', 'n1'))!._data).toBe('')  // erasure won without CAS
    const again = await db.push(V)
    expect(again.pushed).toBe(0)                                   // entry completed
    db.close()
  })

  it('push ConflictError against a remote tombstone: enforced locally, reported, resolver bypassed', async () => {
    const { local, remote, db, notes } = await setup('local-wins')
    await notes.put('n1', { body: 'v1' })
    await db.push(V)                                       // both at _v=1
    await notes.put('n1', { body: 'offline edit' })        // dirty, _v=2 (CAS expects remote _v=1)
    await remote.put(V, 'notes', 'n1', tombstoneEnv(5))    // shredded elsewhere at _v=5 → CAS mismatch

    const events: ErasureEnforcement[] = []
    db.on('sync:erasure', e => events.push(e))
    const push = await db.push(V)

    expect((await local.get(V, 'notes', 'n1'))!._data).toBe('')   // enforced despite local-wins
    expect(push.erasures).toHaveLength(1)
    expect(push.erasures![0]!.direction).toBe('push')
    expect(push.erasures![0]!.suppressed._v).toBe(2)
    expect(push.conflicts).toHaveLength(0)
    expect(events).toHaveLength(1)
    expect((await db.push(V)).pushed).toBe(0)                     // entry completed, edit never re-pushed
    db.close()
  })
})

describe('end-to-end: forget() + sync (#590 exit criteria)', () => {
  async function setup() {
    const local = inlineMemory(); const remote = inlineMemory()
    const db = await createNoydb({
      store: local, sync: remote, user: 'alice', secret: 'hunter2', syncStrategy: withSync(),
      forgetStrategy: withForgetCascade({ subjects: { notes: 'subjectId' } }),
      historyStrategy: withHistory(),
    })
    const vault = await db.openVault(V)
    const notes = vault.collection<Note>('notes', { perRecordKeys: true })
    return { local, remote, db, vault, notes }
  }

  it('the shred rides the push channel: forget → push tombstones the remote', async () => {
    const { remote, db, vault, notes } = await setup()
    await notes.put('n1', { subjectId: 's1', body: 'secret' })
    await db.push(V)
    await vault.forget('s1')
    await db.push(V)
    const remoteEnv = (await remote.get(V, 'notes', 'n1'))!
    expect(remoteEnv._data).toBe('')
    expect(remoteEnv._cek).toBeUndefined()
    db.close()
  })

  it('exit criteria, order pull-then-push: offline higher-_v edit cannot resurrect; tombstoned everywhere, edit reported', async () => {
    const { local, remote, db, vault, notes } = await setup()
    await notes.put('n1', { subjectId: 's1', body: 'secret' })
    await db.push(V)
    const preShred = (await remote.get(V, 'notes', 'n1'))!   // what offline peer B still holds
    await vault.forget('s1')                                  // ledger-attested shred on A
    await remote.put(V, 'notes', 'n1', { ...preShred, _v: preShred._v + 1 })  // B pushed its edit

    const pull = await db.pull(V)
    await db.push(V)

    expect(await notes.get('n1')).toBeNull()                                  // still erased on A
    expect((await local.get(V, 'notes', 'n1'))!._data).toBe('')
    const remoteEnv = (await remote.get(V, 'notes', 'n1'))!
    expect(remoteEnv._data).toBe('')                                          // remote re-tombstoned
    expect(remoteEnv._cek).toBeUndefined()
    expect(remoteEnv._v).toBe(preShred._v + 1)                                // monotonic counter kept
    expect(pull.erasures).toHaveLength(1)                                     // B's edit reported, not applied
    db.close()
  })

  it('exit criteria, order push-then-pull: same convergence', async () => {
    const { local, remote, db, vault, notes } = await setup()
    await notes.put('n1', { subjectId: 's1', body: 'secret' })
    await db.push(V)
    const preShred = (await remote.get(V, 'notes', 'n1'))!
    await vault.forget('s1')
    await remote.put(V, 'notes', 'n1', { ...preShred, _v: preShred._v + 1 })

    await db.push(V)     // unconditional tombstone assertion overwrites B's copy
    await db.pull(V)

    expect(await notes.get('n1')).toBeNull()
    expect((await local.get(V, 'notes', 'n1'))!._data).toBe('')
    expect((await remote.get(V, 'notes', 'n1'))!._data).toBe('')
    db.close()
  })
})

describe('sync-applied writes refresh the Collection cache (#598)', () => {
  it('a pull-applied newer envelope is visible through collection.get without a re-open', async () => {
    const local = inlineMemory(); const remote = inlineMemory()
    const db = await createNoydb({ store: local, sync: remote, user: 'u', syncStrategy: withSync(), encrypt: false })
    const vault = await db.openVault(V)
    const notes = vault.collection<Note>('notes')
    await notes.put('n1', { body: 'v1' })
    await db.push(V)
    expect((await notes.get('n1'))!.body).toBe('v1')          // cache warm

    const env = (await remote.get(V, 'notes', 'n1'))!
    const newer = { ...env, _v: 2, _data: JSON.stringify({ ...JSON.parse(env._data), body: 'v2-from-remote' }) }
    await remote.put(V, 'notes', 'n1', newer)
    await db.pull(V)

    expect((await notes.get('n1'))!.body).toBe('v2-from-remote')  // stale cache would still say v1
    db.close()
  })

  it('an enforced tombstone is immediately unreadable through collection.get (no decrypted residue in memory)', async () => {
    const local = inlineMemory(); const remote = inlineMemory()
    const db = await createNoydb({ store: local, sync: remote, user: 'alice', secret: 'hunter2', syncStrategy: withSync() })
    const vault = await db.openVault(V)
    const notes = vault.collection<Note>('notes', { perRecordKeys: true })
    await notes.put('n1', { subjectId: 's1', body: 'secret' })
    await db.push(V)
    expect((await notes.get('n1'))!.body).toBe('secret')      // cache warm with decrypted record

    await remote.put(V, 'notes', 'n1', tombstoneEnv(1))       // shredded on another device
    await db.pull(V)

    expect(await notes.get('n1')).toBeNull()                  // enforced AND evicted
    db.close()
  })
})
