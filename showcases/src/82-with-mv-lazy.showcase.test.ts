/**
 * Showcase 82 — withMaterializedView, lazy lifecycle (Dim 14 v2)
 *
 * What you'll learn
 * ─────────────────
 * Lazy refresh defers re-materialization to the first read after a
 * source change. Useful when the MV is expensive (large aggregate, big
 * join) and most source writes happen without an intervening read.
 *
 *   1. **First read after open** — bootstraps the MV (no prior state
 *      exists → executor runs the query and writes the output rows).
 *   2. **Source-write marks stale** — does NOT re-run the query
 *      inline. The stale flag is in-memory on the registry.
 *   3. **Next read resolves** — `vault.collection(mvName).get(id)` (or
 *      `.list()`) re-runs the query before returning, then clears the
 *      stale flag.
 *   4. **`vault.refreshView(name)`** — manual entry-point that
 *      re-materializes on demand, regardless of the stale flag.
 *      Returns `{ written, deleted, failed }`.
 *
 * Why it matters
 * ──────────────
 * For a regulated-domain consumer: end-of-period roll-ups can be heavy
 * (group across the entire compensations collection). Eager refresh
 * would mean every single source write pays the recompute cost; lazy
 * defers the work to "when the dashboard actually opens." Same eventual
 * consistency story; very different write-path latency.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 81 (eager MV mechanics).
 *
 * What to read next
 * ─────────────────
 *   - docs/services/derivations.md § Materialized Views
 *   - showcases/src/83-with-overlay.showcase.test.ts (operator-editable overlays)
 *   - showcases/src/84-with-mv-predicates.showcase.test.ts (declared predicates)
 *
 * Spec mapping
 * ────────────
 * features.yaml → features → materialized-views
 */

import { describe, it, expect } from 'vitest'
import { createNoydb, withMaterializedView } from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'

interface Compensation extends Record<string, unknown> {
  id: string
  clientId: string
  taxAmount: number
  status: 'pending' | 'paid'
}

function buildLazyMV() {
  return withMaterializedView<Compensation>({
    name: 'pending-compensations',
    // Project a filter MV — keeps the lazy lifecycle the focus here.
    // Aggregate-shaped MVs work the same way; see showcase 81 for the
    // groupBy + sum pattern.
    query: (db) =>
      db.collection<Compensation>('compensations').query().where('status', '==', 'pending'),
    rowKey: (row) => row.id,
    refresh: 'lazy',
  })
}

async function open(passphrase: string) {
  const db = await createNoydb({
    store: memory(),
    user: 'alice',
    secret: passphrase,
    materializedViewStrategies: [buildLazyMV()],
  })
  const vault = await db.openVault('books')
  return { db, vault }
}

describe('Showcase 82 — withMaterializedView (lazy)', () => {
  it('first read after a source write resolves the stale flag', async () => {
    const { vault } = await open('showcase-82-first-read-passphrase-2026')
    await vault.collection<Compensation>('compensations').put('w1', {
      id: 'w1', clientId: 'acme', taxAmount: 30, status: 'pending',
    })
    // Source-write marked the MV stale; the .get() below triggers the
    // resolve-on-read hook before returning.
    const row = await vault.collection<Compensation>('pending-compensations').get('w1')
    expect(row?.taxAmount).toBe(30)
  })

  it('subsequent reads after another source write reflect the change', async () => {
    const { vault } = await open('showcase-82-update-passphrase-2026')
    await vault.collection<Compensation>('compensations').put('w1', {
      id: 'w1', clientId: 'acme', taxAmount: 30, status: 'pending',
    })
    expect(await vault.collection<Compensation>('pending-compensations').get('w1')).not.toBeNull()
    // Second source write — stale marker re-raised; next read picks it up.
    await vault.collection<Compensation>('compensations').put('w2', {
      id: 'w2', clientId: 'acme', taxAmount: 15, status: 'pending',
    })
    expect(await vault.collection<Compensation>('pending-compensations').get('w2')).not.toBeNull()
  })

  it('list() also resolves the stale flag (not just get())', async () => {
    const { vault } = await open('showcase-82-list-passphrase-2026')
    await vault.collection<Compensation>('compensations').put('w1', {
      id: 'w1', clientId: 'acme', taxAmount: 30, status: 'pending',
    })
    await vault.collection<Compensation>('compensations').put('w2', {
      id: 'w2', clientId: 'globex', taxAmount: 24, status: 'pending',
    })
    await vault.collection<Compensation>('compensations').put('w3', {
      id: 'w3', clientId: 'acme', taxAmount: 5, status: 'paid',
    })
    const rows = await vault.collection<Compensation>('pending-compensations').list()
    const ids = rows.map((r) => r.id).sort()
    // w3 was paid, so it's not in the MV result. The list() call had to
    // resolve the stale MV before it could return — without that hook,
    // the array would be empty here.
    expect(ids).toEqual(['w1', 'w2'])
  })

  it('vault.refreshView(name) re-materializes on demand', async () => {
    const { vault } = await open('showcase-82-refresh-passphrase-2026')
    await vault.collection<Compensation>('compensations').put('w1', {
      id: 'w1', clientId: 'acme', taxAmount: 30, status: 'pending',
    })
    const result = await vault.refreshView('pending-compensations')
    expect(result.written).toBe(1)
    expect(result.failed).toBe(0)
    expect(await vault.collection<Compensation>('pending-compensations').get('w1')).not.toBeNull()
  })

  it('two consecutive source writes only do one refresh on next read', async () => {
    const { vault } = await open('showcase-82-coalesce-passphrase-2026')
    // Two source writes without an intervening read.
    await vault.collection<Compensation>('compensations').put('w1', {
      id: 'w1', clientId: 'acme', taxAmount: 30, status: 'pending',
    })
    await vault.collection<Compensation>('compensations').put('w2', {
      id: 'w2', clientId: 'acme', taxAmount: 70, status: 'pending',
    })
    // The single read pays the recompute cost once; the executor
    // sees the post-both-writes state.
    const rows = await vault.collection<Compensation>('pending-compensations').list()
    expect(rows).toHaveLength(2)
  })
})
