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
import { isDeleteMarker, buildDeleteMarker } from '../src/kernel/enclave/record-keys/tombstone.js'

/**
 * In-memory store exposing raw stored envelopes for white-box assertions,
 * plus a `_getCalls`/`_getCallsFor`/`_resetCounters()` set (pattern ported
 * from lazy-hydration.test.ts) so #606's perf fix — skip the redundant
 * `adapter.get` on a genuinely-new insert — can be proven by call count,
 * not just by behavior. `_getCallsFor(col, id)` isolates reads to the
 * collection/id under test, since a single `put()` also drives unrelated
 * store reads (the schema-fence check on every write, the sync engine's
 * one-time `_sync/meta` load) that must not be mistaken for the #606 gate.
 */
function toMemory(): NoydbStore & {
  raw(c: string, col: string, id: string): EncryptedEnvelope | undefined
  _getCalls: number
  _getCallsFor(col: string, id: string): number
  _resetCounters(): void
} {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  const calls: { col: string; id: string }[] = []
  function gc(c: string, col: string) {
    let comp = store.get(c); if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col); if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    raw(c, col, id) { return store.get(c)?.get(col)?.get(id) },
    get _getCalls() { return calls.length },
    _getCallsFor(col, id) { return calls.filter(x => x.col === col && x.id === id).length },
    _resetCounters() { calls.length = 0 },
    async get(c, col, id) {
      calls.push({ col, id })
      return store.get(c)?.get(col)?.get(id) ?? null
    },
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
    const local = toMemory(); const remote = toMemory()
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
    const store = toMemory()
    const db = await createNoydb({ store, user: 'u', encrypt: false })   // no sync target
    const vault = await db.openVault(V)
    const notes = vault.collection<Note>('notes')
    await notes.put('n1', { body: 'v1' })
    await notes.delete('n1')
    expect(store.raw(V, 'notes', 'n1')).toBeUndefined()   // physically gone
    db.close()
  })

  it('delete of an already-deleted (marked) record is a no-op', async () => {
    const local = toMemory(); const remote = toMemory()
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
    const local = toMemory(); const remote = toMemory()
    const db = await createNoydb({ store: local, sync: remote, user: 'u', syncStrategy: withSync(), encrypt: false })
    const notes = (await db.openVault(V)).collection<Note>('notes')
    await notes.put('n1', { body: 'v1' })        // _v=1
    await notes.delete('n1')                      // marker _v=2

    // #606: the re-create put MUST still consult the store here — this is the
    // one case the marker-id set exists to let through. A regression that made
    // the gate "always skip" would silently reintroduce #589 (version resets
    // to 1 instead of continuing past the marker).
    local._resetCounters()
    await notes.put('n1', { body: 're-created' }) // must be _v=3, NOT _v=1
    expect(local._getCallsFor('notes', 'n1')).toBeGreaterThan(0)

    const raw = local.raw(V, 'notes', 'n1')!
    expect(isDeleteMarker(raw)).toBe(false)       // live again
    expect(raw._v).toBe(3)                        // marker._v (2) + 1
    expect((await notes.get('n1'))!.body).toBe('re-created')
    db.close()
  })

  it('#606 perf: a genuinely-new insert into a synced eager collection never reads the store', async () => {
    const local = toMemory(); const remote = toMemory()
    const db = await createNoydb({ store: local, sync: remote, user: 'u', syncStrategy: withSync(), encrypt: false })
    const notes = (await db.openVault(V)).collection<Note>('notes')

    local._resetCounters()
    await notes.put('brand-new', { body: 'v1' })
    // No marker was ever recorded for this id, so the #589 continuity gate
    // must not fall back to an `adapter.get` — that unconditional read is
    // exactly what #606 removes for the common (non-re-create) insert case.
    // (Filtered to this id: a synced put legitimately touches the store for
    // unrelated reasons — the schema-fence check, the sync engine's one-time
    // `_sync/meta` load — which must not be mistaken for the #606 gate.)
    expect(local._getCallsFor('notes', 'brand-new')).toBe(0)
    db.close()
  })

  it('#606: hydration from a store with a pre-existing marker seeds the marker-id set — a re-create on a fresh instance still continues the version', async () => {
    const local = toMemory(); const remote = toMemory()
    // Seed the raw store directly with a delete marker BEFORE any Collection
    // ever opens it — simulates a cold session / process restart where the
    // marker landed on disk in a previous run (or via another peer's sync
    // write) and this instance's `ensureHydrated()` is the ONLY thing that
    // can discover it, as opposed to a live delete populating the set.
    await local.put(V, 'notes', 'n1', buildDeleteMarker(2, 'peer'))

    const db = await createNoydb({ store: local, sync: remote, user: 'u', syncStrategy: withSync(), encrypt: false })
    const notes = (await db.openVault(V)).collection<Note>('notes')

    // Confirm the marker reads as absent before touching it (sanity check
    // that hydration filtered it out of the eager cache, as #589 requires).
    expect(await notes.get('n1')).toBeNull()

    // The put's own `ensureHydrated()` call is what discovers the marker on
    // this fresh instance; the re-create must continue past it (_v=3), not
    // reset to 1 — proving `markerIds` was populated by hydration, not just
    // by a live local delete.
    await notes.put('n1', { body: 're-created' })
    const raw = local.raw(V, 'notes', 'n1')!
    expect(isDeleteMarker(raw)).toBe(false)
    expect(raw._v).toBe(3) // marker._v (2) + 1, NOT reset to 1
    expect((await notes.get('n1'))!.body).toBe('re-created')
    db.close()
  })

  it('#606: a second put to the same id right after a re-create does not consult-then-read again', async () => {
    const local = toMemory(); const remote = toMemory()
    const db = await createNoydb({ store: local, sync: remote, user: 'u', syncStrategy: withSync(), encrypt: false })
    const notes = (await db.openVault(V)).collection<Note>('notes')
    await notes.put('n1', { body: 'v1' })
    await notes.delete('n1')
    await notes.put('n1', { body: 're-created' }) // marker consulted; markerIds.delete('n1') must fire here

    local._resetCounters()
    await notes.put('n1', { body: 'edited-again' }) // live, cached record — no store read expected
    expect(local._getCallsFor('notes', 'n1')).toBe(0)
    db.close()
  })
})

describe('delete convergence on pull (#589)', () => {
  async function twoPeers(conflict?: 'local-wins') {
    const localA = toMemory(); const localB = toMemory(); const remote = toMemory()
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
    const localA = toMemory(); const localB = toMemory(); const remote = toMemory()
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

  it('push-channel tie, marker-pushed-first: a concurrent edit pushed after a marker converges to deleted (#589 review Fix 1)', async () => {
    const { remote, dbA, dbB } = await twoPeers()
    const a = (await dbA.openVault(V)).collection<Note>('notes')
    const b = (await dbB.openVault(V)).collection<Note>('notes')
    await a.put('n1', { body: 'v1' }); await dbA.push(V)
    await dbB.pull(V)                                   // A and B both at _v=1

    await a.delete('n1'); await dbA.push(V)              // A: marker _v=2 pushed → remote is the marker
    expect(isDeleteMarker(remote.raw(V, 'notes', 'n1')!)).toBe(true)

    await b.put('n1', { body: 'edited' })                // B: live _v=2 locally, WITHOUT pulling first
    await dbB.push(V)                                    // B's CAS fails against the remote marker (push-channel tie)

    // B converges to deleted (does not force its edit onto the remote marker)
    expect(isDeleteMarker(remote.raw(V, 'notes', 'n1')!)).toBe(true)
    expect(await b.get('n1')).toBeNull()

    await dbA.pull(V)                                     // A pulls — still deleted
    expect(await a.get('n1')).toBeNull()
    dbA.close(); dbB.close()
  })

  it('push-channel tie, edit-pushed-first: a concurrent delete pushed after an edit still wins (#589 review Fix 1)', async () => {
    const { remote, dbA, dbB } = await twoPeers()
    const a = (await dbA.openVault(V)).collection<Note>('notes')
    const b = (await dbB.openVault(V)).collection<Note>('notes')
    await a.put('n1', { body: 'v1' }); await dbA.push(V)
    await dbB.pull(V)                                   // A and B both at _v=1

    await b.put('n1', { body: 'edited' }); await dbB.push(V)   // B: live edit _v=2 pushed → remote is the live edit
    expect(isDeleteMarker(remote.raw(V, 'notes', 'n1')!)).toBe(false)

    await a.delete('n1')                                  // A: marker _v=2 locally, WITHOUT pulling first
    await dbA.push(V)                                     // A's CAS fails against the remote edit (push-channel tie)

    // Delete wins: A force-overwrites the remote with its marker
    expect(isDeleteMarker(remote.raw(V, 'notes', 'n1')!)).toBe(true)

    await dbB.pull(V)
    expect(await b.get('n1')).toBeNull()
    dbA.close(); dbB.close()
  })

  it('a delete marker never overrides a forget tombstone (forget outranks delete)', async () => {
    // local forget tombstone vs incoming delete marker → forget stays
    const local = toMemory(); const remote = toMemory()
    const db = await createNoydb({ store: local, sync: remote, user: 'u', secret: 'hunter2', syncStrategy: withSync(),
      historyStrategy: (await import('../src/with-commit/history/index.js')).withHistory(),
      forgetStrategy: (await import('../src/with-audit/forget/index.js')).withForget({ subjects: { notes: 'subjectId' } }) })
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

describe('_purgeDeleteMarkers seam (#589 → #604)', () => {
  it('physically removes only delete markers older than the cutoff; leaves live + newer', async () => {
    const local = toMemory(); const remote = toMemory()
    const db = await createNoydb({ store: local, sync: remote, user: 'u', syncStrategy: withSync(), encrypt: false })
    const vault = await db.openVault(V)
    const notes = vault.collection<Note>('notes')
    await notes.put('keep', { body: 'live' })                         // live, never purged
    await notes.put('old', { body: 'x' }); await notes.delete('old')  // old marker
    await notes.put('new', { body: 'y' })                             // (deleted below, after cutoff)

    // Backdate the 'old' marker in the raw store to before the cutoff:
    const oldM = local.raw(V, 'notes', 'old')!
    await local.put(V, 'notes', 'old', { ...oldM, _ts: '2000-01-01T00:00:00.000Z' })
    await notes.delete('new')                                          // 'new' marker at now

    const removed = await (vault as unknown as { _purgeDeleteMarkers(b: string, c?: string[]): Promise<number> })
      ._purgeDeleteMarkers('2020-01-01T00:00:00.000Z')

    expect(removed).toBe(1)
    expect(local.raw(V, 'notes', 'old')).toBeUndefined()             // purged
    expect(isDeleteMarker(local.raw(V, 'notes', 'new')!)).toBe(true) // newer marker kept
    expect(local.raw(V, 'notes', 'keep')).toBeDefined()             // live kept
    db.close()
  })
})
