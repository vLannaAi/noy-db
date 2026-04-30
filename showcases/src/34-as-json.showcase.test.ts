/**
 * Showcase 34 — as-json (structured multi-collection export)
 *
 * What you'll learn
 * ─────────────────
 * `toString(vault, { pretty: 2 })` serializes the entire vault as a
 * pretty-printed JSON document, one top-level key per collection. The
 * `collections` allowlist restricts the output to a subset; unauthorized
 * collections silently drop out (ACL-scoping at the export-stream
 * layer).
 *
 * Why it matters
 * ──────────────
 * JSON is the lingua franca for in-process pipelines, ETL handoffs, and
 * test fixtures. The structured shape preserves collection boundaries
 * which CSV/XLSX flatten away.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 32-as-csv.
 *
 * What to read next
 * ─────────────────
 *   - showcase 35-as-zip (composite records + attachments archive)
 *   - docs/subsystems/exports.md
 *
 * Spec mapping
 * ────────────
 * features.yaml → exports → as-json
 */

import { describe, it, expect } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { toString, toObject } from '@noy-db/as-json'
import { memory } from '@noy-db/to-memory'

interface Invoice { id: string; amount: number }

describe('Showcase 34 — as-json', () => {
  it('toObject groups records under their collection name', async () => {
    const store = memory()
    const db = await createNoydb({ store, user: 'alice', secret: 'as-json-pass-2026' })
    const vault = await db.openVault('demo')
    await vault.collection<Invoice>('invoices').put('a', { id: 'a', amount: 100 })
    await vault.collection<Invoice>('invoices').put('b', { id: 'b', amount: 200 })

    await db.grant('demo', {
      userId: 'alice', displayName: 'Alice', role: 'owner',
      passphrase: 'as-json-pass-2026',
      exportCapability: { plaintext: ['json'] },
    })
    db.close()

    const db2 = await createNoydb({ store, user: 'alice', secret: 'as-json-pass-2026' })
    const v2 = await db2.openVault('demo')

    const doc = await toObject(v2, {})
    expect(Object.keys(doc)).toContain('invoices')
    expect(doc['invoices']).toHaveLength(2)

    const text = await toString(v2, { pretty: 2 })
    expect(text.includes('"invoices"')).toBe(true)
    expect(text).toContain('  ') // pretty-printed
    db2.close()
  })
})
