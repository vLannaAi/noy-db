/**
 * Showcase 101 — transitionGuard (state-machine lifecycle)
 *
 * What you'll learn
 * ─────────────────
 * `transitionGuard` turns a lifecycle field into a declarative state
 * machine. You give it the allowed arcs; it rejects every write that
 * moves the field along an edge you didn't declare — no hand-rolled
 * `check` boilerplate. It's sugar over `withGuard`, so it inherits the
 * ledgered `amendment` override for sanctioned exceptions.
 *
 *   - A `sales` record walks draft → to_verify → proforma → invoiced → paid.
 *   - An illegal jump (draft → paid) is rejected with IllegalTransitionError.
 *   - An admin/owner amendment transaction can override an illegal arc
 *     (and the override is recorded on the audit ledger).
 *
 * Why it matters
 * ──────────────
 * Lifecycle bugs ("an invoice went back to draft after being paid") are
 * a recurring class. Declaring the graph once, at the data layer, makes
 * the illegal transition structurally impossible for normal writes while
 * still allowing an auditable manual correction.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 00 + 79 (withGuard) + 20 (transactions).
 *
 * What to read next
 * ─────────────────
 *   - showcase 79-with-guard (the underlying primitive)
 *   - docs/services/guards.md
 *
 * Spec mapping
 * ────────────
 * features.yaml → features → transition-guard
 */

import { describe, it, expect } from 'vitest'
import { createNoydb, transitionGuard, IllegalTransitionError } from '@noy-db/hub'
import { withTransactions } from '@noy-db/hub/tx'
import { withHistory } from '@noy-db/hub/history'
import { memory } from '@noy-db/to-memory'

interface Sale extends Record<string, unknown> { id: string; status: string; total: number }

async function open() {
  const db = await createNoydb({
    store: memory(),
    user: 'alice',
    secret: 'transition-guard-showcase-2026',
    historyStrategy: withHistory(),
    txStrategy: withTransactions(),
    guardStrategies: [
      transitionGuard<Sale>({
        collection: 'sales',
        field: 'status',
        transitions: {
          draft: ['to_verify', 'cancelled'],
          to_verify: ['proforma', 'draft', 'cancelled'],
          proforma: ['invoiced', 'cancelled'],
          invoiced: ['paid'],
          paid: [],
          cancelled: [],
        },
        initial: ['draft'],
      }),
    ],
  })
  const vault = await db.openVault('firm')
  return { db, vault, sales: vault.collection<Sale>('sales') }
}

describe('Showcase 101 — transitionGuard', () => {
  it('walks the declared lifecycle and rejects an illegal jump', async () => {
    const { db, sales } = await open()

    await sales.put('s1', { id: 's1', status: 'draft', total: 100 })
    await sales.put('s1', { id: 's1', status: 'to_verify', total: 100 })
    await sales.put('s1', { id: 's1', status: 'proforma', total: 100 })
    await sales.put('s1', { id: 's1', status: 'invoiced', total: 100 })
    await sales.put('s1', { id: 's1', status: 'paid', total: 100 })
    expect((await sales.get('s1'))?.status).toBe('paid')

    // A fresh sale cannot jump straight to paid.
    await sales.put('s2', { id: 's2', status: 'draft', total: 50 })
    await expect(sales.put('s2', { id: 's2', status: 'paid', total: 50 }))
      .rejects.toBeInstanceOf(IllegalTransitionError)
    expect((await sales.get('s2'))?.status).toBe('draft') // unchanged

    db.close()
  })

  it('an admin/owner amendment overrides an illegal arc and is ledgered', async () => {
    const { db, vault, sales } = await open()
    await sales.put('s1', { id: 's1', status: 'draft', total: 100 })

    // Manual correction: jump draft → paid via an amendment.
    await db.transaction({ amendment: true, reason: 'reconciliation: legacy import' }, async (tx) => {
      tx.vault('firm').collection<Sale>('sales').put('s1', { id: 's1', status: 'paid', total: 100 })
    })
    expect((await sales.get('s1'))?.status).toBe('paid')

    // The override is on the audit ledger.
    const entries = await vault.ledger().entries()
    expect(entries.some((e) => e.op === 'amendment')).toBe(true)

    db.close()
  })
})
