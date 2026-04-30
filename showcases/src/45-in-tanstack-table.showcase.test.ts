/**
 * Showcase 45 — in-tanstack-table (table-state ↔ Query DSL bridge)
 *
 * What you'll learn
 * ─────────────────
 * `buildQueryFromTableState(query, state)` translates a TanStack-Table
 * `{ columnFilters, sorting, pagination }` shape into chained `where`
 * / `orderBy` / `offset(pageIndex × pageSize).limit(pageSize)` clauses
 * on a noy-db query. One translation function — every column filter,
 * every sort, every page boundary turns into encrypted-aware DSL.
 *
 * Why it matters
 * ──────────────
 * TanStack Table is the dominant headless table for React/Vue/Solid.
 * The bridge makes sortable, filtered, paginated tables work directly
 * against an encrypted vault.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 10-with-aggregate (query DSL).
 *
 * What to read next
 * ─────────────────
 *   - showcase 46-in-ai (LLM tool-calling adapter)
 *   - docs/packages/in-integrations.md
 *
 * Spec mapping
 * ────────────
 * features.yaml → frameworks → in-tanstack-table
 */

import { describe, it, expect } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { buildQueryFromTableState } from '@noy-db/in-tanstack-table'
import { memory } from '@noy-db/to-memory'

interface Invoice { id: string; amt: number; status: 'draft' | 'paid' }

describe('Showcase 45 — in-tanstack-table', () => {
  it('column filter + sort + pagination compose into the right query', async () => {
    const db = await createNoydb({ store: memory(), user: 'alice', secret: 'in-ttable-pass-2026' })
    const vault = await db.openVault('demo')
    const invoices = vault.collection<Invoice>('invoices')
    await invoices.put('i1', { id: 'i1', amt: 100, status: 'draft' })
    await invoices.put('i2', { id: 'i2', amt: 250, status: 'paid' })
    await invoices.put('i3', { id: 'i3', amt: 500, status: 'paid' })
    await invoices.put('i4', { id: 'i4', amt: 50, status: 'draft' })

    // Filter status=paid + sort by amt desc.
    const sorted = buildQueryFromTableState(invoices.query(), {
      columnFilters: [{ id: 'status', value: 'paid' }],
      sorting: [{ id: 'amt', desc: true }],
    })
    expect(sorted.toArray().map((r) => r.id)).toEqual(['i3', 'i2'])

    // Pagination with no filter — page 1, size 2.
    const page1 = buildQueryFromTableState(invoices.query(), {
      sorting: [{ id: 'amt', desc: false }],
      pagination: { pageIndex: 1, pageSize: 2 },
    })
    expect(page1.toArray().map((r) => r.amt)).toEqual([250, 500])

    db.close()
  })
})
