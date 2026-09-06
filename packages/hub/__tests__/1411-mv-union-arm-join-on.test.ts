/**
 * #1411 — a UNION MV arm can declare a `joinOn` leg.
 *
 * The declarative MV forms were built on FK refs: an arm's `join` resolved a
 * `ref()`-declared field against the target's `id`, one-to-one. The
 * relational surface #1339 added to the query DSL — composite equality and
 * range joins whose predicate is DATA — never reached the MV declarations, so
 * a vault-side aggregate that needed a two-hop key (disbursement → entity →
 * client) could only be declared by denormalising the client id onto every
 * disbursement first.
 *
 * `{ target, as, on }` on an arm is the same `Query.joinOn()` underneath, and
 * inherits the two properties that make it MV-safe: the predicate folds into
 * `queryHash` (two arms differing only in `on` are two different views), and
 * the target is a literal collection name, so it joins the dependency set
 * without being listed in `sources`.
 *
 * `window` is deliberately NOT part of this: it is doubly opt-in
 * (`withReduce({ window })`) and coupling the MV declaration to a nested
 * strategy is a design question still open on the issue.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, withMaterializedView } from '../src/index.js'
import { memoryStore } from '../src/kernel/memory-store.js'
import { sum, withReduce } from '../src/with-lookup/reduce/index.js'
import type { JoinOnSpec } from '../src/kernel/query/relate/join-on.js'

interface Disbursement extends Record<string, unknown> { id: string; entityId: string; amount: number; date: string }
interface Entity extends Record<string, unknown> { id: string; entityId: string; clientId: string }
interface Rate extends Record<string, unknown> { id: string; from: string; to: string; pct: number }
interface Row extends Record<string, unknown> { clientId: string; amount: number }

async function open(on: JoinOnSpec) {
  const byClient = withMaterializedView<Row>({
    name: 'byClient',
    unionSources: [{
      collection: 'disbursements',
      join: [{ target: 'entities', as: 'entity', on }],
      map: (r) => {
        const e = r.entity as Entity | null
        return e ? { clientId: e.clientId, amount: r.amount as number } : null
      },
    }],
    groupBy: 'clientId',
    aggregate: { amount: sum('amount') },
    rowKey: (row) => row.clientId,
    refresh: 'eager',
  })
  const db = await createNoydb({
    store: memoryStore(), user: 'o', secret: 'issue-1411-union-arm-join-on',
    materializedViewStrategies: [byClient], reduceStrategy: withReduce(),
  })
  const vault = await db.openVault('V')
  const entities = vault.collection<Entity>('entities')
  const disb = vault.collection<Disbursement>('disbursements')
  await entities.put('e1', { id: 'e1', entityId: 'E1', clientId: 'c1' })
  await entities.put('e2', { id: 'e2', entityId: 'E2', clientId: 'c2' })
  await disb.put('d1', { id: 'd1', entityId: 'E1', amount: 100, date: '2026-01-05' })
  await disb.put('d2', { id: 'd2', entityId: 'E1', amount: 50, date: '2026-02-05' })
  await disb.put('d3', { id: 'd3', entityId: 'E2', amount: 7, date: '2026-01-20' })
  return { vault, entities, disb, out: vault.collection<Row & { _materializedFrom?: { queryHash: string } }>('byClient') }
}

describe('#1411 — composite-equality joinOn on a union arm', () => {
  it('aggregates through the two-hop key with no denormalised column', async () => {
    const { out } = await open([['entityId', 'entityId']])
    const rows = await out.list()
    expect(rows.map((r) => [r.clientId, r.amount]).sort()).toEqual([['c1', 150], ['c2', 7]])
  })

  it('the join target is a dependency: rewriting an entity regroups the view', async () => {
    const { entities, out } = await open([['entityId', 'entityId']])
    await entities.put('e2', { id: 'e2', entityId: 'E2', clientId: 'c1' })
    const rows = await out.list()
    expect(rows.map((r) => [r.clientId, r.amount])).toEqual([['c1', 157]])
  })

  it('the predicate is part of the view identity — a different `on` is a different queryHash', async () => {
    const a = (await (await open([['entityId', 'entityId']])).out.list())[0]!._materializedFrom!.queryHash
    // Same target, same alias, same map; only the predicate differs (and it
    // still matches rows, so both views materialise).
    const b = (await (await open({ left: 'entityId', op: '>=', right: 'entityId' })).out.list())[0]!._materializedFrom!.queryHash
    expect(a).toMatch(/\w+/)
    expect(b).not.toBe(a)
  })
})

describe('#1411 — a range joinOn on a union arm', () => {
  it('attaches the rate whose interval contains the row date', async () => {
    interface Out extends Record<string, unknown> { bucket: string; amount: number }
    const taxed = withMaterializedView<Out>({
      name: 'taxed',
      unionSources: [{
        collection: 'disbursements',
        join: [{ target: 'rates', as: 'rate', on: { left: 'date', op: 'between', right: ['from', 'to'] }, mode: 'inner' }],
        map: (r) => ({ bucket: String((r.rate as Rate).pct), amount: r.amount as number }),
      }],
      groupBy: 'bucket',
      aggregate: { amount: sum('amount') },
      rowKey: (row) => row.bucket,
      refresh: 'eager',
    })
    const db = await createNoydb({
      store: memoryStore(), user: 'o', secret: 'issue-1411-union-arm-join-on-range',
      materializedViewStrategies: [taxed], reduceStrategy: withReduce(),
    })
    const vault = await db.openVault('V')
    await vault.collection<Rate>('rates').put('r1', { id: 'r1', from: '2026-01-01', to: '2026-01-31', pct: 3 })
    await vault.collection<Rate>('rates').put('r2', { id: 'r2', from: '2026-02-01', to: '2026-02-28', pct: 5 })
    const disb = vault.collection<Disbursement>('disbursements')
    await disb.put('d1', { id: 'd1', entityId: 'E1', amount: 100, date: '2026-01-05' })
    await disb.put('d2', { id: 'd2', entityId: 'E1', amount: 50, date: '2026-02-05' })
    await disb.put('d3', { id: 'd3', entityId: 'E2', amount: 7, date: '2026-03-20' }) // no rate → inner drops it
    const rows = await vault.collection<Out>('taxed').list()
    expect(rows.map((r) => [r.bucket, r.amount]).sort()).toEqual([['3', 100], ['5', 50]])
  })
})

describe('#1411 — registration refuses a malformed declared leg', () => {
  it('an empty `on` fails at openVault, not at first refresh', async () => {
    const bad = withMaterializedView<Row>({
      name: 'bad',
      unionSources: [{ collection: 'disbursements', join: [{ target: 'entities', as: 'e', on: [] }], map: (r) => ({ clientId: 'x', amount: r.amount as number }) }],
      rowKey: (row) => row.clientId,
      refresh: 'eager',
    })
    const db = await createNoydb({ store: memoryStore(), user: 'o', secret: 'issue-1411-union-arm-join-on-bad', materializedViewStrategies: [bad], reduceStrategy: withReduce() })
    await expect(db.openVault('V')).rejects.toThrow(/at least one/i)
  })
})
