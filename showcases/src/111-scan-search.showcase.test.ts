/**
 * Showcase 111 — Scan-mode full-text search (collection.search)
 *
 * What you'll learn
 * ─────────────────
 * Move typeahead / full-text search OUT of userland and INTO the DB — without
 * weakening zero-knowledge. `collection.search(field, query)` decrypts the
 * collection in memory and ranks records by BM25 relevance. Nothing searchable
 * is written to the store, so it adds **zero** leakage.
 *
 *   1. ranked results (`{ id, score, record }`, best first)
 *   2. `match: 'all'` (AND) vs the default `'any'` (OR)
 *   3. `prefix: true` — the last query term is a prefix (typeahead)
 *   4. `limit` — top-N
 *
 * Why it matters
 * ──────────────
 * At pilot scale this replaces a hand-rolled client-side scan with one call,
 * and keeps the store blind: a *store-usable* blind index (which would leak
 * term frequency + co-occurrence) is a separate, explicitly-gated opt-in — see
 * the #308 design note. Scan mode is the safe default for sensitive data.
 *
 * Spec mapping
 * ────────────
 * features.yaml → features → search-index
 */

import { describe, it, expect } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'

interface Doc extends Record<string, unknown> { id: string; title: string }

describe('Showcase 111 — Scan-mode full-text search', () => {
  it('ranks records by relevance, with AND/OR, prefix typeahead, and limit', async () => {
    const db = await createNoydb({ store: memory(), user: 'analyst', secret: 'search-2026-passphrase' })
    const vault = await db.openVault('firm')
    const docs = vault.collection<Doc>('docs')

    await docs.put('a', { id: 'a', title: 'Overdue invoice for Acme Holdings' })
    await docs.put('b', { id: 'b', title: 'Paid invoice — Globex' })
    await docs.put('c', { id: 'c', title: 'Quarterly meeting notes' })

    // OR (default): any query term matches → ranked best-first.
    const anyHits = await docs.search('title', 'invoice')
    expect(anyHits.map((h) => h.id).sort()).toEqual(['a', 'b'])
    expect(anyHits[0]!.score).toBeGreaterThan(0)

    // AND: every term must be present.
    const andHits = await docs.search('title', 'overdue invoice', { match: 'all' })
    expect(andHits.map((h) => h.id)).toEqual(['a'])

    // Typeahead: 'mee' matches 'meeting' as a prefix.
    const typeahead = await docs.search('title', 'mee', { prefix: true })
    expect(typeahead.map((h) => h.id)).toEqual(['c'])

    // Top-N.
    expect(await docs.search('title', 'invoice', { limit: 1 })).toHaveLength(1)

    db.close()
  })
})
