/**
 * Showcase 116 — as-xlsx groupBy summary sheets (#414 P3)
 *
 * What you'll learn
 * ─────────────────
 * The analytical layer: declare a `summaries` spec and `toBytes({ smart: true })`
 * emits a summary sheet whose cells are **live** `SUMIFS`/`COUNTIFS`/`AVERAGEIFS`
 * formulas over a data sheet (one row per distinct group), with the value cached
 * at export. Edit the source rows and the totals recompute in Excel/Sheets.
 *
 * Why it matters
 * ──────────────
 * A flat export makes the analyst rebuild pivots by hand. Here the workbook
 * ships with the group-by analysis already wired and live — built on the same
 * formula engine as the FK lookups and the LANG cell. (Source value columns must
 * be numeric for the live math — apply `numberFormats` to money fields.)
 *
 * Spec mapping
 * ────────────
 *   #414 — as-xls smart workbook (P3: computed groupBy → SUMIFS)
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, ref } from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'
import { toBytes, readXlsx } from '@noy-db/as-xlsx'

describe('showcase 116 — as-xlsx groupBy summary', () => {
  it('emits a live SUMIFS/COUNTIFS summary sheet grouped by a field', async () => {
    const store = memory()
    const init = await createNoydb({ store, user: 'alice', secret: 'pw-116' })
    await init.openVault('firm')
    await init.grant('firm', {
      userId: 'alice', displayName: 'Alice', role: 'owner', passphrase: 'pw-116',
      exportCapability: { plaintext: ['xlsx'] },
    })
    init.close()

    const db = await createNoydb({ store, user: 'alice', secret: 'pw-116' })
    const vault = await db.openVault('firm')
    await vault.collection<{ id: string; name: string }>('clients').put('c1', { id: 'c1', name: 'Acme' })
    const invoices = vault.collection<{ id: string; clientId: string; amount: number }>('invoices', {
      refs: { clientId: ref('clients', 'strict') },
    })
    await invoices.put('i1', { id: 'i1', clientId: 'c1', amount: 100 })
    await invoices.put('i2', { id: 'i2', clientId: 'c1', amount: 50 })

    const wb = await readXlsx(await toBytes(vault, {
      smart: true,
      sheets: [{ name: 'clients', collection: 'clients' }, { name: 'invoices', collection: 'invoices' }],
      summaries: [{
        name: 'byClient',
        from: 'invoices',
        groupBy: 'clientId',
        aggregates: [{ label: 'total', op: 'sum', field: 'amount' }, { label: 'invoices', op: 'count' }],
      }],
    }))

    const sum = wb.sheets.find((s) => s.name === 'byClient')!
    const h: Record<string, string> = {}
    for (const [letter, name] of Object.entries(sum.rows[0] ?? {})) h[String(name)] = letter
    const row = sum.rows.slice(1).find((r) => r[h['clientId']!] === 'c1')!
    expect(row[h['total']!]).toBe(150) // live SUMIFS, cached
    expect(row[h['invoices']!]).toBe(2) // live COUNTIFS, cached
  })
})
