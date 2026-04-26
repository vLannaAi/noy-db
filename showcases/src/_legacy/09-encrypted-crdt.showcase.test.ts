/**
 * Showcase 09 — "Encrypted CRDT"
 * GitHub issue: https://github.com/vLannaAi/noy-db/issues/174
 *
 * Framework: Yjs (`yjsCollection`, `yText`, `yMap`)
 * Store:     `memory()`
 * Branch:    `showcase/09-encrypted-crdt`
 * Dimension: Security + collaboration — Yjs CRDTs round-tripped through
 *            NOYDB's AES-256-GCM envelope.
 *
 * What this proves:
 *   1. `yjsCollection` composes cleanly on top of a regular NOYDB vault —
 *      the Y.Doc is encoded as a Yjs update, then handed to the normal
 *      encryption path, so every byte on disk is ciphertext.
 *   2. Thai-language Y.Text content survives the full encode → encrypt →
 *      decrypt → decode round trip bit-for-bit.
 *   3. Two collaborators can edit the same record concurrently; Yjs's
 *      CRDT merge resolves both edits deterministically and the merged
 *      doc persists through the encryption layer.
 *   4. The memory store only ever sees an opaque `_data` envelope field —
 *      neither the Thai plaintext nor any ASCII fragment leaks.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as Y from 'yjs'
import { createNoydb, type Noydb, type NoydbStore } from '@noy-db/hub'
import { withCrdt } from '@noy-db/hub/crdt'
import { memory } from '@noy-db/to-memory'
import { yjsCollection, yText, yMap, type YjsCollection } from '@noy-db/in-yjs'

import { SHOWCASE_PASSPHRASE, THAI_SAMPLE } from '../_fixtures.js'

type NoteFields = { body: Y.Text; meta: Y.Map<unknown> }

const VAULT = 'firm-demo'
const COLLECTION = 'notes'

describe('Showcase 09 — Encrypted CRDT (Yjs)', () => {
  let db: Noydb
  let rawStore: NoydbStore
  let notes: YjsCollection<{ body: ReturnType<typeof yText>; meta: ReturnType<typeof yMap> }>

  beforeEach(async () => {
    // Keep a direct handle to the memory adapter so we can peek at the
    // encrypted envelope from the "store side" of the zero-knowledge boundary.
    rawStore = memory()

    db = await createNoydb({
      store: rawStore,
      user: 'owner', crdtStrategy: withCrdt(),
      secret: SHOWCASE_PASSPHRASE,
    })
    const vault = await db.openVault(VAULT)

    notes = yjsCollection(vault, COLLECTION, {
      yFields: { body: yText(), meta: yMap() },
    })
  })

  afterEach(async () => {
    await db.close()
  })

  it('step 1 — Thai Y.Text survives the encrypted round trip', async () => {
    // Build a Y.Doc, insert a Thai string into its Y.Text, and persist.
    // `putYDoc` encodes the CRDT state as a Yjs update, base64s it, and
    // then hands it to the normal NOYDB put path — which encrypts it.
    const doc = await notes.getYDoc('note-1')
    doc.getText('body').insert(0, THAI_SAMPLE)
    doc.getMap('meta').set('author', 'alice')
    await notes.putYDoc('note-1', doc)

    const reloaded = await notes.getYDoc('note-1')
    expect(reloaded.getText('body').toString()).toBe(THAI_SAMPLE)
    expect(reloaded.getMap('meta').get('author')).toBe('alice')
  })

  it('step 2 — raw envelope on the store side is pure ciphertext', async () => {
    // Put a note that mixes Thai plaintext with an ASCII tag, then peek at
    // the memory store directly. The envelope has the standard NOYDB shape
    // (`_noydb: 1`, `_iv`, `_data`) and neither the Thai UTF-8 bytes nor
    // the ASCII fragment survive in `_data` — AES-GCM scrambled them.
    const doc = await notes.getYDoc('note-secret')
    doc.getText('body').insert(0, THAI_SAMPLE)
    doc.getMap('meta').set('tag', 'confidential-retainer')
    await notes.putYDoc('note-secret', doc)

    const envelope = await rawStore.get(VAULT, COLLECTION, 'note-secret')
    expect(envelope).toBeTruthy()
    expect(envelope!._noydb).toBe(1)
    expect(typeof envelope!._iv).toBe('string')
    expect(typeof envelope!._data).toBe('string')

    // The Thai phrase, its distinctive Thai prefix, and the ASCII tag
    // are all absent from the opaque `_data` blob.
    expect(envelope!._data).not.toContain(THAI_SAMPLE)
    expect(envelope!._data).not.toContain('สวัสดี')
    expect(envelope!._data).not.toContain('confidential-retainer')
    expect(envelope!._data).not.toContain('NOYDB')
  })

  it('step 3 — recap: two concurrent edits merge through the encryption layer', async () => {
    // Seed the shared baseline: a single note that both collaborators will
    // fork from. Writing it also proves `putYDoc` works for the initial state.
    const baseline = await notes.getYDoc('note-shared')
    baseline.getText('body').insert(0, 'Hello')
    await notes.putYDoc('note-shared', baseline)

    // Collaborator A loads the doc and appends " from Alice".
    const docA = await notes.getYDoc('note-shared')
    docA.getText('body').insert(docA.getText('body').length, ' from Alice')

    // Collaborator B loads the same baseline (independently) and prepends
    // a Thai greeting. Because they both started from the same state,
    // Yjs will merge their edits deterministically regardless of order.
    const docB = await notes.getYDoc('note-shared')
    docB.getText('body').insert(0, `${THAI_SAMPLE} · `)

    // CRDT merge: fold B's state into A, and A's state into B. Both docs
    // now converge on the same text.
    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB))
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA))
    expect(docA.getText('body').toString()).toBe(docB.getText('body').toString())
    const merged = docA.getText('body').toString()
    expect(merged).toContain(THAI_SAMPLE)
    expect(merged).toContain('Hello')
    expect(merged).toContain('from Alice')

    // Persist the merged state — still encrypted — and reload. The
    // round-tripped doc matches what the two collaborators converged on.
    await notes.putYDoc('note-shared', docA)

    const reloaded = await notes.getYDoc('note-shared')
    expect(reloaded.getText('body').toString()).toBe(merged)

    // And the on-disk envelope for the merged record is still ciphertext —
    // no Thai plaintext leaks even after a CRDT merge.
    const envelope = await rawStore.get(VAULT, COLLECTION, 'note-shared')
    expect(envelope!._noydb).toBe(1)
    expect(envelope!._data).not.toContain('สวัสดี')
    expect(envelope!._data).not.toContain('from Alice')
  })
})
