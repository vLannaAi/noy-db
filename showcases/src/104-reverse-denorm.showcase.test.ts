/**
 * Showcase 104 — reverse-denormalization (FK derivation triggers)
 *
 * What you'll learn
 * ─────────────────
 * `triggerBy: [{ collection, on }]` keeps a denormalized field on many
 * child records in sync with a parent change — keyed by a foreign key, not
 * a shared id. A buyer rename fans out to every sale that references it.
 *
 *   - A self-write output (collection === source) declaring `denorm`
 *     patches ONLY the named fields back onto the source record.
 *   - Other fields on the sale are never clobbered.
 *   - The value-equality guard terminates the self-write cleanly.
 *
 * Why it matters
 * ──────────────
 * "The buyer's name changed but old sales still show the old name" is a
 * classic stale-denormalization bug. Declaring the dependency once moves
 * the maintenance into the data layer — the snapshot can't drift.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 00 + 80 (withDerivation).
 *
 * What to read next
 * ─────────────────
 *   - showcase 80-with-derivation (the base primitive)
 *   - docs/subsystems/derivations.md
 *
 * Spec mapping
 * ────────────
 * features.yaml → features → derivations
 */

import { describe, it, expect } from 'vitest'
import { createNoydb, withDerivation } from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'

interface Buyer extends Record<string, unknown> { id: string; companyName: string }
interface Sale extends Record<string, unknown> { id: string; buyerId: string; total: number; buyerName?: string; note?: string }

describe('Showcase 104 — reverse-denormalization', () => {
  it('a buyer rename refreshes buyerName on all their sales', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'reverse-denorm-showcase-2026',
      derivationStrategies: [
        withDerivation<Sale, { self: Sale }>({
          source: 'sales',
          deterministic: true,
          // A write to buyers fans out to every sale whose buyerId matches.
          triggerBy: [{ collection: 'buyers', on: 'buyerId' }],
          // Self-write: patch ONLY buyerName back onto the sale (field-level).
          outputs: { self: { shape: 'record', collection: 'sales', denorm: ['buyerName'] } },
          derive: async (sale, ctx) => {
            const b = await ctx.vault.collection<Buyer>('buyers').get(sale.buyerId)
            return { self: { ...sale, buyerName: b?.companyName ?? null } as Sale }
          },
          lifecycle: 'eager',
        }),
      ],
    })
    const vault = await db.openVault('firm')
    const buyers = vault.collection<Buyer>('buyers')
    // Index the FK so the fan-out is O(matching sales), not a scan.
    const sales = vault.collection<Sale>('sales', { indexes: ['buyerId'] })

    await buyers.put('b1', { id: 'b1', companyName: 'Acme' })
    await sales.put('s1', { id: 's1', buyerId: 'b1', total: 100, note: 'first order' })
    await sales.put('s2', { id: 's2', buyerId: 'b1', total: 250 })
    // buyerName is stamped on insert too (source-path derivation).
    expect((await sales.get('s1'))?.buyerName).toBe('Acme')

    // Rename the buyer → every referencing sale refreshes.
    await buyers.put('b1', { id: 'b1', companyName: 'Acme Corporation' })
    expect((await sales.get('s1'))?.buyerName).toBe('Acme Corporation')
    expect((await sales.get('s2'))?.buyerName).toBe('Acme Corporation')

    // Non-denorm fields are preserved through the patch.
    expect((await sales.get('s1'))?.note).toBe('first order')
    expect((await sales.get('s1'))?.total).toBe(100)

    db.close()
  })
})
