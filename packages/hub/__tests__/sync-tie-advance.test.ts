/**
 * #936 — a local-wins resolution write must SUPERSEDE the remote, not
 * overwrite it in place. Before this fix, a same-`_v` push tie (both
 * peers edited from the same base) force-put the winner's envelope at the
 * TIED version: winner and loser then sat at the same `_v` with different
 * content, and the loser's next pull saw no delta (`_v`-based detection)
 * — the peers stayed silently diverged until an unrelated write bumped
 * past the tie (pinned by the simulation-sync suite when #927 landed).
 *
 * The fix: when the winning local envelope's `_v` does not already exceed
 * the remote's, the engine re-stamps it at `remote._v + 1` for the forced
 * remote put AND mirrors the same advanced envelope locally, so the loser
 * sees a genuine version advance and converges through the ordinary pull
 * path. (`_v` is envelope metadata — AEAD-unbound, and `_vdig` is
 * deliberately `_v`-independent — so the engine may restamp ciphertext.
 * The 'merged' branch already stamps `max(local, remote) + 1`.)
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/index.js'
import { withSync } from '../src/with-sync/index.js'
import type { EncryptedEnvelope, NoydbStore, VaultSnapshot } from '../src/kernel/types.js'
import { ConflictError } from '../src/kernel/errors.js'

const COMP = 'acme'

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

interface Note extends Record<string, unknown> { title: string }

describe('#936 — local-wins tie resolution advances the version', () => {
  it('a same-_v push tie lands the winner at remote._v + 1, mirrored locally', async () => {
    const local = inlineMemory()
    const remote = inlineMemory()
    const db = await createNoydb({ store: local, sync: remote, user: 'u', syncStrategy: withSync(), encrypt: false })
    const comp = await db.openVault(COMP)
    const notes = comp.collection<Note>('notes')

    await notes.put('note-1', { title: 'base' })
    await db.push(COMP)
    // A concurrent peer advanced the remote to the SAME version this
    // instance is about to push (both edited from v1).
    const behind = (await remote.get(COMP, 'notes', 'note-1'))!
    await remote.put(COMP, 'notes', 'note-1', { ...behind, _v: 2, _data: JSON.stringify({ title: 'peer v2' }) })
    await notes.put('note-1', { title: 'local v2' })

    const result = await db.push(COMP)
    expect(result.errors).toEqual([])
    expect(result.conflicts).toHaveLength(1)

    // The winner's content SUPERSEDES the tie: remote at v3, and the local
    // store mirrors the advanced envelope so both sides agree.
    const remoteEnv = (await remote.get(COMP, 'notes', 'note-1'))!
    expect(JSON.parse(remoteEnv._data).title).toBe('local v2')
    expect(remoteEnv._v).toBe(3)
    expect((await local.get(COMP, 'notes', 'note-1'))!._v).toBe(3)
  })

  it('the losing peer converges on its next pull instead of staying silently diverged', async () => {
    const remote = inlineMemory()
    const localA = inlineMemory()
    const localB = inlineMemory()
    const deviceA = await createNoydb({ store: localA, sync: remote, user: 'u', syncStrategy: withSync(), encrypt: false })
    const deviceB = await createNoydb({ store: localB, sync: remote, user: 'u', syncStrategy: withSync(), encrypt: false })
    const notesA = (await deviceA.openVault(COMP)).collection<Note>('notes')
    const notesB = (await deviceB.openVault(COMP)).collection<Note>('notes')

    // Both devices hold v1, then edit concurrently from the same base.
    await notesA.put('note-1', { title: 'base' })
    await deviceA.push(COMP)
    await deviceB.pull(COMP)
    await notesA.put('note-1', { title: 'A v2' })
    await notesB.put('note-1', { title: 'B v2' })

    // A pushes first (remote v2). B's push ties and wins (default 'version'
    // policy, local >= remote → local) — landing at v3, not v2.
    await deviceA.push(COMP)
    const pushB = await deviceB.push(COMP)
    expect(pushB.errors).toEqual([])
    expect(pushB.conflicts).toHaveLength(1)

    // The loser's pull now SEES the advance and adopts the winner.
    const pullA = await deviceA.pull(COMP)
    expect(pullA.pulled).toBe(1)
    for (const store of [localA, localB, remote]) {
      const env = (await store.get(COMP, 'notes', 'note-1'))!
      expect(env._v).toBe(3)
      expect(JSON.parse(env._data).title).toBe('B v2')
    }
  })
})
