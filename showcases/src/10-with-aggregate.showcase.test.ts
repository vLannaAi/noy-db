/**
 * Showcase 10 — withAggregate()
 *
 * What you'll learn
 * ─────────────────
 * Aggregations on the query DSL: `sum`, `avg`, `count`, `min`, `max`,
 * plus `groupBy` for compound aggregations. Bins of the same size run
 * in O(N); groupBy walks the cache once with a `Map<groupKey, accum>`.
 *
 * Why it matters
 * ──────────────
 * "Sum these invoices by client" is one of the canonical relational
 * queries. The aggregate subsystem brings it to a zero-knowledge,
 * client-side document store — without ever sending plaintext to a
 * SQL engine.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 00 + 01.
 *
 * What to read next
 * ─────────────────
 *   - showcase 11-with-indexing (faster aggregations on large sets)
 *   - showcase 12-with-joins (aggregate + join scenarios)
 *   - docs/subsystems/aggregate.md
 *
 * Spec mapping
 * ────────────
 * features.yaml → features → aggregate
 */

import { describe, it, expect } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { withAggregate, sum, count, avg } from '@noy-db/hub/aggregate'
import { memory } from '@noy-db/to-memory'

interface Invoice { id: string; clientId: string; amount: number; status: 'draft' | 'paid' }

describe('Showcase 10 — withAggregate()', () => {
  it('runs simple sum + count + avg', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'with-aggregate-passphrase-2026',
      aggregateStrategy: withAggregate(),
    })
    const vault = await db.openVault('demo')
    const invoices = vault.collection<Invoice>('invoices')

    await invoices.put('a', { id: 'a', clientId: 'C1', amount: 100, status: 'paid' })
    await invoices.put('b', { id: 'b', clientId: 'C1', amount: 200, status: 'paid' })
    await invoices.put('c', { id: 'c', clientId: 'C2', amount: 50, status: 'draft' })
    await invoices.put('d', { id: 'd', clientId: 'C2', amount: 150, status: 'paid' })

    const totals = invoices.query().aggregate({
      total: sum('amount'),
      n: count(),
      mean: avg('amount'),
    }).run()
    expect(totals.total).toBe(500)
    expect(totals.n).toBe(4)
    expect(totals.mean).toBe(125)

    db.close()
  })

  it('groups + aggregates by clientId', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'with-aggregate-passphrase-2026',
      aggregateStrategy: withAggregate(),
    })
    const vault = await db.openVault('demo')
    const invoices = vault.collection<Invoice>('invoices')

    await invoices.put('a', { id: 'a', clientId: 'C1', amount: 100, status: 'paid' })
    await invoices.put('b', { id: 'b', clientId: 'C1', amount: 200, status: 'paid' })
    await invoices.put('c', { id: 'c', clientId: 'C2', amount: 50, status: 'paid' })

    const rows = invoices.query().groupBy('clientId').aggregate({
      total: sum('amount'),
      n: count(),
    }).run()
    const byClient = new Map(rows.map((r) => [r.clientId, r]))
    expect(byClient.get('C1')!.total).toBe(300)
    expect(byClient.get('C1')!.n).toBe(2)
    expect(byClient.get('C2')!.total).toBe(50)
    expect(byClient.get('C2')!.n).toBe(1)

    db.close()
  })
})
