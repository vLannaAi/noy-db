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
