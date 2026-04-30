/**
 * Showcase 20 — withTransactions() (atomic multi-record ops)
 *
 * What you'll learn
 * ─────────────────
 * `runTransaction(db, async (tx) => { ... })` buffers every write in
 * the body, then commits them in a single phase against the store.
 * If any step throws, no writes land. If a casAtomic store is
 * underneath, the transaction is genuinely atomic; on best-effort
 * stores the writes happen in order with rollback on early failure.
 *
 * Why it matters
 * ──────────────
 * Multi-record invariants — "create the invoice AND the payment in
 * the same instant, or neither" — are the bread and butter of
 * accounting workflows. Without transactions, a partial-write window
 * opens up that the audit ledger cannot close.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 00 + 01.
 *
 * What to read next
 * ─────────────────
 *   - showcase 21-with-bundle (durable export of the transactional state)
 *   - docs/subsystems/transactions.md
 *
 * Spec mapping
 * ────────────
 * features.yaml → features → transactions
 */

import { describe, it, expect } from 'vitest'
import { createNoydb, runTransaction } from '@noy-db/hub'
import { withTransactions } from '@noy-db/hub/tx'
import { memory } from '@noy-db/to-memory'

interface Invoice { id: string; amount: number }
interface Payment { id: string; invoiceId: string; amount: number }

describe('Showcase 20 — withTransactions()', () => {
  it('commits two writes atomically', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'with-transactions-passphrase-2026',
      txStrategy: withTransactions(),
    })
    const vault = await db.openVault('demo')
    const invoices = vault.collection<Invoice>('invoices')
    const payments = vault.collection<Payment>('payments')

    await runTransaction(db, (tx) => {
      tx.vault('demo').collection<Invoice>('invoices').put('inv-1', { id: 'inv-1', amount: 100 })
      tx.vault('demo').collection<Payment>('payments').put('pay-1', { id: 'pay-1', invoiceId: 'inv-1', amount: 100 })
    })

    expect(await invoices.get('inv-1')).toEqual({ id: 'inv-1', amount: 100 })
    expect(await payments.get('pay-1')).toEqual({ id: 'pay-1', invoiceId: 'inv-1', amount: 100 })

    db.close()
  })

  it('rolls back when the body throws — no writes leak', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'with-transactions-passphrase-2026',
      txStrategy: withTransactions(),
    })
    const vault = await db.openVault('demo')
    const invoices = vault.collection<Invoice>('invoices')
    const payments = vault.collection<Payment>('payments')

    await expect(
      runTransaction(db, (tx) => {
        tx.vault('demo').collection<Invoice>('invoices').put('inv-2', { id: 'inv-2', amount: 200 })
        throw new Error('business rule violated')
      }),
    ).rejects.toThrow(/business rule/)

    expect(await invoices.get('inv-2')).toBeNull()
    expect(await payments.list()).toEqual([])

    db.close()
  })
})
