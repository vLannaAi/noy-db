/**
 * Showcase 01 — Storage: in-memory
 *
 * What you'll learn
 * ─────────────────
 * The simplest of the storage backends: `@noy-db/to-memory`. Holds
 * encrypted envelopes in a JavaScript Map. Survives no further than
 * the process lifetime — perfect for tests, REPL exploration, and
 * CI fixtures.
 *
 * Why it matters
 * ──────────────
 * Every other adapter implements the same 6-method `NoydbStore`
 * interface as `to-memory`. If a feature works against `to-memory`
 * it should work against any backend; if it doesn't, the bug is in
 * the adapter, not the hub. `to-memory` is therefore the canonical
 * "is the encryption pipeline working" backstop.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 00 (the floor).
 *
 * What to read next
 * ─────────────────
 *   - showcase 02-storage-file (persist to disk)
 *   - docs/core/03-stores.md (the 6-method contract)
 *   - packages/to-memory/src/index.ts (~40 LOC, readable end-to-end)
 *
 * Spec mapping
 * ────────────
 * features.yaml → adapters → to-memory
 */

import { describe, it, expect } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'

interface Note { id: string; text: string }

describe('Showcase 01 — Storage: in-memory', () => {
  it('round-trips records through the encrypted envelope pipeline', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'storage-memory-passphrase-2026',
    })
    const vault = await db.openVault('demo')
    const notes = vault.collection<Note>('notes')

    await notes.put('a', { id: 'a', text: 'one' })
    await notes.put('b', { id: 'b', text: 'two' })
    await notes.put('c', { id: 'c', text: 'three' })

    const list = await notes.list()
    expect(list.map((r) => r.id).sort()).toEqual(['a', 'b', 'c'])
    db.close()
  })

  it('does not persist across instances (no shared Map)', async () => {
    const store1 = memory()
    const db1 = await createNoydb({ store: store1, user: 'alice', secret: 'pass-2026-aaaa' })
    const v1 = await db1.openVault('demo')
    await v1.collection<Note>('notes').put('a', { id: 'a', text: 'first' })
    db1.close()

    // Fresh `memory()` call → fresh Map → no records.
    const store2 = memory()
    const db2 = await createNoydb({ store: store2, user: 'alice', secret: 'pass-2026-aaaa' })
    const v2 = await db2.openVault('demo')
    expect(await v2.collection<Note>('notes').list()).toEqual([])
    db2.close()
  })

  it('survives a re-open against the SAME store instance', async () => {
    // Holding the store across closes is the test-fixture pattern —
    // re-create the Noydb instance, share the store, see the records.
    const store = memory()
    const db1 = await createNoydb({ store, user: 'alice', secret: 'pass-2026-bbbb' })
    const v1 = await db1.openVault('demo')
    await v1.collection<Note>('notes').put('a', { id: 'a', text: 'persistent' })
    db1.close()

    const db2 = await createNoydb({ store, user: 'alice', secret: 'pass-2026-bbbb' })
    const v2 = await db2.openVault('demo')
    expect(await v2.collection<Note>('notes').get('a')).toEqual({ id: 'a', text: 'persistent' })
    db2.close()
  })
})
