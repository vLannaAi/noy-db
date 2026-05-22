/**
 * Showcase 86 — UNION MV (withMaterializedView reads multiple sibling collections)
 *
 * What you'll learn
 * ─────────────────
 * Read from TWO OR MORE sibling collections in one materialized view via
 * `unionSources`. Per-source `map` projects each arm into the MV's row
 * shape; `groupBy` + `aggregate` then run on the concatenated stream.
 *
 * Why it matters
 * ──────────────
 * Many real-world roll-ups span more than one source: a monthly VAT
 * obligation combining tax receipts and credit notes, a unified audit
 * feed merging two log shapes, a per-tenant report joining structurally-
 * similar tables. Without UNION MV, consumers maintain parallel MVs and
 * sum at read time — defeating the "no imperative transforms outside
 * primitives" rule.
 *
 * Prerequisites
 * ─────────────
 *   - Showcase 81 (withMaterializedView basics)
 *   - Showcase 85 (multi-key groupBy)
 *
 * What to read next
 * ─────────────────
 *   - docs/subsystems/derivations.md (UNION sources section)
 *
 * Spec mapping
 * ────────────
 * features.yaml → features → materialized-views (unionSources invariant)
 */

import { describe, it, expect } from 'vitest'
import { createNoydb, withMaterializedView, sum } from '@noy-db/hub'
import { withAggregate } from '@noy-db/hub/aggregate'
import { memory } from '@noy-db/to-memory'

interface TaxReceipt {
  id: string
  issuedAt: string
  vatAmount: number
}

interface CreditNote {
  id: string
  issuedAt: string
  vatAmount: number
}

interface MonthlyVatRow extends Record<string, unknown> {
  period: string
  vat: number
}

describe('Showcase 86 — UNION MV', () => {
  it('monthly VAT = sum(taxReceipts.vat) - sum(creditNotes.vat) keyed by period', async () => {
    // The MV reads from TWO sibling source collections. Each arm's `map`
    // projects its source shape into the MV's row shape `{ period, vat }`
    // — taxReceipts contribute positive vat, creditNotes contribute
    // negative vat. The concatenated stream is then grouped by period and
    // summed by the existing aggregate pipeline.
    const monthlyVat = withMaterializedView<MonthlyVatRow>({
      name: 'monthlyVat',
      unionSources: [
        {
          collection: 'taxReceipts',
          map: (r) => {
            const tr = r as unknown as TaxReceipt
            return { period: tr.issuedAt.slice(0, 7), vat: tr.vatAmount }
          },
        },
        {
          collection: 'creditNotes',
          map: (r) => {
            const cn = r as unknown as CreditNote
            return { period: cn.issuedAt.slice(0, 7), vat: -cn.vatAmount }
          },
        },
      ],
      groupBy: 'period',
      aggregate: { vat: sum('vat') },
      rowKey: (row) => row.period,
      refresh: 'eager',
    })

    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'showcase-86-union-mv-passphrase-2026',
      materializedViewStrategies: [monthlyVat],
      aggregateStrategy: withAggregate(),
    })
    const vault = await db.openVault('books')

    const receipts = vault.collection<TaxReceipt>('taxReceipts')
    const creditNotes = vault.collection<CreditNote>('creditNotes')

    // Two receipts and one credit note, all in 2026-05.
    // Net VAT for the month = (100 + 50) - 30 = 120.
    await receipts.put('r-1', { id: 'r-1', issuedAt: '2026-05-15', vatAmount: 100 })
    await receipts.put('r-2', { id: 'r-2', issuedAt: '2026-05-20', vatAmount: 50 })
    await creditNotes.put('cn-1', { id: 'cn-1', issuedAt: '2026-05-25', vatAmount: 30 })

    // The MV output collection holds one row per `rowKey` — here, one
    // row per period. Both arms feed the same bucket.
    const out = vault.collection<MonthlyVatRow>('monthlyVat')
    const row = await out.get('2026-05')

    expect(row).not.toBeNull()
    expect(row?.period).toBe('2026-05')
    expect(row?.vat).toBe(120)

    // Writing to EITHER arm refreshes the MV (eager). Add a second
    // credit note and the period total drops accordingly.
    await creditNotes.put('cn-2', { id: 'cn-2', issuedAt: '2026-05-28', vatAmount: 20 })

    const refreshed = await out.get('2026-05')
    expect(refreshed?.vat).toBe(100) // 150 (receipts) - 50 (credit notes)

    db.close()
  })
})
