/**
 * Showcase 114 — as-xlsx smart workbook (#414 P1)
 *
 * What you'll learn
 * ─────────────────
 * `toBytes(vault, { smart: true })` projects a vault as a *relational* workbook
 * rather than a flat dump:
 *   1. Every sheet is **id-first** (record `id` in column A).
 *   2. Each foreign-key field (auto-detected via `vault.dumpSchema()`) gets a
 *      `<field>__label` column — a cross-sheet **VLOOKUP** that resolves the
 *      reference to the target's first field. It carries a **cached** label, so
 *      the value shows immediately on open AND recomputes live if you edit the
 *      target sheet.
 *   3. A `_manifest` index sheet lists every collection, its row count, and its
 *      refs.
 *
 * Why it matters
 * ──────────────
 * A flat export loses the relational shape — a `clientId` column is just an
 * opaque code. Smart mode turns it into a live, human-readable lookup, the way
 * an analyst would build the workbook by hand. This is P1 of the as-xls
 * milestone (structural/relational); localization (a global language cell) and
 * computed formulas (groupBy/MV → SUMIFS) follow.
 *
 * Spec mapping
 * ────────────
 *   #414 — as-xls smart workbook (P1: structural export)
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, ref } from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'
import { toBytes, readXlsx } from '@noy-db/as-xlsx'

describe('showcase 114 — as-xlsx smart workbook', () => {
  it('FK fields become live VLOOKUP label columns; a _manifest indexes the workbook', async () => {
    const store = memory()
    const init = await createNoydb({ store, user: 'alice', secret: 'pw-114' })
    await init.openVault('firm')
    await init.grant('firm', {
      userId: 'alice', displayName: 'Alice', role: 'owner', passphrase: 'pw-114',
      exportCapability: { plaintext: ['xlsx'] },
    })
    init.close()

    const db = await createNoydb({ store, user: 'alice', secret: 'pw-114' })
    const vault = await db.openVault('firm')
    await vault.collection<{ id: string; name: string }>('clients').put('c1', { id: 'c1', name: 'Acme' })
    await vault.collection<{ id: string; clientId: string; amount: number }>('invoices', {
      refs: { clientId: ref('clients', 'strict') },
    }).put('i1', { id: 'i1', clientId: 'c1', amount: 100 })

    const wb = await readXlsx(await toBytes(vault, {
      smart: true,
      sheets: [{ name: 'clients', collection: 'clients' }, { name: 'invoices', collection: 'invoices' }],
    }))

    expect(wb.sheets.map((s) => s.name)).toContain('_manifest')

    const inv = wb.sheets.find((s) => s.name === 'invoices')!
    const header: Record<string, string> = {}
    for (const [letter, name] of Object.entries(inv.rows[0] ?? {})) header[String(name)] = letter
    const row = inv.rows.slice(1).find((r) => r[header['id']!] === 'i1')!
    expect(row[header['clientId__label']!]).toBe('Acme') // resolved via cross-sheet VLOOKUP (cached)
  })
})
