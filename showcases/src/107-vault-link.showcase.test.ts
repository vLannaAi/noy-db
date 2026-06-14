/**
 * Showcase 107 — vault.link (managed many-to-many junction)
 *
 * What you'll learn
 * ─────────────────
 * `vault.link()` declares a first-class many-to-many junction between two
 * collections; `vault.links()` operates it. Unlike `refArray` (an id-array
 * on one record), a link set is queryable from BOTH sides, carries
 * per-link metadata, and cascades on endpoint delete.
 *
 *   1. `vault.link('saleLineLinks', { a, b, onDelete })` — declare.
 *   2. `connect(a, b, meta?)` / `disconnect` / `has` / `of(id)`.
 *   3. `onDelete: 'cascade'` removes link rows when an endpoint is deleted.
 *
 * Why it matters
 * ──────────────
 * Line-linking (a sale line ↔ the purchase lines that fulfilled it) is a
 * real M:N with its own data (matched quantity). A managed junction keeps
 * the relationship queryable both ways and self-cleaning, instead of two
 * hand-maintained id arrays that drift.
 *
 * refArray (showcase 103) vs vault.link: reach for refArray for simple
 * tag-like sets; reach for vault.link when links are entities — queryable
 * both ways, annotatable, cascading.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 00 + 103 (refArray).
 *
 * Spec mapping
 * ────────────
 * features.yaml → features → schema-and-refs
 */

import { describe, it, expect } from 'vitest'
import { createNoydb, ref, LinkEndpointError } from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'

interface Line { id: string; label: string }

describe('Showcase 107 — vault.link (M:N junction)', () => {
  it('links sale lines to purchase lines, both-way queryable, with cascade', async () => {
    const db = await createNoydb({ store: memory(), user: 'alice', secret: 'vault-link-showcase-2026' })
    const vault = await db.openVault('firm')

    const saleLines = vault.collection<Line>('saleLines')
    const purchaseLines = vault.collection<Line>('purchaseLines')
    await saleLines.put('s1', { id: 's1', label: 'widget ×10' })
    await purchaseLines.put('p1', { id: 'p1', label: 'PO-1 widgets' })
    await purchaseLines.put('p2', { id: 'p2', label: 'PO-2 widgets' })

    // Declare the junction, then connect with per-link metadata.
    vault.link('saleLineLinks', { a: ref('saleLines'), b: ref('purchaseLines'), onDelete: 'cascade' })
    const links = vault.links('saleLineLinks')
    await links.connect('s1', 'p1', { matchedQty: 6 })
    await links.connect('s1', 'p2', { matchedQty: 4 })

    // Queryable from the sale side…
    const fromSale = await links.of('s1')
    expect(fromSale.map((l) => l.b).sort()).toEqual(['p1', 'p2'])
    expect(fromSale.find((l) => l.b === 'p1')?.meta).toEqual({ matchedQty: 6 })
    // …and from the purchase side.
    expect((await links.of('p2')).map((l) => l.a)).toEqual(['s1'])

    // connect validates endpoints exist.
    await expect(links.connect('s1', 'ghost')).rejects.toBeInstanceOf(LinkEndpointError)

    // Deleting an endpoint cascades its link rows away.
    await purchaseLines.delete('p1')
    expect(await links.has('s1', 'p1')).toBe(false)
    expect(await links.has('s1', 'p2')).toBe(true) // unrelated link intact

    db.close()
  })
})
