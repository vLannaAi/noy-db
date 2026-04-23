import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '@noy-db/hub'
import { ConflictError, createNoydb } from '@noy-db/hub'
import { yjsCollection, yText, yMap, yArray } from '../src/index.js'

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
      if (comp) for (const [n, coll] of comp) { const r: Record<string, EncryptedEnvelope> = {}; for (const [id, e] of coll) r[id] = e; s[n] = r }
      return s
    },
    async saveAll(c, data) {
      for (const [n, recs] of Object.entries(data)) { const coll = gc(c, n); for (const [id, e] of Object.entries(recs)) coll.set(id, e) }
    },
  }
}

const COMP = 'COMP-YJS'

describe('@noy-db/yjs (v0.9 #136)', () => {
  describe('yjsCollection factory', () => {
    it('returns a YjsCollection instance', async () => {
      const db = await createNoydb({ store: inlineMemory(), user: 'u', encrypt: false })
      const comp = await db.openVault(COMP)
      const notes = yjsCollection(comp, 'notes', { yFields: { body: yText() } })
      expect(notes).toBeDefined()
      expect(typeof notes.getYDoc).toBe('function')
      expect(typeof notes.putYDoc).toBe('function')
    })
  })

  describe('getYDoc', () => {
    it('returns an empty Y.Doc for a non-existent record', async () => {
      const db = await createNoydb({ store: inlineMemory(), user: 'u', encrypt: false })
      const comp = await db.openVault(COMP)
      const notes = yjsCollection(comp, 'notes', { yFields: { body: yText() } })

      const doc = await notes.getYDoc('note-1')
      expect(doc).toBeInstanceOf(Y.Doc)
      expect(doc.getText('body').toString()).toBe('')
    })

    it('initialises declared yFields on the returned doc', async () => {
      const db = await createNoydb({ store: inlineMemory(), user: 'u', encrypt: false })
      const comp = await db.openVault(COMP)
      const notes = yjsCollection(comp, 'notes', {
        yFields: {
          body: yText(),
          meta: yMap(),
          tags: yArray(),
        },
      })

      const doc = await notes.getYDoc('note-1')
      expect(doc.getText('body')).toBeInstanceOf(Y.Text)
      expect(doc.getMap('meta')).toBeInstanceOf(Y.Map)
      expect(doc.getArray('tags')).toBeInstanceOf(Y.Array)
    })

    it('applies stored update when record exists', async () => {
      const db = await createNoydb({ store: inlineMemory(), user: 'u', encrypt: false })
      const comp = await db.openVault(COMP)
      const notes = yjsCollection(comp, 'notes', { yFields: { body: yText() } })

      // Write a doc with some content
      const docA = await notes.getYDoc('note-1')
      docA.getText('body').insert(0, 'Hello world')
      await notes.putYDoc('note-1', docA)

      // Read it back
      const docB = await notes.getYDoc('note-1')
      expect(docB.getText('body').toString()).toBe('Hello world')
    })
  })

  describe('putYDoc', () => {
    it('round-trips Y.Text content through put/get', async () => {
      const db = await createNoydb({ store: inlineMemory(), user: 'u', encrypt: false })
      const comp = await db.openVault(COMP)
      const notes = yjsCollection(comp, 'notes', { yFields: { body: yText() } })

      const doc = new Y.Doc()
      doc.getText('body').insert(0, 'NOYDB + Yjs')
      await notes.putYDoc('note-1', doc)

      const restored = await notes.getYDoc('note-1')
      expect(restored.getText('body').toString()).toBe('NOYDB + Yjs')
    })

    it('round-trips Y.Map content', async () => {
      const db = await createNoydb({ store: inlineMemory(), user: 'u', encrypt: false })
      const comp = await db.openVault(COMP)
      const notes = yjsCollection(comp, 'notes', { yFields: { meta: yMap() } })

      const doc = new Y.Doc()
      doc.getMap('meta').set('author', 'alice')
      doc.getMap('meta').set('version', 42)
      await notes.putYDoc('note-1', doc)

      const restored = await notes.getYDoc('note-1')
      expect(restored.getMap('meta').get('author')).toBe('alice')
      expect(restored.getMap('meta').get('version')).toBe(42)
    })

    it('round-trips Y.Array content', async () => {
      const db = await createNoydb({ store: inlineMemory(), user: 'u', encrypt: false })
      const comp = await db.openVault(COMP)
      const notes = yjsCollection(comp, 'notes', { yFields: { tags: yArray() } })

      const doc = new Y.Doc()
      doc.getArray('tags').push(['alpha', 'beta', 'gamma'])
      await notes.putYDoc('note-1', doc)

      const restored = await notes.getYDoc('note-1')
      expect(restored.getArray('tags').toArray()).toEqual(['alpha', 'beta', 'gamma'])
    })
  })

  describe('applyUpdate', () => {
    it('merges a Yjs update into an existing record', async () => {
      const db = await createNoydb({ store: inlineMemory(), user: 'u', encrypt: false })
      const comp = await db.openVault(COMP)
      const notes = yjsCollection(comp, 'notes', { yFields: { body: yText() } })

      // Write initial content
      const doc1 = new Y.Doc()
      doc1.getText('body').insert(0, 'Hello')
      await notes.putYDoc('note-1', doc1)

      // Apply an update that appends text
      const doc2 = new Y.Doc()
      Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1))
      doc2.getText('body').insert(5, ' world')
      const update = Y.encodeStateAsUpdate(doc2, Y.encodeStateAsUpdate(doc1))

      await notes.applyUpdate('note-1', update)

      const result = await notes.getYDoc('note-1')
      expect(result.getText('body').toString()).toBe('Hello world')
    })
  })

  describe('delete / has', () => {
    it('delete() removes the record', async () => {
      const db = await createNoydb({ store: inlineMemory(), user: 'u', encrypt: false })
      const comp = await db.openVault(COMP)
      const notes = yjsCollection(comp, 'notes', { yFields: { body: yText() } })

      const doc = new Y.Doc()
      doc.getText('body').insert(0, 'to delete')
      await notes.putYDoc('note-1', doc)

      expect(await notes.has('note-1')).toBe(true)
      await notes.delete('note-1')
      expect(await notes.has('note-1')).toBe(false)
    })

    it('has() returns false for non-existent record', async () => {
      const db = await createNoydb({ store: inlineMemory(), user: 'u', encrypt: false })
      const comp = await db.openVault(COMP)
      const notes = yjsCollection(comp, 'notes', { yFields: { body: yText() } })
      expect(await notes.has('missing')).toBe(false)
    })
  })

  describe('concurrent merge (crdt: yjs conflict resolution)', () => {
    it('Y.mergeUpdates correctly merges concurrent edits from two docs', () => {
      // This test validates the Yjs merge primitive works — independent of noy-db.
      // The core's conflict resolver falls back to LWW; actual merge happens here
      // at the application layer via applyUpdate.
      const docA = new Y.Doc()
      docA.getText('body').insert(0, 'Hello')

      const docB = new Y.Doc()
      Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA))
      docB.getText('body').insert(5, ' world')

      const updateA = Y.encodeStateAsUpdate(docA)
      const updateB = Y.encodeStateAsUpdate(docB, Y.encodeStateAsUpdate(docA))

      const merged = Y.mergeUpdates([updateA, updateB])
      const docMerged = new Y.Doc()
      Y.applyUpdate(docMerged, merged)

      expect(docMerged.getText('body').toString()).toBe('Hello world')
    })
  })
})
