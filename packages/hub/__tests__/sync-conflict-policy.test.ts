import { describe, it, expect, beforeEach } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot, Conflict } from '../src/types.js'
import { ConflictError } from '../src/errors.js'
import { createNoydb } from '../src/noydb.js'

// ─── Inline memory adapter (same as sync.test.ts) ─────────────────────────

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

interface Note { title: string; body: string }

const COMP = 'COMP-1'

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Inject a conflicting remote envelope for record `id` in `collection`. */
async function seedRemoteConflict(
  remote: NoydbStore,
  collection: string,
  id: string,
  data: string,
  version: number,
) {
  await remote.put(COMP, collection, id, {
    _noydb: 1,
    _v: version,
    _ts: new Date(Date.now() + 100).toISOString(), // remote is newer by timestamp
    _iv: '',
    _data: data,
  })
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('conflictPolicy (v0.9 #131)', () => {
  describe('last-writer-wins', () => {
    it('keeps whichever envelope has the higher _ts', async () => {
      const local = inlineMemory()
      const remote = inlineMemory()

      const db = await createNoydb({ store: local, sync: remote, user: 'u', encrypt: false })
      const comp = await db.openVault(COMP)

      // Local write (lower _ts will win if we control it)
      await comp.collection<Note>('notes', {
        conflictPolicy: 'last-writer-wins',
      }).put('note-1', { title: 'local', body: 'local body' })

      // Inject a remote version with a HIGHER _ts
      const now = new Date()
      const futureTs = new Date(now.getTime() + 5000).toISOString()
      await remote.put(COMP, 'notes', 'note-1', {
        _noydb: 1, _v: 5, _ts: futureTs, _iv: '', _data: JSON.stringify({ title: 'remote', body: 'remote body' }),
      })

      const result = await db.pull(COMP)
      // Conflict detected (remote _v=5 > local _v=1, local is dirty)
      expect(result.conflicts).toHaveLength(1)

      // remote has higher _ts — remote wins
      const localEnv = await local.get(COMP, 'notes', 'note-1')
      expect(JSON.parse(localEnv!._data).title).toBe('remote')
    })

    it('keeps local when local _ts is higher', async () => {
      const local = inlineMemory()
      const remote = inlineMemory()

      const db = await createNoydb({ store: local, sync: remote, user: 'u', encrypt: false })
      const comp = await db.openVault(COMP)
      await comp.collection<Note>('notes', { conflictPolicy: 'last-writer-wins' })
        .put('note-1', { title: 'local', body: '' })

      // Remote has older _ts (past)
      const pastTs = new Date(Date.now() - 5000).toISOString()
      await remote.put(COMP, 'notes', 'note-1', {
        _noydb: 1, _v: 5, _ts: pastTs, _iv: '', _data: JSON.stringify({ title: 'remote', body: '' }),
      })

      await db.pull(COMP)
      const localEnv = await local.get(COMP, 'notes', 'note-1')
      // local _ts >= remote pastTs — local wins (kept, push will sync)
      expect(JSON.parse(localEnv!._data).title).toBe('local')
    })
  })

  describe('first-writer-wins', () => {
    it('keeps the lower _v (earlier version)', async () => {
      const local = inlineMemory()
      const remote = inlineMemory()

      const db = await createNoydb({ store: local, sync: remote, user: 'u', encrypt: false })
      const comp = await db.openVault(COMP)

      // Local write → _v = 1
      await comp.collection<Note>('notes', { conflictPolicy: 'first-writer-wins' })
        .put('note-1', { title: 'first', body: '' })

      // Remote has _v=5 (later version)
      await remote.put(COMP, 'notes', 'note-1', {
        _noydb: 1, _v: 5, _ts: new Date().toISOString(), _iv: '', _data: JSON.stringify({ title: 'later', body: '' }),
      })

      await db.pull(COMP)
      const localEnv = await local.get(COMP, 'notes', 'note-1')
      // local _v=1 <= remote _v=5 → local (earlier) wins
      expect(JSON.parse(localEnv!._data).title).toBe('first')
    })
  })

  describe('manual', () => {
    it('defers conflict when no handler calls resolve', async () => {
      const local = inlineMemory()
      const remote = inlineMemory()

      const db = await createNoydb({ store: local, sync: remote, user: 'u', encrypt: false })
      const comp = await db.openVault(COMP)
      await comp.collection<Note>('notes', { conflictPolicy: 'manual' })
        .put('note-1', { title: 'local', body: '' })

      await remote.put(COMP, 'notes', 'note-1', {
        _noydb: 1, _v: 5, _ts: new Date().toISOString(), _iv: '', _data: JSON.stringify({ title: 'remote', body: '' }),
      })

      // No sync:conflict handler — conflict should be deferred
      const result = await db.pull(COMP)
      expect(result.conflicts).toHaveLength(1)
      // Record unchanged (deferred, local still has v=1 data)
      const localEnv = await local.get(COMP, 'notes', 'note-1')
      expect(JSON.parse(localEnv!._data).title).toBe('local')
    })

    it('resolves with remote when handler calls resolve(remote)', async () => {
      const local = inlineMemory()
      const remote = inlineMemory()

      const db = await createNoydb({ store: local, sync: remote, user: 'u', encrypt: false })
      const comp = await db.openVault(COMP)
      await comp.collection<Note>('notes', { conflictPolicy: 'manual' })
        .put('note-1', { title: 'local', body: '' })

      const remoteEnv: EncryptedEnvelope = {
        _noydb: 1, _v: 5, _ts: new Date().toISOString(), _iv: '', _data: JSON.stringify({ title: 'remote wins', body: '' }),
      }
      await remote.put(COMP, 'notes', 'note-1', remoteEnv)

      // Handler calls resolve(remote) synchronously
      db.on('sync:conflict', (conflict: Conflict) => {
        conflict.resolve?.(conflict.remote)
      })

      const result = await db.pull(COMP)
      expect(result.conflicts).toHaveLength(1)
      const localEnv = await local.get(COMP, 'notes', 'note-1')
      expect(JSON.parse(localEnv!._data).title).toBe('remote wins')
    })

    it('defers when handler calls resolve(null)', async () => {
      const local = inlineMemory()
      const remote = inlineMemory()

      const db = await createNoydb({ store: local, sync: remote, user: 'u', encrypt: false })
      const comp = await db.openVault(COMP)
      await comp.collection<Note>('notes', { conflictPolicy: 'manual' })
        .put('note-1', { title: 'original', body: '' })

      await remote.put(COMP, 'notes', 'note-1', {
        _noydb: 1, _v: 5, _ts: new Date().toISOString(), _iv: '', _data: JSON.stringify({ title: 'remote', body: '' }),
      })

      // Handler defers explicitly
      db.on('sync:conflict', (conflict: Conflict) => {
        conflict.resolve?.(null)
      })

      await db.pull(COMP)
      const localEnv = await local.get(COMP, 'notes', 'note-1')
      // Local unchanged (deferred)
      expect(JSON.parse(localEnv!._data).title).toBe('original')
    })

    it('sync:conflict event carries resolve fn for manual collections', async () => {
      const local = inlineMemory()
      const remote = inlineMemory()

      const db = await createNoydb({ store: local, sync: remote, user: 'u', encrypt: false })
      const comp = await db.openVault(COMP)
      await comp.collection<Note>('notes', { conflictPolicy: 'manual' })
        .put('note-1', { title: 'local', body: '' })

      await remote.put(COMP, 'notes', 'note-1', {
        _noydb: 1, _v: 5, _ts: new Date().toISOString(), _iv: '', _data: '{}',
      })

      const seen: Conflict[] = []
      db.on('sync:conflict', (c) => seen.push(c))
      await db.pull(COMP)

      expect(seen).toHaveLength(1)
      expect(typeof seen[0]!.resolve).toBe('function')
    })
  })

  describe('custom merge fn', () => {
    it('merges fields from both sides and re-encrypts', async () => {
      const local = inlineMemory()
      const remote = inlineMemory()

      const db = await createNoydb({ store: local, sync: remote, user: 'u', encrypt: false })
      const comp = await db.openVault(COMP)

      // Merge fn: combine both bodies
      await comp.collection<Note>('notes', {
        conflictPolicy: (localRec, remoteRec) => ({
          title: localRec.title,
          body: `${localRec.body} | ${remoteRec.body}`,
        }),
      }).put('note-1', { title: 'doc', body: 'local body' })

      await remote.put(COMP, 'notes', 'note-1', {
        _noydb: 1, _v: 5, _ts: new Date().toISOString(), _iv: '', _data: JSON.stringify({ title: 'doc', body: 'remote body' }),
      })

      const result = await db.pull(COMP)
      expect(result.conflicts).toHaveLength(1)

      const localEnv = await local.get(COMP, 'notes', 'note-1')
      const merged = JSON.parse(localEnv!._data) as Note
      expect(merged.body).toBe('local body | remote body')
    })

    it('merged envelope has version higher than both sides', async () => {
      const local = inlineMemory()
      const remote = inlineMemory()

      const db = await createNoydb({ store: local, sync: remote, user: 'u', encrypt: false })
      const comp = await db.openVault(COMP)
      await comp.collection<Note>('notes', {
        conflictPolicy: (l, r) => ({ title: l.title + '+' + r.title, body: '' }),
      }).put('note-1', { title: 'A', body: '' })

      // Remote at v=3
      await remote.put(COMP, 'notes', 'note-1', {
        _noydb: 1, _v: 3, _ts: new Date().toISOString(), _iv: '', _data: JSON.stringify({ title: 'B', body: '' }),
      })

      await db.pull(COMP)
      const localEnv = await local.get(COMP, 'notes', 'note-1')
      // max(1, 3) + 1 = 4
      expect(localEnv!._v).toBe(4)
    })

    it('does not affect collections without conflictPolicy', async () => {
      const local = inlineMemory()
      const remote = inlineMemory()

      // db-level strategy is 'remote-wins'
      const db = await createNoydb({ store: local, sync: remote, user: 'u', encrypt: false, conflict: 'remote-wins' })
      const comp = await db.openVault(COMP)

      // Collection WITHOUT conflictPolicy — uses db-level strategy
      await comp.collection<Note>('notes').put('note-1', { title: 'local', body: '' })
      await remote.put(COMP, 'notes', 'note-1', {
        _noydb: 1, _v: 5, _ts: new Date().toISOString(), _iv: '', _data: JSON.stringify({ title: 'remote', body: '' }),
      })

      await db.pull(COMP)
      const localEnv = await local.get(COMP, 'notes', 'note-1')
      // remote-wins db strategy → remote overwrites local
      expect(JSON.parse(localEnv!._data).title).toBe('remote')
    })
  })
})
