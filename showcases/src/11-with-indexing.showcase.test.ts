/**
 * Showcase 11 — withIndexing()
 *
 * What you'll learn
 * ─────────────────
 * Eager-mode indexes maintain `_idx/<field>/<id>` side-cars on every
 * put/delete; `==` and `in` queries hit the index instead of doing a
 * linear scan. Lazy mode (`prefetch: false` + `cache: { maxRecords }`)
 * keeps the working set small in memory and uses the index to fetch
 * on demand — `collection.lazyQuery(...)`.
 *
 * Why it matters
 * ──────────────
 * Eager mode handles 1K-50K records comfortably; lazy mode pushes the
 * ceiling to ~500K with a fixed memory budget. The index choice is
 * runtime-tunable via `collection<T>(name, { indexes, cache })`.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 10-with-aggregate (queries baseline).
 *
 * What to read next
 * ─────────────────
 *   - showcase 12-with-joins (joined-query optimisation)
 *   - docs/subsystems/indexing.md
 *
 * Spec mapping
 * ────────────
 * features.yaml → features → indexing
 */

import { describe, it, expect } from 'vitest'
import { createNoydb } from '@noy-db/hub'
import { withIndexing } from '@noy-db/hub/indexing'
import { memory } from '@noy-db/to-memory'

interface Invoice {
  id: string
  clientId: string
  status: 'draft' | 'paid' | 'overdue'
  amount: number
}

describe('Showcase 11 — withIndexing()', () => {
  it('eager-mode indexed `==` query returns the matching subset', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'with-indexing-passphrase-2026',
      indexStrategy: withIndexing(),
    })
    const vault = await db.openVault('demo')
    const invoices = vault.collection<Invoice>('invoices', { indexes: ['status'] })

    await invoices.put('a', { id: 'a', clientId: 'C1', status: 'paid', amount: 100 })
    await invoices.put('b', { id: 'b', clientId: 'C2', status: 'draft', amount: 50 })
    await invoices.put('c', { id: 'c', clientId: 'C1', status: 'paid', amount: 200 })

    // The `where('status', '==', ...)` clause is dispatched to the
    // index — no linear scan — and returns only the two paid records.
    const paid = invoices.query().where('status', '==', 'paid').toArray()
    expect(paid.map((r) => r.id).sort()).toEqual(['a', 'c'])

    db.close()
  })

  it('lazy mode keeps memory bounded — query() throws, scan() works', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'with-indexing-passphrase-2026',
      indexStrategy: withIndexing(),
    })
    const vault = await db.openVault('demo')

    // lazy mode: cache at most 10 records; declare the indexes the
    // app will query. query() throws (it can't see the full set);
    // scan() works (it iterates without buffering).
    const invoices = vault.collection<Invoice>('invoices', {
      prefetch: false,
      cache: { maxRecords: 10 },
      indexes: ['status'],
    })
    for (let i = 0; i < 25; i++) {
      await invoices.put(`r${i}`, {
        id: `r${i}`,
        clientId: `C${i % 3}`,
        status: i % 2 === 0 ? 'paid' : 'draft',
        amount: i * 10,
      })
    }

    expect(() => invoices.query()).toThrow(/lazy/)

    // scan() in lazy mode iterates persisted keys — including the
    // index sidecars maintained by withIndexing(). Filter to records
    // that have an `id` field (real Invoice rows), which excludes
    // the `_idx/...` namespace.
    let userRecords = 0
    for await (const r of invoices.scan()) {
      if (typeof r.id === 'string' && !r.id.startsWith('_idx/')) userRecords++
    }
    expect(userRecords).toBe(25)

    db.close()
  })
})
