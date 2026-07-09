/**
 * Write-path convergence (#589, Task 3): under sync, `delete()` leaves a
 * version-ordered `_del` marker instead of a physical removal, so the
 * deletion is visible to other pullers (a bare `adapter.delete` is
 * invisible on pull). Mirrors the #590 sync/tombstone test harness (see
 * docs/superpowers/plans/2026-07-09-delete-tombstone-convergence.md
 * "Shared test harness"). Later tasks append `describe` blocks here.
 */
import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { ConflictError } from '../src/kernel/errors.js'
import { createNoydb } from '../src/kernel/noydb.js'
import { withSync } from '../src/with-party/sync/index.js'
import { isDeleteMarker } from '../src/kernel/enclave/record-keys/tombstone.js'

/** In-memory store exposing raw stored envelopes for white-box assertions. */
function memory(): NoydbStore & { raw(c: string, col: string, id: string): EncryptedEnvelope | undefined } {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function gc(c: string, col: string) {
    let comp = store.get(c); if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col); if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    raw(c, col, id) { return store.get(c)?.get(col)?.get(id) },
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

interface Note { body: string }
const V = 'V1'

describe('delete() writes a marker under sync (#589)', () => {
  it('synced delete leaves a version-bumped _del marker, not a physical removal', async () => {
    const local = memory(); const remote = memory()
    const db = await createNoydb({ store: local, sync: remote, user: 'alice', syncStrategy: withSync(), encrypt: false })
    const vault = await db.openVault(V)
    const notes = vault.collection<Note>('notes')
    await notes.put('n1', { body: 'v1' })            // live at _v=1
    await notes.delete('n1')

    const raw = local.raw(V, 'notes', 'n1')
    expect(raw).toBeDefined()                         // NOT physically removed
    expect(isDeleteMarker(raw!)).toBe(true)
    expect(raw!._v).toBe(2)                           // existing._v (1) + 1
    expect(await notes.get('n1')).toBeNull()          // reads absent (Task 2)
    db.close()
  })

  it('non-synced delete stays physical (no marker, zero regression)', async () => {
    const store = memory()
    const db = await createNoydb({ store, user: 'u', encrypt: false })   // no sync target
    const vault = await db.openVault(V)
    const notes = vault.collection<Note>('notes')
    await notes.put('n1', { body: 'v1' })
    await notes.delete('n1')
    expect(store.raw(V, 'notes', 'n1')).toBeUndefined()   // physically gone
    db.close()
  })

  it('delete of an already-deleted (marked) record is a no-op', async () => {
    const local = memory(); const remote = memory()
    const db = await createNoydb({ store: local, sync: remote, user: 'u', syncStrategy: withSync(), encrypt: false })
    const notes = (await db.openVault(V)).collection<Note>('notes')
    await notes.put('n1', { body: 'v1' })
    await notes.delete('n1')
    const after1 = local.raw(V, 'notes', 'n1')!
    await notes.delete('n1')                          // second delete
    expect(local.raw(V, 'notes', 'n1')!._v).toBe(after1._v)   // unchanged, no re-marker
    db.close()
  })
})

describe('re-create version continuity (#589)', () => {
  it('a put after a synced delete continues from the marker version (not reset to 1)', async () => {
    const local = memory(); const remote = memory()
    const db = await createNoydb({ store: local, sync: remote, user: 'u', syncStrategy: withSync(), encrypt: false })
    const notes = (await db.openVault(V)).collection<Note>('notes')
    await notes.put('n1', { body: 'v1' })        // _v=1
    await notes.delete('n1')                      // marker _v=2
    await notes.put('n1', { body: 're-created' }) // must be _v=3, NOT _v=1

    const raw = local.raw(V, 'notes', 'n1')!
    expect(isDeleteMarker(raw)).toBe(false)       // live again
    expect(raw._v).toBe(3)                        // marker._v (2) + 1
    expect((await notes.get('n1'))!.body).toBe('re-created')
    db.close()
  })
})

describe('delete convergence on pull (#589)', () => {
  async function twoPeers(conflict?: 'local-wins') {
    const localA = memory(); const localB = memory(); const remote = memory()
    const dbA = await createNoydb({ store: localA, sync: remote, user: 'a', syncStrategy: withSync(), encrypt: false, ...(conflict ? { conflict } : {}) })
    const dbB = await createNoydb({ store: localB, sync: remote, user: 'b', syncStrategy: withSync(), encrypt: false, ...(conflict ? { conflict } : {}) })
    return { localA, localB, remote, dbA, dbB }
  }

  it('the core bug: a delete on A converges to B on pull', async () => {
    const { dbA, dbB } = await twoPeers()
    const a = (await dbA.openVault(V)).collection<Note>('notes')
    await a.put('n1', { body: 'v1' }); await dbA.push(V)
    const b = (await dbB.openVault(V)).collection<Note>('notes')
    await dbB.pull(V); expect((await b.get('n1'))!.body).toBe('v1')   // B has it

    await a.delete('n1'); await dbA.push(V)                            // A deletes → marker _v=2 pushed
    await dbB.pull(V)
    expect(await b.get('n1')).toBeNull()                              // B converges to deleted
    dbA.close(); dbB.close()
  })

  it('re-create at a higher version resurrects on pull', async () => {
    const { dbA, dbB } = await twoPeers()
    const a = (await dbA.openVault(V)).collection<Note>('notes')
    // dbB must open the vault (which registers its sync engine) before its first pull.
    const b = (await dbB.openVault(V)).collection<Note>('notes')
    await a.put('n1', { body: 'v1' }); await a.delete('n1'); await a.put('n1', { body: 'reborn' })  // marker _v=2, live _v=3
    await dbA.push(V); await dbB.pull(V)
    expect((await b.get('n1'))!.body).toBe('reborn')
    dbA.close(); dbB.close()
  })

  it('concurrent same-version delete-vs-edit: delete wins by default (no resolver)', async () => {
    const { dbA, dbB } = await twoPeers()
    const a = (await dbA.openVault(V)).collection<Note>('notes')
    await a.put('n1', { body: 'v1' }); await dbA.push(V)
    const b = (await dbB.openVault(V)).collection<Note>('notes')
    await dbB.pull(V)                                                 // both at _v=1
    await a.delete('n1'); await dbA.push(V)                           // A: marker _v=2 on remote
    await b.put('n1', { body: 'edited' })                            // B: live _v=2 locally (same _v as marker)
    await dbB.pull(V)                                                 // remote marker _v=2 vs local live _v=2 → tie
    expect(await b.get('n1')).toBeNull()                             // delete wins
    dbA.close(); dbB.close()
  })

  it('same-version tie with a per-collection resolver that keeps the edit → record survives', async () => {
    // Adapted from the brief's literal `conflictPolicy: (_id, local, remote) => ...`: the real
    // `ConflictPolicy<T>` custom-merge-fn shape is `(local: T, remote: T) => T` over DECRYPTED
    // records, and collection.ts's wrapper (kernel/collection.ts ~903-916) decrypts both sides
    // first and short-circuits to whichever side decrypts to null — a delete marker always
    // decrypts to null — so a custom-fn policy can never override delete-wins; the mergeFn is
    // never even invoked when one side is a marker. `'manual'` is the one policy that hands the
    // resolver the raw envelopes untouched (via the `sync:conflict` event's `resolve` callback),
    // so it's the real way to register "keep the edit over the marker".
    const localA = memory(); const localB = memory(); const remote = memory()
    const dbA = await createNoydb({ store: localA, sync: remote, user: 'a', syncStrategy: withSync(), encrypt: false })
    const dbB = await createNoydb({ store: localB, sync: remote, user: 'b', syncStrategy: withSync(), encrypt: false })
    const a = (await dbA.openVault(V)).collection<Note>('notes')
    const b = (await dbB.openVault(V)).collection<Note>('notes', { conflictPolicy: 'manual' })
    dbB.on('sync:conflict', conflict => {
      conflict.resolve?.(isDeleteMarker(conflict.local) ? conflict.remote : conflict.local)
    })
    await a.put('n1', { body: 'v1' }); await dbA.push(V); await dbB.pull(V)   // both _v=1
    await a.delete('n1'); await dbA.push(V)                                    // A: marker _v=2
    await b.put('n1', { body: 'edited' })                                     // B: live _v=2
    await dbB.pull(V)                                                          // tie → resolver keeps edit
    expect((await b.get('n1'))!.body).toBe('edited')
    dbA.close(); dbB.close()
  })

  it('modifiedSince partial pull never skips an arriving delete marker', async () => {
    const { remote, dbA, dbB } = await twoPeers()
    const a = (await dbA.openVault(V)).collection<Note>('notes')
    // dbB must open the vault (which registers its sync engine) before its first pull.
    const b = (await dbB.openVault(V)).collection<Note>('notes')
    await a.put('n1', { body: 'v1' }); await dbA.push(V); await dbB.pull(V)
    await a.delete('n1'); await dbA.push(V)
    // Backdate the remote marker's _ts to before the cutoff:
    const m = remote.raw(V, 'notes', 'n1')!
    await remote.put(V, 'notes', 'n1', { ...m, _ts: '2000-01-01T00:00:00.000Z' })
    await dbB.pull(V, { modifiedSince: '2020-01-01T00:00:00.000Z' })  // old marker must NOT be skipped
    expect(await b.get('n1')).toBeNull()
    dbA.close(); dbB.close()
  })

  it('a delete marker never overrides a forget tombstone (forget outranks delete)', async () => {
    // local forget tombstone vs incoming delete marker → forget stays
    const local = memory(); const remote = memory()
    const db = await createNoydb({ store: local, sync: remote, user: 'u', secret: 'hunter2', syncStrategy: withSync(),
      historyStrategy: (await import('../src/with-commit/history/index.js')).withHistory(),
      forgetStrategy: (await import('../src/with-audit/forget/index.js')).withForgetCascade({ subjects: { notes: 'subjectId' } }) })
    const notes = (await db.openVault(V)).collection<Note & { subjectId?: string }>('notes', { perRecordKeys: true })
    await notes.put('n1', { body: 'secret', subjectId: 's1' }); await db.push(V)
    const preShred = local.raw(V, 'notes', 'n1')!
    await (await db.openVault(V)).forget('s1')                        // local forget tombstone
    await remote.put(V, 'notes', 'n1', { ...preShred, _v: preShred._v + 1, _iv: '', _data: '', _del: true }) // incoming delete marker
    await db.pull(V)
    expect(isDeleteMarker(local.raw(V, 'notes', 'n1')!)).toBe(false)  // still the forget tombstone, not overwritten
    db.close()
  })
})
