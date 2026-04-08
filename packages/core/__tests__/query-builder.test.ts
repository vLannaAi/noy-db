import { describe, it, expect } from 'vitest'
import { Query, executePlan, type QuerySource, type QueryPlan } from '../src/query/index.js'

interface Invoice {
  id: string
  status: 'draft' | 'open' | 'paid' | 'overdue'
  amount: number
  client: string
  dueDate: string
}

const SAMPLE: Invoice[] = [
  { id: 'a', status: 'draft', amount: 100,  client: 'Alpha',   dueDate: '2026-04-01' },
  { id: 'b', status: 'open',  amount: 250,  client: 'Bravo',   dueDate: '2026-03-15' },
  { id: 'c', status: 'open',  amount: 5000, client: 'Charlie', dueDate: '2026-05-01' },
  { id: 'd', status: 'paid',  amount: 800,  client: 'Delta',   dueDate: '2026-02-28' },
  { id: 'e', status: 'overdue', amount: 1500, client: 'Echo',  dueDate: '2026-01-10' },
]

function staticSource<T>(records: T[]): QuerySource<T> {
  return { snapshot: () => records }
}

describe('Query > builder immutability', () => {
  it('where() returns a new query and does not mutate the original', () => {
    const q1 = new Query(staticSource(SAMPLE))
    const q2 = q1.where('status', '==', 'open')
    expect(q1).not.toBe(q2)
    expect(q1.toArray()).toHaveLength(5) // q1 unchanged
    expect(q2.toArray()).toHaveLength(2)
  })

  it('chained where() calls are AND', () => {
    const result = new Query<Invoice>(staticSource(SAMPLE))
      .where('status', '==', 'open')
      .where('amount', '>', 1000)
      .toArray()
    expect(result.map(r => r.id)).toEqual(['c'])
  })
})

describe('Query > all operators end-to-end', () => {
  const base = (): Query<Invoice> => new Query<Invoice>(staticSource(SAMPLE))

  it('==  matches exact values', () => {
    expect(base().where('status', '==', 'paid').toArray().map(r => r.id)).toEqual(['d'])
  })

  it('!=  matches non-equal values', () => {
    expect(base().where('status', '!=', 'paid').toArray()).toHaveLength(4)
  })

  it('<  >  >= <= work for numbers', () => {
    expect(base().where('amount', '<', 500).count()).toBe(2)
    expect(base().where('amount', '>=', 1500).count()).toBe(2)
  })

  it('in  matches against an array operand', () => {
    expect(base().where('status', 'in', ['draft', 'paid']).count()).toBe(2)
  })

  it('contains works on strings', () => {
    expect(base().where('client', 'contains', 'lph').count()).toBe(1)
  })

  it('startsWith filters string prefixes', () => {
    expect(base().where('client', 'startsWith', 'C').count()).toBe(1)
  })

  it('between is inclusive', () => {
    expect(base().where('amount', 'between', [200, 1000]).count()).toBe(2)
  })
})

describe('Query > composite predicates', () => {
  it('or() creates an OR group at the top level', () => {
    const result = new Query<Invoice>(staticSource(SAMPLE))
      .or((q) => q
        .where('status', '==', 'paid')
        .where('status', '==', 'overdue'),
      )
      .toArray()
    expect(result.map(r => r.id).sort()).toEqual(['d', 'e'])
  })

  it('and() inside or() expresses nested boolean logic', () => {
    const result = new Query<Invoice>(staticSource(SAMPLE))
      .or((q) => q
        .and((qq) => qq
          .where('status', '==', 'open')
          .where('amount', '>', 1000),
        )
        .where('status', '==', 'overdue'),
      )
      .toArray()
    expect(result.map(r => r.id).sort()).toEqual(['c', 'e'])
  })

  it('filter() escape hatch combines with where() via AND', () => {
    const result = new Query<Invoice>(staticSource(SAMPLE))
      .where('status', '==', 'open')
      .filter((r) => r.client.length > 5)
      .toArray()
    expect(result.map(r => r.id)).toEqual(['c'])
  })
})

describe('Query > ordering', () => {
  const base = (): Query<Invoice> => new Query<Invoice>(staticSource(SAMPLE))

  it('orderBy ascending', () => {
    expect(base().orderBy('amount').toArray().map(r => r.amount)).toEqual([100, 250, 800, 1500, 5000])
  })

  it('orderBy descending', () => {
    expect(base().orderBy('amount', 'desc').toArray().map(r => r.amount)).toEqual([5000, 1500, 800, 250, 100])
  })

  it('multiple orderBy as tiebreakers', () => {
    const records: Invoice[] = [
      { id: 'a', status: 'open', amount: 100, client: 'B', dueDate: '2026-01-01' },
      { id: 'b', status: 'open', amount: 100, client: 'A', dueDate: '2026-01-01' },
      { id: 'c', status: 'open', amount: 200, client: 'A', dueDate: '2026-01-01' },
    ]
    const result = new Query<Invoice>(staticSource(records))
      .orderBy('amount')
      .orderBy('client')
      .toArray()
    expect(result.map(r => r.id)).toEqual(['b', 'a', 'c'])
  })
})

describe('Query > pagination and terminal methods', () => {
  const base = (): Query<Invoice> => new Query<Invoice>(staticSource(SAMPLE))

  it('limit caps the result size', () => {
    expect(base().limit(2).toArray()).toHaveLength(2)
  })

  it('offset skips the leading records', () => {
    expect(base().orderBy('amount').offset(2).toArray().map(r => r.amount))
      .toEqual([800, 1500, 5000])
  })

  it('limit + offset combine for pagination', () => {
    expect(base().orderBy('amount').offset(1).limit(2).toArray().map(r => r.amount))
      .toEqual([250, 800])
  })

  it('first() returns one record or null', () => {
    expect(base().where('status', '==', 'paid').first()?.id).toBe('d')
    expect(base().where('status', '==', 'nope').first()).toBeNull()
  })

  it('count() reports total matches before limit', () => {
    expect(base().where('status', '==', 'open').limit(1).count()).toBe(2)
  })
})

describe('Query > plan serialization', () => {
  it('toPlan() returns a JSON-friendly object', () => {
    const plan = new Query<Invoice>(staticSource(SAMPLE))
      .where('status', '==', 'open')
      .where('amount', '>', 100)
      .orderBy('dueDate', 'desc')
      .limit(10)
      .toPlan()
    const json = JSON.stringify(plan)
    expect(JSON.parse(json)).toMatchObject({
      clauses: [
        { type: 'field', field: 'status', op: '==', value: 'open' },
        { type: 'field', field: 'amount', op: '>', value: 100 },
      ],
      orderBy: [{ field: 'dueDate', direction: 'desc' }],
      limit: 10,
    })
  })

  it('serializes filter clauses as a placeholder string', () => {
    const plan = new Query<Invoice>(staticSource(SAMPLE))
      .filter((r) => r.amount > 0)
      .toPlan() as { clauses: Array<{ type: string; fn?: string }> }
    expect(plan.clauses[0]).toEqual({ type: 'filter', fn: '[function]' })
  })
})

describe('Query > subscriptions', () => {
  it('subscribe() invokes the callback immediately and on source notify', () => {
    let records: Invoice[] = [...SAMPLE]
    const listeners = new Set<() => void>()
    const source: QuerySource<Invoice> = {
      snapshot: () => records,
      subscribe: (cb) => {
        listeners.add(cb)
        return () => listeners.delete(cb)
      },
    }
    const q = new Query<Invoice>(source).where('status', '==', 'open')

    const seen: Invoice[][] = []
    const stop = q.subscribe((result) => seen.push(result))

    expect(seen).toHaveLength(1)
    expect(seen[0]).toHaveLength(2)

    // Simulate a mutation: add a new open invoice and notify.
    records = [...records, { id: 'f', status: 'open', amount: 999, client: 'F', dueDate: '2026-06-01' }]
    listeners.forEach((l) => l())

    expect(seen).toHaveLength(2)
    expect(seen[1]).toHaveLength(3)

    stop()
    expect(listeners.size).toBe(0)
  })

  it('subscribe() throws if the source has no subscribe method', () => {
    const q = new Query<Invoice>(staticSource(SAMPLE))
    expect(() => q.subscribe(() => {})).toThrow(/does not support subscriptions/)
  })
})

describe('Query > parity with Array.filter (DoD criterion)', () => {
  // Generate 50 random predicates and assert the query result === Array.filter equivalent.
  // Operators chosen are the safe set: ==, !=, <, <=, >, >=, in, between.
  function rand(n: number): number { return Math.floor(Math.random() * n) }

  const dataset: Invoice[] = []
  for (let i = 0; i < 200; i++) {
    dataset.push({
      id: `inv-${i}`,
      status: (['draft', 'open', 'paid', 'overdue'] as const)[i % 4]!,
      amount: rand(10_000),
      client: `Client-${i % 20}`,
      dueDate: `2026-0${(i % 9) + 1}-15`,
    })
  }

  it('produces identical results to Array.filter for 50 random predicates', () => {
    const cases: Array<{
      build: (q: Query<Invoice>) => Query<Invoice>
      predicate: (r: Invoice) => boolean
    }> = []

    for (let i = 0; i < 50; i++) {
      const choice = i % 8
      switch (choice) {
        case 0: {
          const v = rand(10_000)
          cases.push({
            build: (q) => q.where('amount', '<', v),
            predicate: (r) => r.amount < v,
          })
          break
        }
        case 1: {
          const v = rand(10_000)
          cases.push({
            build: (q) => q.where('amount', '>=', v),
            predicate: (r) => r.amount >= v,
          })
          break
        }
        case 2: {
          const status = (['draft', 'open', 'paid', 'overdue'] as const)[i % 4]!
          cases.push({
            build: (q) => q.where('status', '==', status),
            predicate: (r) => r.status === status,
          })
          break
        }
        case 3: {
          const status = (['draft', 'open', 'paid', 'overdue'] as const)[i % 4]!
          cases.push({
            build: (q) => q.where('status', '!=', status),
            predicate: (r) => r.status !== status,
          })
          break
        }
        case 4: {
          const ids = [`Client-${rand(20)}`, `Client-${rand(20)}`, `Client-${rand(20)}`]
          cases.push({
            build: (q) => q.where('client', 'in', ids),
            predicate: (r) => ids.includes(r.client),
          })
          break
        }
        case 5: {
          const lo = rand(5000)
          const hi = lo + rand(5000)
          cases.push({
            build: (q) => q.where('amount', 'between', [lo, hi]),
            predicate: (r) => r.amount >= lo && r.amount <= hi,
          })
          break
        }
        case 6: {
          const v = rand(10_000)
          cases.push({
            build: (q) => q.where('amount', '<=', v).where('status', '==', 'open'),
            predicate: (r) => r.amount <= v && r.status === 'open',
          })
          break
        }
        case 7: {
          const v = rand(20)
          cases.push({
            build: (q) => q.where('client', '==', `Client-${v}`),
            predicate: (r) => r.client === `Client-${v}`,
          })
          break
        }
      }
    }

    expect(cases).toHaveLength(50)
    for (const { build, predicate } of cases) {
      const dslResult = build(new Query<Invoice>(staticSource(dataset))).toArray()
      const expected = dataset.filter(predicate)
      expect(dslResult).toEqual(expected)
    }
  })
})

describe('executePlan > pure function', () => {
  it('does not mutate the input array', () => {
    const records = [...SAMPLE]
    const before = [...records]
    const plan: QueryPlan = {
      clauses: [{ type: 'field', field: 'status', op: '==', value: 'open' }],
      orderBy: [{ field: 'amount', direction: 'desc' }],
      limit: 1,
      offset: 0,
    }
    executePlan(records, plan)
    expect(records).toEqual(before)
  })

  it('handles an empty record set', () => {
    const plan: QueryPlan = {
      clauses: [{ type: 'field', field: 'status', op: '==', value: 'open' }],
      orderBy: [],
      limit: undefined,
      offset: 0,
    }
    expect(executePlan([], plan)).toEqual([])
  })
})
