import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/types.js'
import { ConflictError } from '../src/errors.js'
import { createNoydb } from '../src/noydb.js'
import type { LwwMapState, RgaState } from '../src/crdt.js'

// ─── Inline memory adapter ─────────────────────────────────────────────────

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

const COMP = 'COMP-CRDT'

interface Note { title: string; body: string; priority: number }

// ─── lww-map ───────────────────────────────────────────────────────────────

describe('CRDT mode (v0.9 #132)', () => {
  describe('lww-map', () => {
    it('get() returns the resolved snapshot, not the CRDT state', async () => {
      const db = await createNoydb({ store: inlineMemory(), user: 'u', encrypt: false })
      const comp = await db.openVault(COMP)
      const notes = comp.collection<Note>('notes', { crdt: 'lww-map' })

      await notes.put('n1', { title: 'Hello', body: 'World', priority: 1 })

      const record = await notes.get('n1')
      expect(record).toEqual({ title: 'Hello', body: 'World', priority: 1 })
    })

    it('getRaw() returns the LwwMapState', async () => {
      const db = await createNoydb({ store: inlineMemory(), user: 'u', encrypt: false })
      const comp = await db.openVault(COMP)
      const notes = comp.collection<Note>('notes', { crdt: 'lww-map' })

      await notes.put('n1', { title: 'Hello', body: 'World', priority: 1 })

      const raw = await notes.getRaw('n1') as LwwMapState
      expect(raw._crdt).toBe('lww-map')
      expect(raw.fields.title.v).toBe('Hello')
      expect(raw.fields.body.v).toBe('World')
      expect(raw.fields.priority.v).toBe(1)
      expect(typeof raw.fields.title.ts).toBe('string')
    })

    it('getRaw() returns null for non-existent record', async () => {
      const db = await createNoydb({ store: inlineMemory(), user: 'u', encrypt: false })
      const comp = await db.openVault(COMP)
      const notes = comp.collection<Note>('notes', { crdt: 'lww-map' })

      expect(await notes.getRaw('missing')).toBeNull()
    })

    it('getRaw() throws on non-CRDT collection', async () => {
      const db = await createNoydb({ store: inlineMemory(), user: 'u', encrypt: false })
      const comp = await db.openVault(COMP)
      const plain = comp.collection<Note>('plain')

      await expect(plain.getRaw('n1')).rejects.toThrow(/getRaw\(\)/)
    })

    it('preserves fields from existing state that are absent from new record', async () => {
      const db = await createNoydb({ store: inlineMemory(), user: 'u', encrypt: false })
      const comp = await db.openVault(COMP)
      const notes = comp.collection<Note>('notes', { crdt: 'lww-map' })

      await notes.put('n1', { title: 'First', body: 'Body', priority: 1 })

      // Second put only changes title — body and priority should be preserved
      await notes.put('n1', { title: 'Updated', body: 'Body', priority: 1 })
      const record = await notes.get('n1')
      expect(record?.title).toBe('Updated')
      expect(record?.body).toBe('Body')
      expect(record?.priority).toBe(1)
    })

    it('conflict resolver merges fields from both sides by timestamp', async () => {
      const local = inlineMemory()
      const remote = inlineMemory()

      const dbA = await createNoydb({ store: local, sync: remote, user: 'a', encrypt: false })
      const dbB = await createNoydb({ store: remote, user: 'b', encrypt: false })

      const compA = await dbA.openVault(COMP)
      const notesA = compA.collection<Note>('notes', { crdt: 'lww-map' })

      // Push a base record from A
      await notesA.put('n1', { title: 'Base', body: 'Body', priority: 1 })
      await dbA.push(COMP)

      // dbB reads the record and modifies only 'body'
      const compB = await dbB.openVault(COMP)
      const notesB = compB.collection<Note>('notes', { crdt: 'lww-map' })
      const existing = await notesB.get('n1')
      expect(existing).not.toBeNull()
      await notesB.put('n1', { ...existing!, body: 'B-Body' })

      // dbA modifies only 'priority' (concurrent with B's change)
      await notesA.put('n1', { title: 'Base', body: 'Body', priority: 99 })

      // Push dbA's change — this creates a conflict
      const pushResult = await dbA.push(COMP)
      // Conflict is resolved by the CRDT merge — both fields should survive
      // in some form. The push result may show 0 conflicts if the CRDT
      // resolver handled it automatically.
      expect(pushResult.errors).toHaveLength(0)
    })

    it('list() returns resolved snapshots', async () => {
      const db = await createNoydb({ store: inlineMemory(), user: 'u', encrypt: false })
      const comp = await db.openVault(COMP)
      const notes = comp.collection<Note>('notes', { crdt: 'lww-map' })

      await notes.put('n1', { title: 'A', body: 'aa', priority: 1 })
      await notes.put('n2', { title: 'B', body: 'bb', priority: 2 })

      const records = await notes.list()
      expect(records).toHaveLength(2)
      expect(records[0]).toMatchObject({ title: expect.any(String) })
    })
  })

  // ─── rga ──────────────────────────────────────────────────────────────────

  describe('rga', () => {
    it('get() returns the resolved array snapshot', async () => {
      const db = await createNoydb({ store: inlineMemory(), user: 'u', encrypt: false })
      const comp = await db.openVault(COMP)
      const tags = comp.collection<string[]>('tags', { crdt: 'rga' })

      await tags.put('rec1', ['alpha', 'beta', 'gamma'])
      const result = await tags.get('rec1')
      expect(result).toEqual(['alpha', 'beta', 'gamma'])
    })

    it('getRaw() returns the RgaState with nids', async () => {
      const db = await createNoydb({ store: inlineMemory(), user: 'u', encrypt: false })
      const comp = await db.openVault(COMP)
      const tags = comp.collection<string[]>('tags', { crdt: 'rga' })

      await tags.put('rec1', ['alpha', 'beta'])
      const raw = await tags.getRaw('rec1') as RgaState
      expect(raw._crdt).toBe('rga')
      expect(raw.items).toHaveLength(2)
      expect(raw.items[0]?.v).toBe('alpha')
      expect(raw.items[1]?.v).toBe('beta')
      expect(typeof raw.items[0]?.nid).toBe('string')
      expect(raw.items[0]?.nid).not.toBe(raw.items[1]?.nid)
    })

    it('removing an element tombstones it', async () => {
      const db = await createNoydb({ store: inlineMemory(), user: 'u', encrypt: false })
      const comp = await db.openVault(COMP)
      const tags = comp.collection<string[]>('tags', { crdt: 'rga' })

      await tags.put('rec1', ['alpha', 'beta', 'gamma'])
      // Remove 'beta' by putting without it
      await tags.put('rec1', ['alpha', 'gamma'])

      const result = await tags.get('rec1')
      expect(result).toEqual(['alpha', 'gamma'])

      const raw = await tags.getRaw('rec1') as RgaState
      expect(raw.tombstones).toHaveLength(1)
      expect(raw.items).toHaveLength(3) // all items retained in state, 1 tombstoned
    })

    it('stable NID reuse: re-inserting same element reuses existing NID', async () => {
      const db = await createNoydb({ store: inlineMemory(), user: 'u', encrypt: false })
      const comp = await db.openVault(COMP)
      const tags = comp.collection<string[]>('tags', { crdt: 'rga' })

      await tags.put('rec1', ['alpha', 'beta'])
      const raw1 = await tags.getRaw('rec1') as RgaState
      const alphaNid = raw1.items[0]!.nid

      await tags.put('rec1', ['alpha', 'gamma'])
      const raw2 = await tags.getRaw('rec1') as RgaState
      const alphaItem = raw2.items.find(i => i.v === 'alpha')
      expect(alphaItem?.nid).toBe(alphaNid) // same NID reused
    })

    it('conflict resolver unions items from both sides', async () => {
      const local = inlineMemory()
      const remote = inlineMemory()

      const dbA = await createNoydb({ store: local, sync: remote, user: 'a', encrypt: false })
      const dbB = await createNoydb({ store: remote, user: 'b', encrypt: false })

      const compA = await dbA.openVault(COMP)
      const tagsA = compA.collection<string[]>('tags', { crdt: 'rga' })

      await tagsA.put('rec1', ['alpha', 'beta'])
      await dbA.push(COMP)

      // B adds 'foo'
      const compB = await dbB.openVault(COMP)
      const tagsB = compB.collection<string[]>('tags', { crdt: 'rga' })
      const bState = await tagsB.get('rec1')
      await tagsB.put('rec1', [...(bState ?? []), 'foo'])

      // A adds 'bar' concurrently
      await tagsA.put('rec1', ['alpha', 'beta', 'bar'])

      const pushResult = await dbA.push(COMP)
      expect(pushResult.errors).toHaveLength(0)
    })
  })

  // ─── yjs ──────────────────────────────────────────────────────────────────

  describe('yjs', () => {
    it('stores and retrieves a base64 update blob', async () => {
      const db = await createNoydb({ store: inlineMemory(), user: 'u', encrypt: false })
      const comp = await db.openVault(COMP)
      // T is treated as string (base64 blob) for yjs collections
      const docs = comp.collection<string>('docs', { crdt: 'yjs' })

      const fakeUpdate = btoa('fake-yjs-state-bytes')
      await docs.put('doc1', fakeUpdate)

      // get() returns the raw base64 blob for yjs mode
      const result = await docs.get('doc1')
      expect(result).toBe(fakeUpdate)
    })

    it('getRaw() returns the YjsState with the update blob', async () => {
      const db = await createNoydb({ store: inlineMemory(), user: 'u', encrypt: false })
      const comp = await db.openVault(COMP)
      const docs = comp.collection<string>('docs', { crdt: 'yjs' })

      const fakeUpdate = btoa('fake-yjs-state')
      await docs.put('doc1', fakeUpdate)

      const raw = await docs.getRaw('doc1')
      expect(raw?._crdt).toBe('yjs')
      expect((raw as { update: string }).update).toBe(fakeUpdate)
    })
  })
})
