/**
 * Recipe 3 — Real-time collaborative app.
 *
 * The runnable verification of `docs/recipes/realtime-crdt-app.md`.
 * Three subsystems opted-in: crdt, sync, session.
 *
 * What this proves:
 *   1. Yjs interop via `yjsCollection()` round-trips through encrypted
 *      storage
 *   2. Two collaborators forking from the same baseline can merge
 *      their concurrent edits via `Y.applyUpdate` and converge on
 *      identical state — the CRDT contract that NOYDB preserves
 *   3. Without `withCrdt()`, declaring `crdt: 'yjs'` on a Collection
 *      throws on first mutation
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as Y from 'yjs'
import { createNoydb, type Noydb } from '@noy-db/hub'
import { withCrdt } from '@noy-db/hub/crdt'
import { withSync } from '@noy-db/hub/sync'
import { withSession } from '@noy-db/hub/session'
import {
  yjsCollection,
  yText,
  yMap,
  type YjsCollection,
} from '@noy-db/in-yjs'
import { memory } from '@noy-db/to-memory'

const PASSPHRASE = 'collaborative-edit'
const VAULT = 'shared'

type DocFields = {
  body: ReturnType<typeof yText>
  meta: ReturnType<typeof yMap>
}

describe('Recipe 3 — Real-time collaborative app', () => {
  let db: Noydb
  let docs: YjsCollection<DocFields>

  beforeEach(async () => {
    db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: PASSPHRASE,
      crdtStrategy: withCrdt(),
      syncStrategy: withSync(),
      sessionStrategy: withSession(),
    })
    const vault = await db.openVault(VAULT)
    docs = yjsCollection(vault, 'docs', {
      yFields: { body: yText(), meta: yMap() },
    })
  })

  afterEach(() => {
    db.close()
  })

  it('Yjs Y.Text round-trips through encrypted storage', async () => {
    const d = await docs.getYDoc('doc-1')
    d.getText('body').insert(0, 'Hello, world')
    d.getMap('meta').set('author', 'alice')
    await docs.putYDoc('doc-1', d)

    const reloaded = await docs.getYDoc('doc-1')
    expect(reloaded.getText('body').toString()).toBe('Hello, world')
    expect(reloaded.getMap('meta').get('author')).toBe('alice')
  })

  it('two concurrent edits merge through the CRDT and converge', async () => {
    // Seed a baseline both collaborators fork from.
    const baseline = await docs.getYDoc('doc-shared')
    baseline.getText('body').insert(0, 'Hello')
    await docs.putYDoc('doc-shared', baseline)

    // Collaborator A — appends.
    const docA = await docs.getYDoc('doc-shared')
    docA.getText('body').insert(docA.getText('body').length, ' from Alice')

    // Collaborator B — independently prepends.
    const docB = await docs.getYDoc('doc-shared')
    docB.getText('body').insert(0, 'Hi! ')

    // Merge by exchanging update buffers — the CRDT contract.
    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB))
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA))

    // Both end up at the same converged state.
    expect(docA.getText('body').toString())
      .toBe(docB.getText('body').toString())
    const merged = docA.getText('body').toString()
    expect(merged).toContain('Hello')
    expect(merged).toContain('from Alice')
    expect(merged).toContain('Hi!')

    // Persist the merged state and reload.
    await docs.putYDoc('doc-shared', docA)
    const reloaded = await docs.getYDoc('doc-shared')
    expect(reloaded.getText('body').toString()).toBe(merged)
  })

  it('without withCrdt(), a crdt: "yjs" collection throws on first mutation', async () => {
    const noCrdtDb = await createNoydb({
      store: memory(),
      user: 'bob',
      secret: PASSPHRASE,
      // No crdtStrategy — the gate.
      syncStrategy: withSync(),
    })
    const vault = await noCrdtDb.openVault('test')
    const yjsColl = yjsCollection(vault, 'docs', {
      yFields: { body: yText() },
    })

    const d = await yjsColl.getYDoc('d')
    d.getText('body').insert(0, 'will fail')
    await expect(yjsColl.putYDoc('d', d)).rejects.toThrow(/withCrdt/)

    noCrdtDb.close()
  })
})
