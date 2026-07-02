/**
 * Showcase 105 — rollups (aggregate onto a parent field)
 *
 * What you'll learn
 * ─────────────────
 * `withRollup({ from, key, into, field, compute })` keeps a maintained
 * summary on a parent record, folded from its children by foreign key. It
 * recomputes on child insert, update, AND delete — gap-free — so the
 * parent's total never drifts from the children that produced it.
 *
 *   - sales → buyer.revenueByYear, aggregated by buyerId.
 *   - Deleting a sale recomputes the buyer (no overcount).
 *   - Only the rollup field is touched on the parent.
 *
 * Why it matters
 * ──────────────
 * "Stats computed two different ways that disagree" is a recurring class.
 * One declared rollup is the single source of truth — the parent carries
 * the answer, maintained by the data layer, queryable without a scan.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 00 + 80 (withDerivation) + 104 (reverse-denorm).
 *
 * What to read next
 * ─────────────────
 *   - docs/services/derivations.md
 *
 * Spec mapping
 * ────────────
 * features.yaml → features → derivations
 */

import { describe, it, expect } from 'vitest'
import { createNoydb, withRollup } from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'

interface Buyer extends Record<string, unknown> { id: string; companyName: string; revenueByYear?: Record<string, number> }
interface Sale extends Record<string, unknown> { id: string; buyerId: string; total: number; year: number }

describe('Showcase 105 — rollups', () => {
  it('maintains buyer.revenueByYear across child insert / update / delete', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'rollup-showcase-2026',
      derivationStrategies: [
        withRollup<Sale, Buyer>({
          from: 'sales',
          key: 'buyerId',
          into: 'buyers',
          field: 'revenueByYear',
          compute: (sales) => {
            const byYear: Record<string, number> = {}
            for (const s of sales) byYear[String(s.year)] = (byYear[String(s.year)] ?? 0) + s.total
            return byYear
          },
        }),
      ],
    })
    const vault = await db.openVault('firm')
    const buyers = vault.collection<Buyer>('buyers')
    const sales = vault.collection<Sale>('sales', { indexes: ['buyerId'] })

    await buyers.put('b1', { id: 'b1', companyName: 'Acme' })

    await sales.put('s1', { id: 's1', buyerId: 'b1', total: 100, year: 2026 })
    await sales.put('s2', { id: 's2', buyerId: 'b1', total: 250, year: 2026 })
    await sales.put('s3', { id: 's3', buyerId: 'b1', total: 70, year: 2027 })
    expect((await buyers.get('b1'))?.revenueByYear).toEqual({ '2026': 350, '2027': 70 })

    // Delete a sale → the buyer recomputes, no overcount.
    await sales.delete('s2')
    expect((await buyers.get('b1'))?.revenueByYear).toEqual({ '2026': 100, '2027': 70 })

    // The parent's own fields are untouched by the rollup patch.
    expect((await buyers.get('b1'))?.companyName).toBe('Acme')

    db.close()
  })
})
