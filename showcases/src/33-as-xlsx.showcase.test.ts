/**
 * Showcase 33 — as-xlsx (Excel multi-sheet export)
 *
 * What you'll learn
 * ─────────────────
 * `toBytes(vault, { sheets })` produces a real `.xlsx` file (Office Open
 * XML) — one sheet per source collection, scriptable column ordering,
 * optional row filter. Zero runtime deps; the package builds OOXML in
 * memory and assembles it via `as-zip`'s STORE encoder.
 *
 * Why it matters
 * ──────────────
 * Accountants live in Excel. Multi-sheet exports preserve the relational
 * shape of the data (invoices on one tab, payments on another) without
 * forcing the consumer to assemble the workbook by hand.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 32-as-csv (the export-capability gate).
 *
 * What to read next
 * ─────────────────
 *   - showcase 34-as-json (multi-collection structured export)
 *   - docs/subsystems/exports.md
 *
 * Spec mapping
 * ────────────
 * features.yaml → exports → as-xlsx
 */

import { describe, it, expect } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { toBytes } from '@noy-db/as-xlsx'
import { memory } from '@noy-db/to-memory'

interface Invoice { id: string; amount: number }
interface Payment { id: string; amount: number }

describe('Showcase 33 — as-xlsx', () => {
  it('emits a valid OOXML byte stream with multiple sheets', async () => {
    const store = memory()
    const db = await createNoydb({ store, user: 'alice', secret: 'as-xlsx-pass-2026' })
    const vault = await db.openVault('demo')
    await vault.collection<Invoice>('invoices').put('a', { id: 'a', amount: 100 })
    await vault.collection<Payment>('payments').put('p', { id: 'p', amount: 100 })

    await db.grant('demo', {
      userId: 'alice', displayName: 'Alice', role: 'owner',
      passphrase: 'as-xlsx-pass-2026',
      exportCapability: { plaintext: ['xlsx'] },
    })
    db.close()

    const db2 = await createNoydb({ store, user: 'alice', secret: 'as-xlsx-pass-2026' })
    const v2 = await db2.openVault('demo')

    const bytes = await toBytes(v2, {
      sheets: [
        { name: 'Invoices', collection: 'invoices' },
        { name: 'Payments', collection: 'payments' },
      ],
    })

    // First two bytes of any zip file are 'PK' (xlsx is a zip of OOXML parts).
    expect(bytes[0]).toBe(0x50)
    expect(bytes[1]).toBe(0x4b)
    expect(bytes.byteLength).toBeGreaterThan(200)
    db2.close()
  })
})
