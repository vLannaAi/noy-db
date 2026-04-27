/**
 * Showcase 39 — in-yjs (Y.Doc-typed collections)
 *
 * What you'll learn
 * ─────────────────
 * `yjsCollection(vault, name, { yFields: { body: yText() } })` is a
 * typed wrapper over a CRDT collection: each record is a Y.Doc with the
 * declared shape. `getYDoc(id)` and `putYDoc(id, doc)` round-trip a
 * Y.Doc through the noy-db encrypted boundary.
 *
 * Why it matters
 * ──────────────
 * Showcase 14-with-crdt covers the raw `withCrdt()` strategy. This one
 * shows the *typed* layer: a yText/yMap/yArray descriptor table tells
 * the package which CRDT primitive each field uses, so `Doc.getText('body')`
 * is type-safe.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 14-with-crdt.
 *
 * What to read next
 * ─────────────────
 *   - showcase 40-in-react (React hook surface)
 *   - docs/packages/in-integrations.md
 *
 * Spec mapping
 * ────────────
 * features.yaml → frameworks → in-yjs
 */

import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import { createNoydb } from '@noy-db/hub'
import { withCrdt } from '@noy-db/hub/crdt'
import { yjsCollection, yText } from '@noy-db/in-yjs'
import { memory } from '@noy-db/to-memory'

describe('Showcase 39 — in-yjs', () => {
  it('typed Y.Doc round-trips through an encrypted CRDT collection', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'in-yjs-pass-2026',
      crdtStrategy: withCrdt(),
    })
    const vault = await db.openVault('demo')
    const notes = yjsCollection(vault, 'notes', { yFields: { body: yText() } })

    const doc = new Y.Doc()
    doc.getText('body').insert(0, 'collaborative draft')
    await notes.putYDoc('n1', doc)

    const readback = await notes.getYDoc('n1')
    expect(readback?.getText('body').toString()).toBe('collaborative draft')

    db.close()
  })
})
