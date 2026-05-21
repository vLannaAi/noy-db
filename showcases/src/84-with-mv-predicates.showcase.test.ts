/**
 * Showcase 84 — declaredDeterministicPredicates (Dim 14 v2)
 *
 * What you'll learn
 * ─────────────────
 * `MaterializedViewStrategy.predicates` lets you register named,
 * consumer-stable, deterministic functions that the MV's query can
 * call via `.wherePredicate(name, ctx?)`. Two reasons this exists:
 *
 *   1. **Expressiveness** — query filters that can't be expressed as
 *      `.where(field, op, value)` (date arithmetic, multi-field
 *      conditions) need a function call site.
 *   2. **Refresh semantics** — the predicate's stable `hash` field
 *      and the canonical-JSON hash of `ctx` both fold into the MV's
 *      `queryHash`. Bumping `hash` (because the function changed
 *      meaning) or supplying different `ctx` (e.g. a moved `asOf`
 *      date) force a refresh on next visit. No silent staleness.
 *
 * Mechanics walked through:
 *
 *   1. **Basic usage** — declare a predicate; call it from inside the
 *      MV's `query()` callback.
 *   2. **`queryHash` reflects predicate identity** — same `name` and
 *      `ctx` but different `hash` → different `queryHash`.
 *   3. **`queryHash` reflects `ctx`** — same `name` and `hash` but
 *      different `ctx` → different `queryHash`.
 *
 * Why it matters
 * ──────────────
 * The "overdue invoices" view is the canonical example: the predicate
 * depends on an external `asOf` date (today's date, the period
 * boundary, an audit cutoff). The MV must refresh when `asOf` moves,
 * but the underlying function definition hasn't changed. Folding
 * `ctx` into `queryHash` is what makes that work without ad-hoc
 * invalidation logic.
 *
 * Prerequisites
 * ─────────────
 * - Showcase 81 (eager MV mechanics).
 *
 * What to read next
 * ─────────────────
 *   - docs/superpowers/specs/2026-05-20-dim14-mv-v2-design.md § declaredDeterministicPredicates
 *   - docs/subsystems/derivations.md § Materialized Views — declared predicates
 *
 * Spec mapping
 * ────────────
 * features.yaml → features → materialized-views
 */

import { describe, it, expect } from 'vitest'
import { createNoydb, withMaterializedView } from '@noy-db/hub'
import { memory } from '@noy-db/to-memory'

interface Invoice extends Record<string, unknown> {
  id: string
  status: 'open' | 'paid'
  amount: number
  dueDate: string
}

interface MaterializedInvoice extends Invoice {
  _materializedFrom?: { queryHash: string }
}

describe('Showcase 84 — declaredDeterministicPredicates', () => {
  it('a registered predicate filters rows from inside the MV query', async () => {
    const overdueMV = withMaterializedView<Invoice>({
      name: 'overdue',
      predicates: {
        isOverdue: {
          hash: 'is-overdue-v1',
          fn: (inv: Invoice, ctx?: unknown) => {
            const { asOf } = ctx as { asOf: string }
            return inv.status === 'open' && inv.dueDate < asOf
          },
        },
      },
      query: (db) =>
        db.collection<Invoice>('invoices').query().wherePredicate('isOverdue', { asOf: '2026-05-20' }),
      rowKey: (r) => r.id,
      refresh: 'eager',
    })
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'showcase-84-basic-passphrase-2026',
      materializedViewStrategies: [overdueMV],
    })
    const vault = await db.openVault('books')
    await vault.collection<Invoice>('invoices').put('a', { id: 'a', status: 'open', amount: 100, dueDate: '2026-05-01' })
    await vault.collection<Invoice>('invoices').put('b', { id: 'b', status: 'paid', amount: 200, dueDate: '2026-05-01' })
    await vault.collection<Invoice>('invoices').put('c', { id: 'c', status: 'open', amount: 50, dueDate: '2026-06-01' })

    // 'a' is overdue (open + past asOf). 'b' is paid → predicate false.
    // 'c' is open but not yet past asOf → predicate false.
    expect(await vault.collection<Invoice>('overdue').get('a')).not.toBeNull()
    expect(await vault.collection<Invoice>('overdue').get('b')).toBeNull()
    expect(await vault.collection<Invoice>('overdue').get('c')).toBeNull()
  })

  it('queryHash changes when the predicate hash bumps', async () => {
    // Two MVs with the same function but different declared hashes
    // → different queryHash → independent refresh cycles.
    const mvA = withMaterializedView<Invoice>({
      name: 'mvA',
      predicates: { p: { hash: 'h1', fn: () => true } },
      query: (db) => db.collection<Invoice>('inv').query().wherePredicate('p'),
      rowKey: (r) => r.id,
      refresh: 'eager',
    })
    const mvB = withMaterializedView<Invoice>({
      name: 'mvB',
      predicates: { p: { hash: 'h2', fn: () => true } },
      query: (db) => db.collection<Invoice>('inv').query().wherePredicate('p'),
      rowKey: (r) => r.id,
      refresh: 'eager',
    })
    const dbA = await createNoydb({
      store: memory(), user: 'alice', secret: 'showcase-84-hash-A-passphrase-2026',
      materializedViewStrategies: [mvA],
    })
    const dbB = await createNoydb({
      store: memory(), user: 'alice', secret: 'showcase-84-hash-B-passphrase-2026',
      materializedViewStrategies: [mvB],
    })
    const vA = await dbA.openVault('books')
    const vB = await dbB.openVault('books')
    await vA.collection<Invoice>('inv').put('x', { id: 'x', status: 'open', amount: 1, dueDate: '2026-01-01' })
    await vB.collection<Invoice>('inv').put('x', { id: 'x', status: 'open', amount: 1, dueDate: '2026-01-01' })
    const rowA = await vA.collection<MaterializedInvoice>('mvA').get('x')
    const rowB = await vB.collection<MaterializedInvoice>('mvB').get('x')
    expect(rowA?._materializedFrom?.queryHash).not.toBe(rowB?._materializedFrom?.queryHash)
  })

  it('queryHash changes when ctx differs (same name, same hash)', async () => {
    // Same predicate (name + hash), different ctx → different queryHash.
    // This is the mechanism that lets "today's overdue view" pick up
    // asOf changes without bumping the underlying function.
    const mvA = withMaterializedView<Invoice>({
      name: 'overdueA',
      predicates: {
        isOverdue: {
          hash: 'h1',
          fn: (inv, ctx) => inv.status === 'open' && inv.dueDate < (ctx as { asOf: string }).asOf,
        },
      },
      query: (db) => db.collection<Invoice>('inv').query().wherePredicate('isOverdue', { asOf: '2026-05-20' }),
      rowKey: (r) => r.id,
      refresh: 'eager',
    })
    const mvB = withMaterializedView<Invoice>({
      name: 'overdueB',
      predicates: {
        isOverdue: {
          hash: 'h1',
          fn: (inv, ctx) => inv.status === 'open' && inv.dueDate < (ctx as { asOf: string }).asOf,
        },
      },
      query: (db) => db.collection<Invoice>('inv').query().wherePredicate('isOverdue', { asOf: '2026-06-01' }),
      rowKey: (r) => r.id,
      refresh: 'eager',
    })
    const dbA = await createNoydb({
      store: memory(), user: 'alice', secret: 'showcase-84-ctxA-passphrase-2026',
      materializedViewStrategies: [mvA],
    })
    const dbB = await createNoydb({
      store: memory(), user: 'alice', secret: 'showcase-84-ctxB-passphrase-2026',
      materializedViewStrategies: [mvB],
    })
    const vA = await dbA.openVault('books')
    const vB = await dbB.openVault('books')
    // A row that satisfies both asOf values (overdue since 2026-04-01).
    await vA.collection<Invoice>('inv').put('y', { id: 'y', status: 'open', amount: 1, dueDate: '2026-04-01' })
    await vB.collection<Invoice>('inv').put('y', { id: 'y', status: 'open', amount: 1, dueDate: '2026-04-01' })
    const rowA = await vA.collection<MaterializedInvoice>('overdueA').get('y')
    const rowB = await vB.collection<MaterializedInvoice>('overdueB').get('y')
    expect(rowA).not.toBeNull()
    expect(rowB).not.toBeNull()
    expect(rowA?._materializedFrom?.queryHash).not.toBe(rowB?._materializedFrom?.queryHash)
  })

  it('predicates compose with other query operators', async () => {
    // Predicates aren't a separate query mode — they thread through
    // every chain operator. Here: where(amount > 50) +
    // wherePredicate('isOverdue') + orderBy + limit.
    const overdueLargeMV = withMaterializedView<Invoice>({
      name: 'overdue-large',
      predicates: {
        isOverdue: {
          hash: 'h1',
          fn: (inv: Invoice, ctx?: unknown) => {
            const { asOf } = ctx as { asOf: string }
            return inv.status === 'open' && inv.dueDate < asOf
          },
        },
      },
      query: (db) =>
        db
          .collection<Invoice>('inv')
          .query()
          .where('amount', '>', 50)
          .wherePredicate('isOverdue', { asOf: '2026-05-20' })
          .orderBy('amount', 'desc')
          .limit(10),
      rowKey: (r) => r.id,
      refresh: 'eager',
    })
    const db = await createNoydb({
      store: memory(), user: 'alice', secret: 'showcase-84-compose-passphrase-2026',
      materializedViewStrategies: [overdueLargeMV],
    })
    const vault = await db.openVault('books')
    // 'a' matches both filters: amount=100 > 50, open + overdue.
    // 'b' fails amount filter (25). 'c' fails predicate (paid).
    await vault.collection<Invoice>('inv').put('a', { id: 'a', status: 'open', amount: 100, dueDate: '2026-05-01' })
    await vault.collection<Invoice>('inv').put('b', { id: 'b', status: 'open', amount: 25, dueDate: '2026-05-01' })
    await vault.collection<Invoice>('inv').put('c', { id: 'c', status: 'paid', amount: 200, dueDate: '2026-05-01' })
    expect(await vault.collection<Invoice>('overdue-large').get('a')).not.toBeNull()
    expect(await vault.collection<Invoice>('overdue-large').get('b')).toBeNull()
    expect(await vault.collection<Invoice>('overdue-large').get('c')).toBeNull()
  })
})
