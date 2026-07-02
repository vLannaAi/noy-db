/**
 * Showcase 81 — withMaterializedView, eager refresh (Dim 14 v2)
 *
 * What you'll learn
 * ─────────────────
 * `withMaterializedView` declares a query whose result is persisted as
 * a queryable output collection and kept fresh on source-collection
 * writes. Where `withDerivation` is record-level (one source row → N
 * outputs), `withMaterializedView` is query-level: the source can be an
 * aggregate, a join, a groupBy — anything the chainable `Query<T>`
 * builder can express.
 *
 * This showcase covers the eager lifecycle: source-writes synchronously
 * re-materialize the view inside the same transaction. Lazy lifecycle
 * is showcase 82; the predicates + ctx primitive is showcase 84.
 *
 * Walked-through mechanics:
 *
 *   1. **GroupBy + aggregate** — `compensations.query().groupBy('clientId').aggregate({ tax: sum('taxAmount') })`
 *      materializes one row per client with the rolling tax total.
 *   2. **Eager refresh** — every source write re-runs the query and
 *      diffs the result against the prior output set.
 *   3. **Tombstoning** — when a key that previously had rows yields zero
 *      rows, the prior row is tombstoned via the system-internal delete
 *      bypass (user `onDelete` guards on the output collection do not
 *      fire on housekeeping).
 *   4. **`_materializedFrom` stamp** — every emitted row carries
 *      `{ mvName, queryHash, sourceVersions, materializedAt }` inside
 *      the encrypted payload (zero-knowledge: the storage backend
 *      cannot infer the MV graph from listing).
 *
 * Why it matters
 * ──────────────
 * Tax-period roll-ups (e.g. PND.1: per-client, per-month sum of
 * withholding tax) are the canonical example. The consumer wants
 * `vault.collection('pnd1').get(clientId)` to be O(1) at read time,
 * recomputed atomically whenever a contributing source row lands.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 00 (basics) + 80 (record-level derivations).
 *
 * What to read next
 * ─────────────────
 *   - docs/superpowers/specs/2026-05-20-dim14-mv-v2-design.md
 *   - docs/services/derivations.md § Materialized Views
 *   - showcases/src/82-with-mv-lazy.showcase.test.ts (lazy lifecycle)
 *   - showcases/src/83-with-overlay.showcase.test.ts (operator-editable overlays)
 *   - showcases/src/84-with-mv-predicates.showcase.test.ts (declared predicates)
 *
 * Spec mapping
 * ────────────
 * features.yaml → features → materialized-views
 */

import { describe, it, expect } from 'vitest'
import { createNoydb, withMaterializedView, sum, count } from '@noy-db/hub'
import type { Query } from '@noy-db/hub'
import { withAggregate } from '@noy-db/hub/aggregate'
import { memory } from '@noy-db/to-memory'

interface Compensation extends Record<string, unknown> {
  id: string
  clientId: string
  amount: number
  taxAmount: number
  period: string
}

interface Pnd1Row extends Record<string, unknown> {
  clientId: string
  tax: number
  count: number
  _materializedFrom?: { mvName: string; queryHash: string; materializedAt: string }
}

const pnd1 = withMaterializedView<Pnd1Row>({
  name: 'pnd1',
  // Per-client tax roll-up. The MV's output collection is also named 'pnd1'
  // (the default — `output.collection` overrides if you need a different name).
  //
  // The cast widens `GroupedAggregation` to `Query<Pnd1Row>` to satisfy
  // the strategy interface — the runtime accepts both shapes (the
  // executor branches on terminal), but the type declares only the
  // `Query<TRow>` arm. Aggregate-shaped MVs require `sources` for the
  // same reason: the dependency analyzer can't introspect through the
  // closed-over GroupedQuery.
  query: (db) =>
    db
      .collection<Compensation>('compensations')
      .query()
      .groupBy('clientId')
      .aggregate({ tax: sum('taxAmount'), count: count() }) as unknown as Query<Pnd1Row>,
  rowKey: (row) => row.clientId,
  sources: ['compensations'],
  refresh: 'eager',
})

async function open(passphrase: string) {
  const db = await createNoydb({
    store: memory(),
    user: 'alice',
    secret: passphrase,
    aggregateStrategy: withAggregate(),
    materializedViewStrategies: [pnd1],
  })
  const vault = await db.openVault('books')
  return { db, vault }
}

describe('Showcase 81 — withMaterializedView (eager)', () => {
  it('materializes a per-client aggregate after the first source write', async () => {
    const { vault } = await open('showcase-81-first-write-passphrase-2026')
    await vault.collection<Compensation>('compensations').put('w1', {
      id: 'w1',
      clientId: 'acme',
      amount: 1000,
      taxAmount: 30,
      period: '2026-05',
    })
    const row = await vault.collection<Pnd1Row>('pnd1').get('acme')
    expect(row?.tax).toBe(30)
    expect(row?.count).toBe(1)
  })

  it('re-materializes when a contributing source row lands', async () => {
    const { vault } = await open('showcase-81-update-passphrase-2026')
    await vault.collection<Compensation>('compensations').put('w1', {
      id: 'w1',
      clientId: 'acme',
      amount: 1000,
      taxAmount: 30,
      period: '2026-05',
    })
    await vault.collection<Compensation>('compensations').put('w2', {
      id: 'w2',
      clientId: 'acme',
      amount: 500,
      taxAmount: 15,
      period: '2026-05',
    })
    const row = await vault.collection<Pnd1Row>('pnd1').get('acme')
    expect(row?.tax).toBe(45)
    expect(row?.count).toBe(2)
  })

  it('keeps separate rows for separate group keys', async () => {
    const { vault } = await open('showcase-81-multi-passphrase-2026')
    await vault.collection<Compensation>('compensations').put('w1', {
      id: 'w1', clientId: 'acme', amount: 1000, taxAmount: 30, period: '2026-05',
    })
    await vault.collection<Compensation>('compensations').put('w2', {
      id: 'w2', clientId: 'globex', amount: 800, taxAmount: 24, period: '2026-05',
    })
    expect((await vault.collection<Pnd1Row>('pnd1').get('acme'))?.tax).toBe(30)
    expect((await vault.collection<Pnd1Row>('pnd1').get('globex'))?.tax).toBe(24)
  })

  it('tombstones a prior MV row when no source row matches the group key anymore', async () => {
    // Filtering MV: only un-paid compensations count. When the only
    // contributing row flips to `status: 'paid'`, the next refresh
    // produces zero rows for the 'acme' group key → default
    // `onEmpty: 'delete'` tombstones via the system-internal bypass
    // (user `onDelete` guards on the output collection are not consulted).
    type CompWithStatus = Compensation & { status: string }
    const pendingPnd1 = withMaterializedView<Pnd1Row>({
      name: 'pnd1-pending',
      query: (db) =>
        db.collection<CompWithStatus>('compensations')
          .query()
          .where('status', '==', 'pending')
          .groupBy('clientId')
          .aggregate({ tax: sum('taxAmount'), count: count() }) as unknown as Query<Pnd1Row>,
      rowKey: (row) => row.clientId,
      sources: ['compensations'],
      refresh: 'eager',
    })
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'showcase-81-tombstone-passphrase-2026',
      aggregateStrategy: withAggregate(),
      materializedViewStrategies: [pendingPnd1],
    })
    const vault = await db.openVault('books')
    await vault.collection<Compensation & { status: string }>('compensations').put('w1', {
      id: 'w1', clientId: 'acme', amount: 1000, taxAmount: 30, period: '2026-05', status: 'pending',
    })
    expect(await vault.collection<Pnd1Row>('pnd1-pending').get('acme')).not.toBeNull()
    await vault.collection<Compensation & { status: string }>('compensations').put('w1', {
      id: 'w1', clientId: 'acme', amount: 1000, taxAmount: 30, period: '2026-05', status: 'paid',
    })
    expect(await vault.collection<Pnd1Row>('pnd1-pending').get('acme')).toBeNull()
  })

  it('stamps _materializedFrom onto every emitted row', async () => {
    const { vault } = await open('showcase-81-stamp-passphrase-2026')
    await vault.collection<Compensation>('compensations').put('w1', {
      id: 'w1', clientId: 'acme', amount: 1000, taxAmount: 30, period: '2026-05',
    })
    const row = await vault.collection<Pnd1Row>('pnd1').get('acme')
    expect(row?._materializedFrom?.mvName).toBe('pnd1')
    expect(row?._materializedFrom?.queryHash).toMatch(/^[0-9a-f]{8,}$/)
    expect(row?._materializedFrom?.materializedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})
