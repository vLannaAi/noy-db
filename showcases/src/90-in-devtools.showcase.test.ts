/**
 * Showcase 90 — in-devtools (createInspector)
 *
 * What you'll learn
 * ─────────────────
 * `createInspector(db)` turns a live noy-db into a read-only, framework-
 * agnostic view: `listVaults()` enumerates accessible vaults, `snapshot(vault)`
 * returns each collection's schema + stats, `records(vault, name, { limit })`
 * pages decrypted rows, `subscribe(fn)` streams live write events, and
 * `pendingWrites()` reports in-flight writes. It is built entirely on public
 * hub APIs (`listAccessibleVaults` / `dumpSchema` / `query` / `onAfterWrite` /
 * `writeQueue`) — no hub internals, no hub changes.
 *
 * Why it matters
 * ──────────────
 * It is the data layer behind a devtools panel or CLI inspector: a developer
 * can see vaults, schema, stats, records, and live writes without hand-rolling
 * the plumbing. Read-only and zero-knowledge-respecting — it shows only what
 * the already-unlocked session can decrypt, and never writes.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 00-hello-vault, 01-storage-memory.
 *
 * What to read next
 * ─────────────────
 *   - docs/packages/in-integrations.md
 *
 * Spec mapping
 * ────────────
 * features.yaml → frameworks → in-devtools
 */

import { describe, it, expect } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'
import { createInspector } from '@noy-db/in-devtools'

interface Note { id: string; title: string; body: string }

describe('90 in-devtools — createInspector', () => {
  it('inspects vaults, schema/stats, records, and live writes (read-only)', async () => {
    const db = await createNoydb({ store: memory(), user: 'owner', secret: 'inspector-showcase' })
    const vault = await db.openVault('books')
    const notes = vault.collection<Note>('notes')
    await notes.put('a', { id: 'a', title: 'A', body: 'first' })
    await notes.put('b', { id: 'b', title: 'B', body: 'second' })

    const inspector = createInspector(db)

    // 1. Enumerate accessible vaults.
    const vaults = await inspector.listVaults()
    expect(vaults.some((v) => v.id === 'books')).toBe(true)

    // 2. Structure + stats for an open vault.
    const snap = await inspector.snapshot(vault)
    expect(snap.vault).toBe('books')
    const notesCol = snap.collections.find((c) => c.name === 'notes')
    expect(notesCol?.stats?.records).toBe(2)

    // 3. Paged, decrypted records.
    const page = await inspector.records(vault, 'notes', { limit: 1, offset: 0 })
    expect(page.total).toBe(2)
    expect(page.rows).toHaveLength(1)

    // 4. Live write stream.
    const seen: string[] = []
    const off = inspector.subscribe((e) => { seen.push(`${e.op}:${e.docId}`) })
    await notes.put('c', { id: 'c', title: 'C', body: 'third' })
    await notes.delete('a')
    expect(seen).toEqual(['create:c', 'delete:a'])
    off()

    // 5. Pending-write state.
    expect(inspector.pendingWrites().pending).toBe(false)

    // Read-only: inspecting did not change the record count (still 2 after +c −a).
    const afterPage = await inspector.records(vault, 'notes', {})
    expect(afterPage.total).toBe(2)
  })
})
