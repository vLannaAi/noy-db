/**
 * Showcase 118 — as-xlsx Google-Sheets QUERY dialect (#414 P5)
 *
 * What you'll learn
 * ─────────────────
 * Smart export's summary sheets default to cross-compatible per-row SUMIFS
 * (Excel + Sheets). With `dialect: 'sheets'` each summary instead becomes a
 * single live **`QUERY`** formula — the idiomatic Google Sheets way to group
 * and aggregate, auto-expanding as the source grows.
 *
 * Why it matters
 * ──────────────
 * `QUERY` is Sheets-only (it errors in Excel), so it can't be the default — but
 * when the target IS Google Sheets, one QUERY cell beats N SUMIFS rows: it
 * spills, recomputes live, and reads like SQL. Pick the dialect for your target.
 *
 * Spec mapping
 * ────────────
 *   #414 — as-xls smart workbook (P5: Sheets-native QUERY dialect)
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, ref } from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'
import { readZip } from '@noy-db/as-zip'
import { toBytes } from '@noy-db/as-xlsx'

const DEC = new TextDecoder()

describe('showcase 118 — as-xlsx Sheets QUERY dialect', () => {
  it('dialect:"sheets" emits a single QUERY formula per summary', async () => {
    const store = memory()
    const init = await createNoydb({ store, user: 'alice', secret: 'pw-118' })
    await init.openVault('firm')
    await init.grant('firm', {
      userId: 'alice', displayName: 'Alice', role: 'owner', passphrase: 'pw-118',
      exportCapability: { plaintext: ['xlsx'] },
    })
    init.close()

    const db = await createNoydb({ store, user: 'alice', secret: 'pw-118' })
    const vault = await db.openVault('firm')
    await vault.collection<{ id: string; name: string }>('clients').put('c1', { id: 'c1', name: 'Acme' })
    const invoices = vault.collection<{ id: string; clientId: string; amount: number }>('invoices', {
      refs: { clientId: ref('clients', 'strict') },
    })
    await invoices.put('i1', { id: 'i1', clientId: 'c1', amount: 100 })
    await invoices.put('i2', { id: 'i2', clientId: 'c1', amount: 50 })

    const bytes = await toBytes(vault, {
      smart: true,
      dialect: 'sheets',
      sheets: [{ name: 'clients', collection: 'clients' }, { name: 'invoices', collection: 'invoices' }],
      summaries: [{
        name: 'byClient',
        from: 'invoices',
        groupBy: 'clientId',
        aggregates: [{ label: 'total', op: 'sum', field: 'amount' }, { label: 'invoices', op: 'count' }],
      }],
    })

    const xmls = (await readZip(bytes))
      .filter((p) => /xl\/worksheets\/sheet\d+\.xml/.test(p.path))
      .map((p) => DEC.decode(p.bytes))
    expect(xmls.some((x) => x.includes('QUERY(') && x.includes('GROUP BY'))).toBe(true)
  })
})
