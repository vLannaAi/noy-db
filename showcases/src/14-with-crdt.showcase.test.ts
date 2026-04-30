/**
 * Showcase 14 — withCrdt() (Yjs interop)
 *
 * What you'll learn
 * ─────────────────
 * `withCrdt()` enables collections declared with `crdt: 'yjs'` to
 * round-trip Y.Doc state through the encrypted envelope. The Yjs
 * binding lives in `@noy-db/in-yjs` (`yjsCollection`, `yText`,
 * `yMap`); two parallel updaters merge cleanly via Yjs's CRDT, and
 * the merged doc survives encryption.
 *
 * Why it matters
 * ──────────────
 * Real-time collaborative editing — typing into the same note from
 * two browser tabs without a central server — needs a CRDT. Yjs is
 * the canonical implementation; this subsystem makes it work
 * end-to-end through noy-db's encryption.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 00 + 01.
 *
 * What to read next
 * ─────────────────
 *   - showcase 15-with-sync (transport for the merged updates)
 *   - docs/subsystems/crdt.md
 *
 * Spec mapping
 * ────────────
 * features.yaml → features → crdt
 */

import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import { createNoydb } from '@noy-db/hub'
import { withCrdt } from '@noy-db/hub/crdt'
import { memory } from '@noy-db/to-memory'
import { yjsCollection, yText } from '@noy-db/in-yjs'

describe('Showcase 14 — withCrdt() (Yjs interop)', () => {
  it('round-trips a Y.Text through the encrypted envelope', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'with-crdt-passphrase-2026',
      crdtStrategy: withCrdt(),
    })
    const vault = await db.openVault('demo')
    const notes = yjsCollection(vault, 'notes', {
      yFields: { body: yText() },
    })

    const doc = new Y.Doc()
    const text = doc.getText('body')
    text.insert(0, 'hello world')
    await notes.putYDoc('n1', doc)

    const got = await notes.getYDoc('n1')
    expect(got.getText('body').toString()).toBe('hello world')

    db.close()
  })

  it('two concurrent edits merge via the Yjs CRDT', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'with-crdt-passphrase-2026',
      crdtStrategy: withCrdt(),
    })
    const vault = await db.openVault('demo')
    const notes = yjsCollection(vault, 'notes', {
      yFields: { body: yText() },
    })

    // Both peers start from the same baseline.
    const baseline = new Y.Doc()
    baseline.getText('body').insert(0, 'shared baseline')
    await notes.putYDoc('n1', baseline)

    // Peer A inserts at the start, peer B at the end. CRDT merges
    // both edits deterministically.
    const peerA = new Y.Doc()
    Y.applyUpdate(peerA, Y.encodeStateAsUpdate(baseline))
    const peerB = new Y.Doc()
    Y.applyUpdate(peerB, Y.encodeStateAsUpdate(baseline))

    peerA.getText('body').insert(0, 'A: ')
    peerB.getText('body').insert(peerB.getText('body').length, ' :B')

    // Apply A's update to B and vice versa.
    Y.applyUpdate(peerB, Y.encodeStateAsUpdate(peerA))
    Y.applyUpdate(peerA, Y.encodeStateAsUpdate(peerB))

    expect(peerA.getText('body').toString()).toBe(peerB.getText('body').toString())
    expect(peerA.getText('body').toString()).toContain('shared baseline')
    expect(peerA.getText('body').toString()).toContain('A: ')
    expect(peerA.getText('body').toString()).toContain(' :B')

    db.close()
  })
})
