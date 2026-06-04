import { describe, it, expect } from 'vitest'
import { evaluateClause, type Clause, type CrossJoinClause } from '../src/query/predicate.js'
import { Query, type QueryPlan } from '../src/query/index.js'
import { CrossJoinTooLargeError, CrossJoinSourceUnknownError } from '../src/errors.js'
import type { QuerySource, JoinContext, JoinableSource } from '../src/query/index.js'

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
