/**
 * Recipe 1 — Personal encrypted notebook.
 *
 * The runnable verification of `docs/recipes/personal-notebook.md`.
 * This file IS the source-of-truth code shown in the doc — if you
 * change one, change the other.
 *
 * Goal: prove that a single-user, local-only consumer with no
 * subsystems opted-in can read, write, query, scan, and close a
 * vault. Bundle: core only (~6,500 LOC).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createNoydb, type Noydb, type NoydbStore } from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'

interface Note {
  id: string
  title: string
  body: string
  createdAt: string
}

const PASSPHRASE = 'correct-horse-battery-staple'

describe('Recipe 1 — Personal encrypted notebook', () => {
  let db: Noydb
  let rawStore: NoydbStore

  beforeEach(async () => {
    rawStore = memory()
    db = await createNoydb({
      store: rawStore,
      user: 'me',
      secret: PASSPHRASE,
    })
  })

  afterEach(() => {
    db.close()
  })

  it('writes and reads a typed record', async () => {
    const vault = await db.openVault('notebook')
    const notes = vault.collection<Note>('notes')

    await notes.put('note-1', {
      id: 'note-1',
      title: 'Groceries',
      body: 'eggs, milk',
      createdAt: '2026-04-25T10:00:00.000Z',
    })

    const one = await notes.get('note-1')
    expect(one).toEqual({
      id: 'note-1',
      title: 'Groceries',
      body: 'eggs, milk',
      createdAt: '2026-04-25T10:00:00.000Z',
    })
  })

  it('queries with where + orderBy + limit', async () => {
    const vault = await db.openVault('notebook')
    const notes = vault.collection<Note>('notes')

    for (let i = 0; i < 5; i++) {
      await notes.put(`note-${i}`, {
        id: `note-${i}`,
        title: i % 2 === 0 ? 'A' : 'B',
        body: '...',
        createdAt: `2026-04-${20 + i}T00:00:00.000Z`,
      })
    }

    const recentBs = await notes
      .query()
      .where('title', '==', 'B')
      .orderBy('createdAt', 'desc')
      .limit(10)
      .toArray()

    expect(recentBs).toHaveLength(2)
    expect(recentBs[0]!.id).toBe('note-3')
    expect(recentBs[1]!.id).toBe('note-1')
  })

  it('streams via scan() without loading the whole vault', async () => {
    const vault = await db.openVault('notebook')
    const notes = vault.collection<Note>('notes')

    for (let i = 0; i < 10; i++) {
      await notes.put(`note-${i}`, {
        id: `note-${i}`,
        title: `Title ${i}`,
        body: 'body',
        createdAt: `2026-04-${10 + i}T00:00:00.000Z`,
      })
    }

    const titles: string[] = []
    for await (const n of notes.scan()) {
      titles.push(n.title)
    }
    expect(titles).toHaveLength(10)
  })

  it('disk records are ciphertext — the store sees only envelopes', async () => {
    const vault = await db.openVault('notebook')
    const notes = vault.collection<Note>('notes')

    await notes.put('secret', {
      id: 'secret',
      title: 'PIN code',
      body: '1234',
      createdAt: '2026-04-25T10:00:00.000Z',
    })

    // Peek at the raw envelope sitting in the memory store.
    const envelope = await rawStore.get('notebook', 'notes', 'secret')
    expect(envelope).toBeTruthy()
    expect(envelope!._noydb).toBe(1)
    // _data is the AES-GCM ciphertext (base64). Body text not present.
    expect(envelope!._data).not.toContain('1234')
    expect(envelope!._data).not.toContain('PIN code')
  })

  it('proves the catalog floor: no opt-in subsystems → reads still work, history is gated', async () => {
    const vault = await db.openVault('notebook')
    const notes = vault.collection<Note>('notes')

    await notes.put('n1', {
      id: 'n1',
      title: 'first',
      body: 'b',
      createdAt: '2026-04-25T10:00:00.000Z',
    })
    await notes.put('n1', {
      id: 'n1',
      title: 'second',
      body: 'b',
      createdAt: '2026-04-25T10:01:00.000Z',
    })

    // Reads: works (history not opted in, so put/put just overwrites).
    const cur = await notes.get('n1')
    expect(cur!.title).toBe('second')

    // History reads: throw with an actionable pointer to the subpath.
    await expect(notes.history('n1')).rejects.toThrow(/withHistory/)
  })
})
