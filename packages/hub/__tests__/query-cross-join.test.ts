import { describe, it, expect } from 'vitest'
import { evaluateClause, type Clause, type CrossJoinClause } from '../src/query/predicate.js'
import { Query, executePlan, type QueryPlan, count } from '../src/query/index.js'
import { CrossJoinTooLargeError, CrossJoinSourceUnknownError } from '../src/kernel/errors.js'
import type { QuerySource, JoinContext, JoinableSource } from '../src/query/index.js'
import { withAggregate } from '../src/with-lookup/aggregate/index.js'
import { analyzeDependencies, summarizeQueryPlan } from '../src/with-formula/materialized-views/index.js'

const AGG = withAggregate()

function staticSource<T>(records: T[]): QuerySource<T> {
  return { snapshot: () => records }
}

function mockJoinContext(
  leftCollection: string,
  sources: Record<string, unknown[]>,
): JoinContext {
  return {
    leftCollection,
    resolveRef: () => null,
    resolveSource: (name: string): JoinableSource | null => {
      const snap = sources[name]
      return snap !== undefined ? { snapshot: () => snap } : null
    },
  }
}

const PERIODS = [
  { id: 'p1', start: '2026-01', end: '2026-03' },
  { id: 'p2', start: '2026-04', end: '2026-06' },
]
const WORKERS = [
  { id: 'w1', name: 'Alice' },
  { id: 'w2', name: 'Bob' },
]

describe('CrossJoinClause > evaluateClause throws on crossJoin type', () => {
  it('throws if a crossJoin clause is passed to evaluateClause', () => {
    const clause: CrossJoinClause = {
      type: 'crossJoin',
      target: 'workers',
      as: 'worker',
    }
    expect(() => evaluateClause({}, clause)).toThrow("'crossJoin' clauses are expansion primitives")
  })
})

describe('CrossJoinClause > toPlan() serialization (serializeClause)', () => {
  const EMPTY_PLAN: QueryPlan = { clauses: [], orderBy: [], limit: undefined, offset: 0, joins: [] }

  it('serializes crossJoin with no on: — on omitted', () => {
    const clause: CrossJoinClause = { type: 'crossJoin', target: 'workers', as: 'worker' }
    const plan: QueryPlan = { ...EMPTY_PLAN, clauses: [clause] }
    const q = new Query({ snapshot: () => [] }, plan)
    const serialized = q.toPlan() as any
    expect(serialized.clauses[0]).toEqual({
      type: 'crossJoin',
      target: 'workers',
      as: 'worker',
      on: undefined,
      onPredicateName: undefined,
      maxRows: undefined,
    })
  })

  it('serializes crossJoin with on: function — strips to [function]', () => {
    const clause: CrossJoinClause = {
      type: 'crossJoin',
      target: 'workers',
      as: 'worker',
      on: () => [],
    }
    const plan: QueryPlan = { ...EMPTY_PLAN, clauses: [clause] }
    const q = new Query({ snapshot: () => [] }, plan)
    const serialized = q.toPlan() as any
    expect(serialized.clauses[0].on).toBe('[function]')
  })

  it('serializes crossJoin with onPredicateName and maxRows preserved', () => {
    const clause: CrossJoinClause = {
      type: 'crossJoin',
      target: 'workers',
      as: 'worker',
      on: () => [],
      onPredicateName: 'isActive',
      maxRows: 100_000,
    }
    const plan: QueryPlan = { ...EMPTY_PLAN, clauses: [clause] }
    const q = new Query({ snapshot: () => [] }, plan)
    const serialized = q.toPlan() as any
    expect(serialized.clauses[0].onPredicateName).toBe('isActive')
    expect(serialized.clauses[0].maxRows).toBe(100_000)
    expect(serialized.clauses[0].on).toBe('[function]')
  })
})

describe('CrossJoinTooLargeError', () => {
  it('is a NoydbError with correct name and fields', () => {
    const e = new CrossJoinTooLargeError({ target: 'workers', expected: 60_000, limit: 50_000 })
    expect(e).toBeInstanceOf(Error)
    expect(e.name).toBe('CrossJoinTooLargeError')
    expect(e.target).toBe('workers')
    expect(e.expected).toBe(60_000)
    expect(e.limit).toBe(50_000)
    expect(e.message).toContain('workers')
    expect(e.message).toContain('50000')
  })
})

describe('CrossJoinSourceUnknownError', () => {
  it('is a NoydbError with correct name and fields', () => {
    const e = new CrossJoinSourceUnknownError('workers', 'periods')
    expect(e.name).toBe('CrossJoinSourceUnknownError')
    expect(e.target).toBe('workers')
    expect(e.leftCollection).toBe('periods')
    expect(e.message).toContain('workers')
    expect(e.message).toContain('periods')
  })
})

describe('Query.crossJoin() > builder', () => {
  it('appends a crossJoin clause to the plan', () => {
    const jc = mockJoinContext('periods', { workers: WORKERS })
    const q = new Query(
      staticSource(PERIODS),
      { clauses: [], orderBy: [], limit: undefined, offset: 0, joins: [] },
      jc,
    ).crossJoin('workers', { as: 'worker' })
    const plan = q._plan()
    expect(plan.clauses).toHaveLength(1)
    expect(plan.clauses[0]).toMatchObject({ type: 'crossJoin', target: 'workers', as: 'worker' })
  })

  it('is immutable — original query is unchanged', () => {
    const jc = mockJoinContext('periods', { workers: WORKERS })
    const base = new Query(
      staticSource(PERIODS),
      { clauses: [], orderBy: [], limit: undefined, offset: 0, joins: [] },
      jc,
    )
    const q2 = base.crossJoin('workers', { as: 'worker' })
    expect(base._plan().clauses).toHaveLength(0)
    expect(q2._plan().clauses).toHaveLength(1)
  })

  it('throws when called on a Query with no joinContext', () => {
    const base = new Query(staticSource(PERIODS))
    expect(() => base.crossJoin('workers', { as: 'worker' })).toThrow('join context')
  })
})

describe('Query.crossJoin() > full cartesian execution', () => {
  it('produces leftRows × rightRows pairs', () => {
    const jc = mockJoinContext('periods', { workers: WORKERS })
    const result = new Query(
      staticSource(PERIODS),
      { clauses: [], orderBy: [], limit: undefined, offset: 0, joins: [] },
      jc,
    )
      .crossJoin<(typeof WORKERS)[0], 'worker'>('workers', { as: 'worker' })
      .toArray()
    expect(result).toHaveLength(4) // 2 periods × 2 workers
    expect(result[0]).toMatchObject({ id: 'p1', start: '2026-01', worker: { id: 'w1', name: 'Alice' } })
    expect(result[1]).toMatchObject({ id: 'p1', worker: { id: 'w2', name: 'Bob' } })
    expect(result[2]).toMatchObject({ id: 'p2', worker: { id: 'w1', name: 'Alice' } })
    expect(result[3]).toMatchObject({ id: 'p2', worker: { id: 'w2', name: 'Bob' } })
  })

  it('where() before crossJoin filters the left side first', () => {
    const jc = mockJoinContext('periods', { workers: WORKERS })
    const result = new Query(
      staticSource(PERIODS),
      { clauses: [], orderBy: [], limit: undefined, offset: 0, joins: [] },
      jc,
    )
      .where('id', '==', 'p1')
      .crossJoin<(typeof WORKERS)[0], 'worker'>('workers', { as: 'worker' })
      .toArray()
    expect(result).toHaveLength(2) // 1 period × 2 workers
    expect(result.every((r: any) => r.id === 'p1')).toBe(true)
  })

  it('where() after crossJoin filters on the alias', () => {
    const jc = mockJoinContext('periods', { workers: WORKERS })
    const result = new Query(
      staticSource(PERIODS),
      { clauses: [], orderBy: [], limit: undefined, offset: 0, joins: [] },
      jc,
    )
      .crossJoin<(typeof WORKERS)[0], 'worker'>('workers', { as: 'worker' })
      .where('worker.name', '==', 'Alice')
      .toArray()
    expect(result).toHaveLength(2) // 2 periods × Alice only
    expect(result.every((r: any) => r.worker.name === 'Alice')).toBe(true)
  })

  it('throws CrossJoinSourceUnknownError when target collection is not in join context', () => {
    const jc = mockJoinContext('periods', {}) // no workers source
    const q = new Query(
      staticSource(PERIODS),
      { clauses: [], orderBy: [], limit: undefined, offset: 0, joins: [] },
      jc,
    ).crossJoin('workers', { as: 'worker' })
    expect(() => q.toArray()).toThrow(CrossJoinSourceUnknownError)
  })
})

describe('executePlan > throws on crossJoin clauses', () => {
  it('executePlan() throws when plan contains crossJoin clauses', () => {
    const plan: QueryPlan = {
      clauses: [{ type: 'crossJoin', target: 'workers', as: 'worker' }],
      orderBy: [],
      limit: undefined,
      offset: 0,
      joins: [],
    }
    expect(() => executePlan([], plan)).toThrow('executePlan')
  })
})

describe('Query.crossJoin() > cost ceiling', () => {
  it('throws CrossJoinTooLargeError when product exceeds default limit', () => {
    // 251 × 200 = 50,200 > 50,000
    const leftRecords = Array.from({ length: 251 }, (_, i) => ({ id: `l${i}` }))
    const rightRecords = Array.from({ length: 200 }, (_, i) => ({ id: `r${i}` }))
    const jc = mockJoinContext('left', { right: rightRecords })
    const q = new Query(
      staticSource(leftRecords),
      { clauses: [], orderBy: [], limit: undefined, offset: 0, joins: [] },
      jc,
    ).crossJoin('right', { as: 'r' })
    expect(() => q.toArray()).toThrow(CrossJoinTooLargeError)
  })

  it('error carries correct expected and limit values', () => {
    const left = Array.from({ length: 300 }, (_, i) => ({ id: `l${i}` }))
    const right = Array.from({ length: 200 }, (_, i) => ({ id: `r${i}` }))
    const jc = mockJoinContext('left', { right })
    const q = new Query(
      staticSource(left),
      { clauses: [], orderBy: [], limit: undefined, offset: 0, joins: [] },
      jc,
    ).crossJoin('right', { as: 'r' })
    let err: CrossJoinTooLargeError | undefined
    try { q.toArray() } catch (e) { err = e as CrossJoinTooLargeError }
    expect(err?.expected).toBe(60_000)
    expect(err?.limit).toBe(50_000)
  })

  it('per-clause maxRows override raises the ceiling', () => {
    const left = Array.from({ length: 300 }, (_, i) => ({ id: `l${i}` }))
    const right = Array.from({ length: 200 }, (_, i) => ({ id: `r${i}` }))
    const jc = mockJoinContext('left', { right })
    const result = new Query(
      staticSource(left),
      { clauses: [], orderBy: [], limit: undefined, offset: 0, joins: [] },
      jc,
    )
      .crossJoin('right', { as: 'r', maxRows: 100_000 })
      .toArray()
    expect(result).toHaveLength(60_000)
  })
})

const PERIODS_LATERAL = [
  { id: 'p1', start: '2026-01', end: '2026-03' },
  { id: 'p2', start: '2026-04', end: '2026-06' },
]
const WORKERS_LATERAL = [
  { id: 'w1', name: 'Alice', since: '2026-01', until: null as null | string },
  { id: 'w2', name: 'Bob',   since: '2026-03', until: '2026-05' },
  { id: 'w3', name: 'Carol', since: '2026-05', until: null as null | string },
]

describe('Query.crossJoin() > lateral on: subset form', () => {
  it('on: (left) => TTarget[] supplies the exact right rows for each left row', () => {
    const jc = mockJoinContext('periods', { workers: WORKERS_LATERAL })
    const result = new Query(
      staticSource(PERIODS_LATERAL),
      { clauses: [], orderBy: [], limit: undefined, offset: 0, joins: [] },
      jc,
    )
      .crossJoin<(typeof WORKERS_LATERAL)[0], 'worker'>('workers', {
        as: 'worker',
        on: (period: any) =>
          (WORKERS_LATERAL as typeof WORKERS_LATERAL).filter(
            (w) => w.since <= period.start && (w.until === null || w.until >= period.end),
          ),
      })
      .toArray()
    // p1 start='2026-01' end='2026-03': Alice (since 01, until null) ✓; Bob (since 03 <= 01? NO, 03 > 01) ✗; Carol ✗ → 1
    // Wait — re-check: p1.start='2026-01', Bob.since='2026-03', '2026-03' <= '2026-01'? No. → p1: Alice only
    // p2 start='2026-04' end='2026-06': Alice (since 01 <= 04, until null ✓); Bob (since 03 <= 04, until 05 < 06) ✗; Carol (since 05 > 04) ✗ → 1
    // Hmm let me re-examine: p1 end='2026-03'. Alice until null → ✓. Bob since '2026-03' <= p1.start '2026-01'? No. Carol ✗.
    // p2 end='2026-06'. Alice ✓. Bob since '2026-03' <= '2026-04' ✓, until '2026-05' >= '2026-06'? '2026-05' >= '2026-06'? No. ✗.
    // Carol since '2026-05' <= '2026-04'? No. ✗. → p2: Alice only
    // So result should be 2 rows (p1:Alice, p2:Alice)
    expect(result).toHaveLength(2)
    expect(result.map((r: any) => `${r.id}:${r.worker.name}`).sort()).toEqual(
      ['p1:Alice', 'p2:Alice'],
    )
  })
})

describe('Query.crossJoin() > lateral on: predicate form', () => {
  it('on: (left) => (right) => boolean filters each right row against the left row', () => {
    const jc = mockJoinContext('periods', { workers: WORKERS_LATERAL })
    const result = new Query(
      staticSource(PERIODS_LATERAL),
      { clauses: [], orderBy: [], limit: undefined, offset: 0, joins: [] },
      jc,
    )
      .crossJoin<(typeof WORKERS_LATERAL)[0], 'worker'>('workers', {
        as: 'worker',
        on: (period: any) => (worker: any) =>
          worker.since <= period.start && (worker.until === null || worker.until >= period.end),
      })
      .toArray()
    expect(result).toHaveLength(2)
    expect(result.map((r: any) => `${r.id}:${r.worker.name}`).sort()).toEqual(
      ['p1:Alice', 'p2:Alice'],
    )
  })

  it('lateral ceiling is cumulative (post-filter count across left rows)', () => {
    // 2 left rows × 26 right rows each = 52 > 50 limit → throws
    const left = [{ id: 'a' }, { id: 'b' }]
    const right = Array.from({ length: 26 }, (_, i) => ({ id: `r${i}` }))
    const jc = mockJoinContext('left', { right })
    const q = new Query(
      staticSource(left),
      { clauses: [], orderBy: [], limit: undefined, offset: 0, joins: [] },
      jc,
    ).crossJoin('right', { as: 'r', maxRows: 50, on: (_: any) => right })
    expect(() => q.toArray()).toThrow(CrossJoinTooLargeError)
  })
})

describe('Query.crossJoin() > count()', () => {
  it('count() returns expanded relation size', () => {
    const jc = mockJoinContext('periods', { workers: WORKERS })
    const q = new Query(
      staticSource(PERIODS),
      { clauses: [], orderBy: [], limit: undefined, offset: 0, joins: [] },
      jc,
    ).crossJoin('workers', { as: 'worker' })
    expect(q.count()).toBe(4) // 2 × 2
  })
})

describe('Query.crossJoin() > groupBy().aggregate()', () => {
  it('groupBy on a left-side field after cross-join groups the expanded relation', () => {
    const jc = mockJoinContext('periods', { workers: WORKERS })
    const result = new Query(
      staticSource(PERIODS),
      { clauses: [], orderBy: [], limit: undefined, offset: 0, joins: [] },
      jc,
      AGG,
    )
      .crossJoin('workers', { as: 'worker' })
      .groupBy('id')
      .aggregate({ workerCount: count() })
      .run()
    expect(result).toHaveLength(2)
    expect(result.map((r: any) => r.workerCount)).toEqual([2, 2])
  })

  it('groupBy on alias field groups by right-side key', () => {
    const jc = mockJoinContext('periods', { workers: WORKERS })
    const result = new Query(
      staticSource(PERIODS),
      { clauses: [], orderBy: [], limit: undefined, offset: 0, joins: [] },
      jc,
      AGG,
    )
      .crossJoin<(typeof WORKERS)[0], 'worker'>('workers', { as: 'worker' })
      .groupBy('worker.name')
      .aggregate({ periodCount: count() })
      .run()
    expect(result).toHaveLength(2)
    expect(result.map((r: any) => r.periodCount)).toEqual([2, 2])
  })
})

describe('Query.crossJoin() > live() subscriptions', () => {
  it('live() subscribes to right-side collection changes', () => {
    let rightCallback: (() => void) | undefined
    const rightSourceWithSub = {
      snapshot: () => WORKERS as unknown[],
      subscribe: (cb: () => void) => {
        rightCallback = cb
        return () => { rightCallback = undefined }
      },
    }
    const jc: JoinContext = {
      leftCollection: 'periods',
      resolveRef: () => null,
      resolveSource: (name: string) => name === 'workers' ? rightSourceWithSub : null,
    }
    const leftSource = {
      snapshot: () => PERIODS as unknown[],
      subscribe: (_cb: () => void) => { return () => {} },
    }
    const q = new Query(leftSource as any, { clauses: [], orderBy: [], limit: undefined, offset: 0, joins: [] }, jc)
      .crossJoin('workers', { as: 'worker' })

    let notifications = 0
    const live = q.live()
    live.subscribe(() => { notifications++ })

    rightCallback?.()
    expect(notifications).toBeGreaterThan(0)
    live.stop()
  })
})

describe('analyzeDependencies > cross-join targets as dependency sources', () => {
  it('includes cross-join target collection in dependency set', () => {
    const jc = mockJoinContext('periods', { workers: WORKERS })
    const q = new Query(
      staticSource(PERIODS),
      { clauses: [], orderBy: [], limit: undefined, offset: 0, joins: [] },
      jc,
    ).crossJoin('workers', { as: 'worker' })
    const deps = analyzeDependencies(q)
    expect(deps.has('periods')).toBe(true)
    expect(deps.has('workers')).toBe(true)
  })

  it('deduplicates multiple cross-joins to the same target', () => {
    const jc = mockJoinContext('periods', { workers: WORKERS })
    const q = new Query(
      staticSource(PERIODS),
      { clauses: [], orderBy: [], limit: undefined, offset: 0, joins: [] },
      jc,
    )
      .crossJoin('workers', { as: 'w1' })
      .crossJoin('workers', { as: 'w2' })
    const deps = analyzeDependencies(q)
    expect(deps.size).toBe(2) // periods + workers (deduped)
  })
})

describe('summarizeQueryPlan > cross-join in queryHash', () => {
  it('folds cross-join target and alias into the summary', () => {
    const jc = mockJoinContext('periods', { workers: WORKERS })
    const q1 = new Query(
      staticSource(PERIODS),
      { clauses: [], orderBy: [], limit: undefined, offset: 0, joins: [] },
      jc,
    ).crossJoin('workers', { as: 'worker' })
    const q2 = new Query(
      staticSource(PERIODS),
      { clauses: [], orderBy: [], limit: undefined, offset: 0, joins: [] },
      jc,
    ).crossJoin('other', { as: 'worker' }) // different target
    expect(summarizeQueryPlan(q1)).not.toBe(summarizeQueryPlan(q2))
  })

  it('folds onPredicateName into the summary when present', () => {
    const predicates = new Map([['isActive', { hash: 'isActive-v1', fn: (_rec: unknown) => true }]])
    const jc = mockJoinContext('periods', { workers: WORKERS })

    // Need aggregateStrategy for _withPredicates to work in tests
    // Actually _withPredicates only attaches a predicates map — it doesn't need aggregateStrategy
    // Use the same pattern as query-predicate tests: get a Query with predicates via _withPredicates
    const base = new Query(
      staticSource(PERIODS),
      { clauses: [], orderBy: [], limit: undefined, offset: 0, joins: [] },
      jc,
    )._withPredicates(predicates)

    const qNamed = base.crossJoin('workers', { as: 'w', on: { predicate: 'isActive' } })
    const qNoOn = new Query(
      staticSource(PERIODS),
      { clauses: [], orderBy: [], limit: undefined, offset: 0, joins: [] },
      jc,
    ).crossJoin('workers', { as: 'w' })

    expect(summarizeQueryPlan(qNamed)).not.toBe(summarizeQueryPlan(qNoOn))
  })
})
