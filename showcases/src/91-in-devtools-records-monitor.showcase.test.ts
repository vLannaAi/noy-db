/**
 * Showcase 91 — in-devtools records paging + write monitor
 *
 * What you'll learn
 * ─────────────────
 * `inspector.records(vault, collection, { limit, offset })` returns a paged
 * slice of decrypted rows with a stable `total` count. `inspector.subscribe(fn)`
 * fires a live `InspectorWriteEvent` for every write that reaches the hub
 * (create, update, delete) — including writes that happen after the subscription
 * is established.
 *
 * Why it matters
 * ──────────────
 * These two APIs are the data layer for the devtools Records pane (paged grid)
 * and the Write Monitor (live feed). Keeping them tested headlessly means the
 * ink/React TUI layer can rely on them without repeating integration coverage.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 00-hello-vault, 01-storage-memory, 90-in-devtools.
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

interface Item { id: string; n: number }

describe('91 in-devtools — records paging + write monitor', () => {
  it('pages records and streams write events', async () => {
    const db = await createNoydb({ store: memory(), user: 'owner', secret: 'pw' })
    const vault = await db.openVault('v')
    const c = vault.collection<Item>('items')
    for (let i = 0; i < 5; i++) await c.put('i' + i, { id: 'i' + i, n: i })

    const inspector = createInspector(db)

    // (a) Paged records: first page of 2 out of 5 total.
    const page = await inspector.records(vault, 'items', { limit: 2, offset: 0 })
    expect(page.total).toBe(5)
    expect(page.rows).toHaveLength(2)

    // (b) Live write stream: a later put surfaces in the subscription.
    const seen: string[] = []
    const off = inspector.subscribe((e) => seen.push(e.docId))
    await c.put('i5', { id: 'i5', n: 5 })
    expect(seen).toContain('i5')
    off()
  })
})
