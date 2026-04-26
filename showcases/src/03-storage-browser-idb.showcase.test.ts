/**
 * Showcase 03 — Storage: IndexedDB (browser)
 *
 * What you'll learn
 * ─────────────────
 * `@noy-db/to-browser-idb` is the in-browser persistent backend. It
 * uses IndexedDB's single `readwrite` transaction model to give you
 * **atomic compare-and-swap** — `casAtomic: true` — which means two
 * tabs writing the same record race correctly: the second writer
 * sees a `ConflictError` instead of silently overwriting.
 *
 * Why it matters
 * ──────────────
 * The browser is the most-deployed runtime for noy-db. PWAs, offline
 * web apps, mobile-shaped tools — all of them want IndexedDB. And
 * the multi-tab story (showcased later in 15-with-sync) hinges on
 * IDB's atomic CAS.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 01 (`to-memory` baseline).
 * - This showcase polyfills IndexedDB via `fake-indexeddb` so it can
 *   run in vitest (Node has no IDB). In a real browser the polyfill
 *   is replaced by the native API; the user-facing API is identical.
 *
 * What to read next
 * ─────────────────
 *   - showcase 02-storage-file (the disk equivalent for desktop)
 *   - showcase 15-with-sync (multi-tab via IDB + BroadcastChannel)
 *   - docs/core/03-stores.md (`casAtomic` capability flag)
 *
 * Spec mapping
 * ────────────
 * features.yaml → adapters → to-browser-idb
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { createNoydb, ConflictError } from '@noy-db/hub'
import { browserIdbStore } from '@noy-db/to-browser-idb'

// fake-indexeddb installs as a polyfill once per test process.
beforeAll(() => {
  Object.assign(globalThis, { indexedDB: new IDBFactory(), IDBKeyRange })
})

interface Note { id: string; text: string }

describe('Showcase 03 — Storage: IndexedDB (browser)', () => {
  it('round-trips records through IDB', async () => {
    const store = browserIdbStore({ prefix: 'showcase-03' })
    const db = await createNoydb({
      store,
      user: 'alice',
      secret: 'storage-idb-passphrase-2026',
    })
    const vault = await db.openVault('demo')
    const notes = vault.collection<Note>('notes')

    await notes.put('a', { id: 'a', text: 'in idb' })
    expect(await notes.get('a')).toEqual({ id: 'a', text: 'in idb' })
    db.close()
  })

  it('atomic CAS — second writer of the same version gets ConflictError', async () => {
    // Two Noydb instances against the SAME IDB database simulate two
    // browser tabs of the same app. Both put at version 1. The
    // adapter's atomic readwrite transaction guarantees only one wins.
    const sharedStore = browserIdbStore({ prefix: 'showcase-03-cas' })
    const passphrase = 'cas-test-passphrase-2026'

    const db1 = await createNoydb({ store: sharedStore, user: 'alice', secret: passphrase })
    const v1 = await db1.openVault('demo')
    await v1.collection<Note>('notes').put('a', { id: 'a', text: 'first writer' })

    // The second writer reads at version 1, then puts with
    // expectedVersion: 1. The first writer's put bumped the actual
    // version to 1; this writer's put would conflict if it tried to
    // re-write THAT version. Construct the CAS conflict by directly
    // calling adapter.put with a stale expectedVersion.
    const env = await sharedStore.get('demo', 'notes', 'a')
    expect(env).not.toBeNull()
    expect(env!._v).toBe(1)
    await expect(
      sharedStore.put('demo', 'notes', 'a', { ...env!, _v: 2 }, /* expectedVersion */ 0),
    ).rejects.toBeInstanceOf(ConflictError)

    db1.close()
  })
})
