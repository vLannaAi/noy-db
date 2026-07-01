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
