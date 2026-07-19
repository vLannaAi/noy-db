import { describe, it, expect } from 'vitest'
import {
  createNoydb,
  withMaterializedView,
  MaterializedViewCycleError,
  MaterializedViewTooLargeError,
  withGuard,
  RecordLockedError,
  GroupedAggregation,
} from '../../src/index.js'
import { withAggregate } from '../../src/with-lookup/aggregate/index.js'
import { sum, count } from '../../src/with-lookup/aggregate/reducers.js'
import { withTransactions } from '../../src/with-commit/tx/index.js'
import { withTiers } from '../../src/with-audit/tiers/index.js'
import type { NoydbStore, EncryptedEnvelope } from '../../src/kernel/types.js'

function memory(): NoydbStore {
  const data = new Map<string, EncryptedEnvelope>()
  const k = (v: string, c: string, i: string) => `${v}/${c}/${i}`
  return {
    capabilities: { casAtomic: true, auth: { kind: 'none', required: false, flow: 'static' } },
    async get(v, c, i) { return data.get(k(v, c, i)) ?? null },
    async put(v, c, i, env) { data.set(k(v, c, i), env) },
    async delete(v, c, i) { data.delete(k(v, c, i)) },
    async list(v, c) {
      const prefix = `${v}/${c}/`
      return [...data.keys()].filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length))
    },
    async loadAll(v) {
      const out: Record<string, Record<string, EncryptedEnvelope>> = {}
      for (const [key, env] of data) {
        const [vname, cname, id] = key.split('/')
        if (vname === v) {
          out[cname!] = out[cname!] ?? {}
          out[cname!]![id!] = env
        }
      }
      return out
    },
    async saveAll(v, payload) {
      for (const c of Object.keys(payload)) {
        for (const i of Object.keys(payload[c]!)) {
          data.set(k(v, c, i), payload[c]![i]!)
        }
      }
    },
  }
}

interface Item extends Record<string, unknown> { id: string; tag?: string; n?: number }
interface Disbursement extends Record<string, unknown> {
  id: string
  type: 'vatSales' | 'vatPurchase' | 'vatCredit' | 'pp30'
  period: string
  amount: number
}
interface Compensation extends Record<string, unknown> {
  id: string
  clientId: string
  period: string
  taxAmount: number
}

describe('MV correctness (#152)', () => {
  describe('cost ceiling', () => {
    it('throws MaterializedViewTooLargeError when row count exceeds maxRows', async () => {
      const mv = withMaterializedView<Item>({
        name: 'capped',
        query: (db) => db.collection<Item>('items').query(),
        rowKey: (r) => r.id,
        refresh: 'eager',
        maxRows: 3, // tight ceiling
      })
      const db = await createNoydb({
        store: memory(),
        user: 'alice',
        secret: 'mv-correctness-ceiling-passphrase-2026',
        materializedViewStrategies: [mv],
      })
      const vault = await db.openVault('demo')
      await vault.collection<Item>('items').put('a', { id: 'a' })
      await vault.collection<Item>('items').put('b', { id: 'b' })
      await vault.collection<Item>('items').put('c', { id: 'c' })
      // Up to 3 rows OK.
      expect(await vault.collection<Item>('capped').get('c')).not.toBeNull()
      // 4th row → MV would emit 4 rows on next refresh → throws.
      await expect(vault.collection<Item>('items').put('d', { id: 'd' }))
        .rejects.toBeInstanceOf(MaterializedViewTooLargeError)
    })

    it('default ceiling is 100k (sanity — large default is fine)', async () => {
      // Just registration-time sanity: maxRows undefined → no throw.
      const mv = withMaterializedView<Item>({
        name: 'default-cap',
        query: (db) => db.collection<Item>('items').query(),
        rowKey: (r) => r.id,
        refresh: 'eager',
      })
      const db = await createNoydb({
        store: memory(),
        user: 'alice',
        secret: 'mv-correctness-default-cap-passphrase-2026',
        materializedViewStrategies: [mv],
      })
      const vault = await db.openVault('demo')
      await vault.collection<Item>('items').put('a', { id: 'a' })
      expect(await vault.collection<Item>('default-cap').get('a')).not.toBeNull()
    })
  })

  describe('onEmpty tombstoning', () => {
    it('default onEmpty: "delete" — disappeared rows are tombstoned via _internalDelete', async () => {
      const mv = withMaterializedView<Item>({
        name: 'red-items',
        query: (db) => db.collection<Item>('items').query().where('tag', '==', 'red'),
        rowKey: (r) => r.id,
        refresh: 'eager',
      })
      const db = await createNoydb({
        store: memory(),
        user: 'alice',
        secret: 'mv-correctness-tombstone-passphrase-2026',
        materializedViewStrategies: [mv],
      })
      const vault = await db.openVault('demo')
      await vault.collection<Item>('items').put('a', { id: 'a', tag: 'red' })
      await vault.collection<Item>('items').put('b', { id: 'b', tag: 'red' })
      expect(await vault.collection<Item>('red-items').get('a')).not.toBeNull()
      expect(await vault.collection<Item>('red-items').get('b')).not.toBeNull()

      // Flip 'a' to blue. Refresh re-runs the query (only 'b' is red);
      // 'a' is tombstoned.
      await vault.collection<Item>('items').put('a', { id: 'a', tag: 'blue' })
      expect(await vault.collection<Item>('red-items').get('a')).toBeNull()
      expect(await vault.collection<Item>('red-items').get('b')).not.toBeNull()
    })

    it('tombstone bypasses user onDelete on the output collection', async () => {
      // The composition fix from PR #148 (#144 + #145 interaction)
      // ensures refresh-driven tombstones use Collection._internalDelete,
      // which skips user onDelete guards.
      let onDeleteFired = 0
      const guard = withGuard<Item>({
        collection: 'red-items',
        onDelete: () => {
          onDeleteFired++
          throw new RecordLockedError('red-items', '', 'no deletes!')
        },
      })
      const mv = withMaterializedView<Item>({
        name: 'red-items',
        query: (db) => db.collection<Item>('items').query().where('tag', '==', 'red'),
        rowKey: (r) => r.id,
        refresh: 'eager',
      })
      const db = await createNoydb({
        store: memory(),
        user: 'alice',
        secret: 'mv-correctness-bypass-passphrase-2026',
        guardStrategies: [guard],
        materializedViewStrategies: [mv],
      })
      const vault = await db.openVault('demo')
      await vault.collection<Item>('items').put('a', { id: 'a', tag: 'red' })
      expect(await vault.collection<Item>('red-items').get('a')).not.toBeNull()

      // Flip 'a' to blue → tombstone fires → onDelete should NOT fire
      // (system-internal delete bypass).
      await expect(vault.collection<Item>('items').put('a', { id: 'a', tag: 'blue' }))
        .resolves.not.toThrow()
      expect(onDeleteFired).toBe(0)
      expect(await vault.collection<Item>('red-items').get('a')).toBeNull()

      // User-initiated delete on the same collection DOES still fire
      // onDelete — bypass is scoped to housekeeping.
      await vault.collection<Item>('items').put('b', { id: 'b', tag: 'red' })
      await expect(vault.collection<Item>('red-items').delete('b'))
        .rejects.toBeInstanceOf(RecordLockedError)
      expect(onDeleteFired).toBe(1)
    })

    it('onEmpty: "keep" — disappeared rows linger', async () => {
      const mv = withMaterializedView<Item>({
        name: 'red-items',
        query: (db) => db.collection<Item>('items').query().where('tag', '==', 'red'),
        rowKey: (r) => r.id,
        refresh: 'eager',
        onEmpty: 'keep',
      })
      const db = await createNoydb({
        store: memory(),
        user: 'alice',
        secret: 'mv-correctness-keep-passphrase-2026',
        materializedViewStrategies: [mv],
      })
      const vault = await db.openVault('demo')
      await vault.collection<Item>('items').put('a', { id: 'a', tag: 'red' })
      expect(await vault.collection<Item>('red-items').get('a')).not.toBeNull()
      await vault.collection<Item>('items').put('a', { id: 'a', tag: 'blue' })
      // With onEmpty: 'keep', 'a' lingers despite no longer matching the query.
      expect(await vault.collection<Item>('red-items').get('a')).not.toBeNull()
    })

    it('refreshView returns the real deleted count (niwat-review of #157, verified in #158)', async () => {
      // PR #157 added the deleted field to RefreshResult shape. This
      // PR (#158) makes it carry the real tombstone count from the
      // executor's diff-against-prior pass.
      const mv = withMaterializedView<Item>({
        name: 'red-items',
        query: (db) => db.collection<Item>('items').query().where('tag', '==', 'red'),
        rowKey: (r) => r.id,
        refresh: 'manual',
      })
      const db = await createNoydb({
        store: memory(),
        user: 'alice',
        secret: 'mv-correctness-refresh-deleted-passphrase-2026',
        materializedViewStrategies: [mv],
      })
      const vault = await db.openVault('demo')
      await vault.collection<Item>('items').put('a', { id: 'a', tag: 'red' })
      await vault.collection<Item>('items').put('b', { id: 'b', tag: 'red' })
      const first = await vault.refreshView('red-items')
      expect(first.written).toBe(2)
      expect(first.deleted).toBe(0)

      // Flip 'a' to blue → next refresh writes 1 (b) + tombstones 1 (a).
      await vault.collection<Item>('items').put('a', { id: 'a', tag: 'blue' })
      const second = await vault.refreshView('red-items')
      expect(second.written).toBe(1) // 'b' re-emitted
      expect(second.deleted).toBe(1) // 'a' tombstoned
    })

    it('tombstone leg counts honestly: a #718 elevated-skip on the output row is NOT counted as deleted (#776 part b)', async () => {
      // The tombstone loop uses `_internalDelete`, which returns `false` (no
      // erasure) when the target record is elevated above tier 0 on a tiered
      // collection (#718). Before the fix, the loop still incremented
      // `deleted` unconditionally after calling it.
      const mv = withMaterializedView<Item>({
        name: 'red-items',
        query: (db) => db.collection<Item>('items').query().where('tag', '==', 'red'),
        rowKey: (r) => r.id,
        refresh: 'manual',
        output: { collection: 'red-items-out' },
      })
      const db = await createNoydb({
        store: memory(),
        user: 'alice',
        secret: 'mv-correctness-776b-eager-count-passphrase-2026',
        tiersStrategy: withTiers(),
        materializedViewStrategies: [mv],
      })
      const vault = await db.openVault('demo')
      // Declare tiers on the OUTPUT collection BEFORE the first refresh
      // constructs it untiered (first-construction-wins, same discipline as
      // tiers-derived.test.ts / mv-tier-staleness.test.ts).
      const out = vault.collection<Item>('red-items-out', { tiers: [0, 1], perRecordKeys: true })
      await vault.collection<Item>('items').put('a', { id: 'a', tag: 'red' })
      const first = await vault.refreshView('red-items')
      expect(first.written).toBe(1)

      // Elevate the OUTPUT row directly — same session, so the executor's
      // ownership decode below still succeeds (the CEK cache is warm from the
      // elevate call itself), but `_internalDelete` is #718-gated.
      await out.elevate('a', 1)

      // Flip the source's tag so it no longer matches the MV's filter — the
      // next refresh must attempt to tombstone the (now-elevated) output row.
      await vault.collection<Item>('items').put('a', { id: 'a', tag: 'blue' })
      const second = await vault.refreshView('red-items')

      expect(second.deleted).toBe(0) // #776 part b — the over-count RED this test pins
    })
  })

  describe('same-collection partition (DERIV-PP30-001 shape)', () => {
    it('accepts MV with output.partition + provably disjoint where-clause', async () => {
      const mv = withMaterializedView<Disbursement>({
        name: 'pp30-aggregate',
        query: (db) => db.collection<Disbursement>('disbursements')
          .query()
          .where('type', 'in', ['vatSales', 'vatPurchase', 'vatCredit']),
        rowKey: (r) => `pp30|${r.period}|${r.id}`,
        refresh: 'eager',
        output: { collection: 'disbursements', partition: { field: 'type', value: 'pp30' } },
      })
      // Registration succeeds — the input filter excludes the partition value.
      const db = await createNoydb({
        store: memory(),
        user: 'alice',
        secret: 'mv-correctness-partition-ok-passphrase-2026',
        materializedViewStrategies: [mv],
      })
      const vault = await db.openVault('demo')
      await vault.collection<Disbursement>('disbursements').put('d1', {
        id: 'd1', type: 'vatSales', period: '2026-05', amount: 1000,
      })
      // MV materializes — id format is the explicit rowKey output.
      expect(await vault.collection<Disbursement>('disbursements').get('pp30|2026-05|d1')).not.toBeNull()
    })

    it('rejects same-collection MV WITHOUT a disjoint partition filter', async () => {
      // Self-feedback without partition → cycle (covered by foundation),
      // and WITH partition but no disjoint clause → also cycle.
      const mv = withMaterializedView<Disbursement>({
        name: 'pp30-bad',
        query: (db) => db.collection<Disbursement>('disbursements').query(), // no where!
        rowKey: (r) => r.id,
        refresh: 'eager',
        output: { collection: 'disbursements', partition: { field: 'type', value: 'pp30' } },
      })
      await expect(
        (async () => {
          const db = await createNoydb({
            store: memory(),
            user: 'alice',
            secret: 'mv-correctness-partition-bad-passphrase-2026',
            materializedViewStrategies: [mv],
          })
          await db.openVault('demo')
        })(),
      ).rejects.toBeInstanceOf(MaterializedViewCycleError)
    })

    it('accepts .where(field, "==", X) where X !== partition.value', async () => {
      const mv = withMaterializedView<Disbursement>({
        name: 'vatSales-mv',
        query: (db) => db.collection<Disbursement>('disbursements').query().where('type', '==', 'vatSales'),
        rowKey: (r) => `agg|${r.id}`,
        refresh: 'eager',
        output: { collection: 'disbursements', partition: { field: 'type', value: 'pp30' } },
      })
      const db = await createNoydb({
        store: memory(),
        user: 'alice',
        secret: 'mv-correctness-eq-partition-passphrase-2026',
        materializedViewStrategies: [mv],
      })
      // Registration should not throw.
      await db.openVault('demo')
    })

    it('accepts .where(field, "!=", partition.value)', async () => {
      const mv = withMaterializedView<Disbursement>({
        name: 'not-pp30',
        query: (db) => db.collection<Disbursement>('disbursements').query().where('type', '!=', 'pp30'),
        rowKey: (r) => `agg|${r.id}`,
        refresh: 'eager',
        output: { collection: 'disbursements', partition: { field: 'type', value: 'pp30' } },
      })
      const db = await createNoydb({
        store: memory(),
        user: 'alice',
        secret: 'mv-correctness-ne-partition-passphrase-2026',
        materializedViewStrategies: [mv],
      })
      await db.openVault('demo')
    })

    it('ordinary delete() of one source row does not wipe OTHER source rows at rest (#762)', async () => {
      const mv = withMaterializedView<Disbursement>({
        name: 'pp30-aggregate',
        query: (db) => db.collection<Disbursement>('disbursements')
          .query()
          .where('type', 'in', ['vatSales', 'vatPurchase', 'vatCredit']),
        rowKey: (r) => `pp30|${r.period}|${r.id}`,
        refresh: 'eager',
        output: { collection: 'disbursements', partition: { field: 'type', value: 'pp30' } },
      })
      const db = await createNoydb({
        store: memory(),
        user: 'alice',
        secret: 'mv-correctness-762-tombstone-passphrase-2026',
        materializedViewStrategies: [mv],
      })
      const vault = await db.openVault('demo')
      const coll = vault.collection<Disbursement>('disbursements')
      await coll.put('d1', { id: 'd1', type: 'vatSales', period: '2026-05', amount: 1000 })
      await coll.put('d2', { id: 'd2', type: 'vatPurchase', period: '2026-05', amount: 500 })
      expect(await coll.get('pp30|2026-05|d1')).not.toBeNull()
      expect(await coll.get('pp30|2026-05|d2')).not.toBeNull()

      // Ordinary delete() of d1 fires the eager MV refresh (onEmpty: 'delete', the default).
      // Before the fix, the tombstone diff (`listOutputIds` with no ownership filter) wipes
      // EVERY id in the output collection absent from the new result set — including d2, an
      // untouched USER source row that still matches the MV's own query.
      await coll.delete('d1')

      expect(await coll.get('d2')).not.toBeNull() // #762 — the data-loss RED this test pins
      expect((await coll.get('d2'))?.amount).toBe(500)
    })

    it('does not self-perpetuate: a stale stamped output row is excluded from the MV\'s own input scan (#777)', async () => {
      // Same-collection Query-form MV whose input filter is on a field DISJOINT
      // from the partition field ('type'). The output row is a VERBATIM copy of
      // the source row, so it still carries `type: 'vatSales'` — meaning it
      // itself satisfies the MV's own input filter. A fixed rowKey means the
      // recomputed id always lands on the SAME output row. Before the fix, once
      // the true source (d1) is deleted, the next eager refresh's input scan
      // still picks up the stale stamped output row (it matches the filter),
      // re-derives it under the same id, and it lands back in `newIds` — the
      // row survives the tombstone diff and self-perpetuates forever.
      const mv = withMaterializedView<Disbursement>({
        name: 'vatSales-summary',
        query: (db) => db.collection<Disbursement>('disbursements').query().where('type', '==', 'vatSales'),
        rowKey: () => 'summary',
        refresh: 'eager',
        output: { collection: 'disbursements', partition: { field: 'type', value: 'pp30' } },
      })
      const db = await createNoydb({
        store: memory(),
        user: 'alice',
        secret: 'mv-correctness-777-self-perpetuation-passphrase-2026',
        materializedViewStrategies: [mv],
      })
      const vault = await db.openVault('demo')
      const coll = vault.collection<Disbursement>('disbursements')
      await coll.put('d1', { id: 'd1', type: 'vatSales', period: '2026-05', amount: 1000 })
      expect(await coll.get('summary')).not.toBeNull()

      // Delete the true source. The next eager refresh must NOT re-select the
      // stale stamped 'summary' output row as if it were live source input.
      await coll.delete('d1')

      expect(await coll.get('summary')).toBeNull() // #777 — the self-perpetuation RED this test pins
    })

    it('manual MV sharing an output collection with an invalidated sibling keeps its rows (#761 item 2)', async () => {
      interface Order extends Record<string, unknown> { id: string; amount: number }
      interface Invoice extends Record<string, unknown> { id: string; amount: number }
      const mvA = withMaterializedView<Order>({
        name: 'orders-report',
        query: (db) => db.collection<Order>('orders').query(),
        rowKey: (r) => `orders|${r.id}`,
        refresh: 'lazy',
        output: { collection: 'reports' },
      })
      const mvB = withMaterializedView<Invoice>({
        name: 'invoices-report',
        query: (db) => db.collection<Invoice>('invoices').query(),
        rowKey: (r) => `invoices|${r.id}`,
        refresh: 'manual',
        output: { collection: 'reports' },
      })
      const db = await createNoydb({
        store: memory(),
        user: 'alice',
        secret: 'mv-correctness-sibling-passphrase-2026',
        materializedViewStrategies: [mvA, mvB],
      })
      const vault = await db.openVault('demo')
      await vault.collection<Order>('orders').put('o1', { id: 'o1', amount: 10 })
      await vault.collection<Invoice>('invoices').put('i1', { id: 'i1', amount: 20 })

      // Materialize mvA lazily (a read triggers resolve-on-read) and mvB explicitly (manual).
      expect(await vault.collection('reports').get('orders|o1')).not.toBeNull()
      await vault.refreshView('invoices-report')
      expect(await vault.collection('reports').get('invoices|i1')).not.toBeNull()

      // Deleting mvA's source row invalidates mvA's OWN stamped output row at rest
      // (`invalidateMVAtRest`). mvB's row — a manual sibling sharing the SAME output
      // collection — must survive: the stamp-scoped discipline in `invalidateMVAtRest`
      // must never collaterally wipe a sibling MV's rows (#761 item 2).
      await vault.collection<Order>('orders').delete('o1')
      expect(await vault.collection('reports').get('orders|o1')).toBeNull()
      expect(await vault.collection('reports').get('invoices|i1')).not.toBeNull()
    })
  })

  describe('strict-mode rollback', () => {
    it('strict: true rolls back the source-write when an MV refresh fails', async () => {
      // We trigger failure via the cost ceiling — a small maxRows fires
      // MaterializedViewTooLargeError mid-refresh; with strict + tx,
      // the source-write rolls back too.
      const mv = withMaterializedView<Item>({
        name: 'tiny',
        query: (db) => db.collection<Item>('items').query(),
        rowKey: (r) => r.id,
        refresh: 'eager',
        maxRows: 2,
        strict: true,
      })
      const db = await createNoydb({
        store: memory(),
        user: 'alice',
        secret: 'mv-correctness-strict-passphrase-2026',
        materializedViewStrategies: [mv],
        txStrategy: withTransactions(),
      })
      const vault = await db.openVault('demo')
      await vault.collection<Item>('items').put('a', { id: 'a' })
      await vault.collection<Item>('items').put('b', { id: 'b' })

      // The third put fires the MV refresh, which exceeds maxRows.
      // The error propagates and the source-write rolls back via the
      // TxContext registration the executor performs.
      await expect(
        db.transaction(async (tx) => {
          await tx.vault('demo').collection<Item>('items').put('c', { id: 'c' })
        }),
      ).rejects.toBeInstanceOf(MaterializedViewTooLargeError)

      // Source 'c' should NOT be present — rolled back.
      expect(await vault.collection<Item>('items').get('c')).toBeNull()
    })
  })

  describe('aggregate query shape', () => {
    it('materializes a groupBy + aggregate query into rows', async () => {
      interface ClientTotalRow extends Record<string, unknown> {
        clientId: string
        taxTotal: number
      }
      const mv = withMaterializedView<ClientTotalRow>({
        name: 'client-totals',
        sources: ['compensations'],
        query: (db) => db.collection<Compensation>('compensations')
          .query()
          .groupBy('clientId')
          .aggregate({ taxTotal: sum('taxAmount') }) as GroupedAggregation<ClientTotalRow>,
        rowKey: (r) => r.clientId,
        refresh: 'eager',
      })
      const db = await createNoydb({
        store: memory(),
        user: 'alice',
        secret: 'mv-correctness-aggregate-passphrase-2026',
        aggregateStrategy: withAggregate(),
        materializedViewStrategies: [mv],
      })
      const vault = await db.openVault('demo')
      await vault.collection<Compensation>('compensations').put('c1', {
        id: 'c1', clientId: 'acme', period: '2026-05', taxAmount: 100,
      })
      await vault.collection<Compensation>('compensations').put('c2', {
        id: 'c2', clientId: 'acme', period: '2026-05', taxAmount: 50,
      })
      await vault.collection<Compensation>('compensations').put('c3', {
        id: 'c3', clientId: 'beta', period: '2026-05', taxAmount: 75,
      })
      expect((await vault.collection<ClientTotalRow>('client-totals').get('acme'))?.taxTotal).toBe(150)
      expect((await vault.collection<ClientTotalRow>('client-totals').get('beta'))?.taxTotal).toBe(75)
    })

    it('non-grouped aggregate emits one row', async () => {
      interface TotalRow extends Record<string, unknown> { totalAmount: number; n: number }
      const mv = withMaterializedView<TotalRow>({
        name: 'totals',
        sources: ['items'],
        query: (db) => db.collection<Item>('items')
          .query()
          .aggregate({ totalAmount: sum('n'), n: count() }),
        rowKey: () => 'grand-total',
        refresh: 'eager',
      })
      const db = await createNoydb({
        store: memory(),
        user: 'alice',
        secret: 'mv-correctness-single-agg-passphrase-2026',
        aggregateStrategy: withAggregate(),
        materializedViewStrategies: [mv],
      })
      const vault = await db.openVault('demo')
      await vault.collection<Item>('items').put('a', { id: 'a', n: 10 })
      await vault.collection<Item>('items').put('b', { id: 'b', n: 25 })
      const row = await vault.collection<TotalRow>('totals').get('grand-total')
      expect(row?.totalAmount).toBe(35)
      expect(row?.n).toBe(2)
    })
  })
})
