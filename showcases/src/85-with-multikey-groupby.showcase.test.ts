/**
 * Showcase 85 — multi-key groupBy
 *
 * What you'll learn
 * ─────────────────
 * Group records by TWO OR MORE fields. The chainable builder accepts a
 * variadic `groupBy(...fields)` call; result rows carry every grouped
 * field (in declaration order) plus the reducer outputs.
 *
 * Why it matters
 * ──────────────
 * Real-world roll-ups are rarely keyed by a single field. A
 * per-(client, period) summary, a per-(tenant, region, period) tax
 * obligation, an audit feed sliced by both subject and action —
 * composite keys are everywhere. Multi-key groupBy lets you express
 * that directly, with no synthetic concatenated-key field on the
 * source schema.
 *
 * Prerequisites
 * ─────────────
 *   - Showcase 10 (single-key groupBy + aggregate)
 *
 * What to read next
 * ─────────────────
 *   - Showcase 81 (withMaterializedView eager refresh)
 *   - docs/subsystems/aggregate.md § Multi-key groupBy
 *
 * Spec mapping
 * ────────────
 * features.yaml → features → aggregate (multi-key invariant)
 * features.yaml → features → materialized-views (multi-key inside `query`)
 */

import { describe, it, expect } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { withAggregate, sum, count } from '@noy-db/hub/aggregate'
import { memory } from '@noy-db/to-memory'

interface Invoice {
  id: string
  clientId: string
  period: string
  amount: number
}

describe('Showcase 85 — multi-key groupBy', () => {
  it('groups by (clientId, period) and returns one row per distinct tuple', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'showcase-85-multikey-passphrase-2026',
      aggregateStrategy: withAggregate(),
    })
    const vault = await db.openVault('books')
    const invoices = vault.collection<Invoice>('invoices')

    // Fixture: 4 invoices spread across 3 distinct (clientId, period)
    // tuples — (acme, 2026-04) has two rows; the other two tuples have
    // one row each.
    await invoices.put('i1', { id: 'i1', clientId: 'acme',   period: '2026-04', amount: 100 })
    await invoices.put('i2', { id: 'i2', clientId: 'acme',   period: '2026-04', amount: 200 })
    await invoices.put('i3', { id: 'i3', clientId: 'acme',   period: '2026-05', amount: 150 })
    await invoices.put('i4', { id: 'i4', clientId: 'globex', period: '2026-04', amount: 500 })

    const rows = invoices
      .query()
      .groupBy('clientId', 'period')
      .aggregate({ total: sum('amount'), n: count() })
      .run()

    // Three distinct buckets. Result rows carry both grouped fields
    // (declaration order: clientId, period) plus the reducer outputs.
    expect(rows).toHaveLength(3)

    const byTuple = new Map(
      rows.map((r) => [`${r.clientId}|${r.period}`, r]),
    )

    expect(byTuple.get('acme|2026-04')!.total).toBe(300)
    expect(byTuple.get('acme|2026-04')!.n).toBe(2)

    expect(byTuple.get('acme|2026-05')!.total).toBe(150)
    expect(byTuple.get('acme|2026-05')!.n).toBe(1)

    expect(byTuple.get('globex|2026-04')!.total).toBe(500)
    expect(byTuple.get('globex|2026-04')!.n).toBe(1)

    db.close()
  })

  it('declaration order of fields does not affect bucket identity', async () => {
    // `.groupBy('a', 'b')` and `.groupBy('b', 'a')` produce the SAME
    // logical buckets — the canonical key sorts field names before
    // hashing. The only difference is the property order on the
    // emitted row (cosmetic).
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'showcase-85-order-passphrase-2026',
      aggregateStrategy: withAggregate(),
    })
    const vault = await db.openVault('books')
    const invoices = vault.collection<Invoice>('invoices')

    // Fixture: three records spanning TWO distinct (clientId, period)
    // tuples. A buggy implementation that didn't sort field names in
    // the canonical key would treat ('clientId','period') and
    // ('period','clientId') as different bucket spaces — producing a
    // different bucket SET (not just different row property order)
    // when the same input data is grouped under each ordering.
    await invoices.put('i1', { id: 'i1', clientId: 'acme',   period: '2026-04', amount: 100 })
    await invoices.put('i2', { id: 'i2', clientId: 'acme',   period: '2026-04', amount: 50 })
    await invoices.put('i3', { id: 'i3', clientId: 'globex', period: '2026-04', amount: 200 })

    const rowsForward = invoices
      .query()
      .groupBy('clientId', 'period')
      .aggregate({ total: sum('amount') })
      .run()

    const rowsReversed = invoices
      .query()
      .groupBy('period', 'clientId')
      .aggregate({ total: sum('amount') })
      .run()

    // Both orderings produce the same bucket COUNT…
    expect(rowsForward).toHaveLength(2)
    expect(rowsReversed).toHaveLength(2)

    // …and the same bucket CONTENTS (totals per clientId).
    const forwardByClient = new Map(rowsForward.map((r) => [r.clientId, r]))
    const reversedByClient = new Map(rowsReversed.map((r) => [r.clientId, r]))

    expect(forwardByClient.get('acme')!.total).toBe(150)
    expect(forwardByClient.get('globex')!.total).toBe(200)
    expect(reversedByClient.get('acme')!.total).toBe(150)
    expect(reversedByClient.get('globex')!.total).toBe(200)

    // Property order on emitted rows DOES follow declaration order
    // (cosmetic, but pinned so consumers can rely on it).
    expect(Object.keys(rowsForward[0]).slice(0, 2)).toEqual(['clientId', 'period'])
    expect(Object.keys(rowsReversed[0]).slice(0, 2)).toEqual(['period', 'clientId'])

    db.close()
  })
})
