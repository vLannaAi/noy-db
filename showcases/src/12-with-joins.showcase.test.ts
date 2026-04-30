/**
 * Showcase 12 — Joins (always-core today)
 *
 * What you'll learn
 * ─────────────────
 * Joins are intra-vault and core-side: declare a foreign key with
 * `ref('targetCollection')` on a field, then chain `.join('field',
 * { as: 'alias' })` on a query. The hub's planner picks indexed-
 * nested-loop or hash strategy, executes after decryption, and
 * embeds the right-side record on each left row.
 *
 * Why it matters
 * ──────────────
 * The store never sees plaintext, so it never runs your join. Joins
 * happen in core after decrypt, which means even foreign-key
 * traversal stays zero-knowledge to the backend.
 *
 * Prerequisites
 * ─────────────
 * - Showcases 00 + 01 + 11.
 *
 * What to read next
 * ─────────────────
 *   - showcase 13-with-live (reactive joined queries)
 *   - docs/subsystems/joins.md (`(planned: @noy-db/hub/joins)`)
 *
 * Spec mapping
 * ────────────
 * features.yaml → features → joins
 *
 * Note: joins are always-core today. The plan tracks a future
 * `withJoins()` extraction so apps that don't need joins can
 * tree-shake them out.
 */

import { describe, it, expect } from 'vitest'
import { createNoydb, ref } from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'

interface Client { id: string; name: string }
interface Invoice { id: string; clientId: string; amount: number }

describe('Showcase 12 — Joins', () => {
  it('embeds the joined right-side record on each left row', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'with-joins-passphrase-2026',
    })
    const vault = await db.openVault('demo')

    const clients = vault.collection<Client>('clients')
    const invoices = vault.collection<Invoice>('invoices', {
      refs: { clientId: ref('clients') },
    })

    await clients.put('C1', { id: 'C1', name: 'Acme Corp' })
    await clients.put('C2', { id: 'C2', name: 'Bravo Ltd' })
    await invoices.put('inv-1', { id: 'inv-1', clientId: 'C1', amount: 100 })
    await invoices.put('inv-2', { id: 'inv-2', clientId: 'C2', amount: 200 })

    const rows = invoices
      .query()
      .join<'client', Client>('clientId', { as: 'client' })
      .toArray()

    const byId = new Map(rows.map((r) => [r.id, r]))
    expect(byId.get('inv-1')!.client?.name).toBe('Acme Corp')
    expect(byId.get('inv-2')!.client?.name).toBe('Bravo Ltd')

    db.close()
  })
})
