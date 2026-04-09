/**
 * Tests for Query.groupBy() — v0.6 #98.
 *
 * Covers the bucket-and-reduce pipeline, cardinality warn/hard-error
 * thresholds, insertion-order bucket emission, null/undefined key
 * distinction, and reactive live mode over mutable sources.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  Query,
  count,
  sum,
  avg,
  min,
  max,
  groupAndReduce,
  resetGroupByWarnings,
  GROUPBY_WARN_CARDINALITY,
  GROUPBY_MAX_CARDINALITY,
  type QuerySource,
} from '../src/query/index.js'
import { GroupCardinalityError } from '../src/errors.js'

interface Invoice {
  id: string
  status: 'draft' | 'open' | 'paid' | 'overdue'
  clientId: string | null
  amount: number
}

const SAMPLE: Invoice[] = [
  { id: 'a', status: 'open',  clientId: 'c1', amount: 100  },
  { id: 'b', status: 'open',  clientId: 'c1', amount: 250  },
  { id: 'c', status: 'open',  clientId: 'c2', amount: 5000 },
  { id: 'd', status: 'paid',  clientId: 'c2', amount: 800  },
  { id: 'e', status: 'paid',  clientId: 'c3', amount: 1500 },
]

function staticSource<T>(records: T[]): QuerySource<T> {
  return { snapshot: () => records }
}

function mutableSource<T>(initial: T[]): {
  source: QuerySource<T>
  push: (record: T) => void
  remove: (predicate: (r: T) => boolean) => void
  update: (predicate: (r: T) => boolean, patch: Partial<T>) => void
} {
  let records: T[] = [...initial]
  const listeners = new Set<() => void>()
  const notify = (): void => {
    for (const cb of listeners) cb()
  }
  return {
    source: {
      snapshot: () => records,
      subscribe: (cb) => {
        listeners.add(cb)
        return () => listeners.delete(cb)
      },
    },
    push: (r) => {
      records = [...records, r]
      notify()
    },
    remove: (p) => {
      records = records.filter((r) => !p(r))
      notify()
    },
    update: (p, patch) => {
      records = records.map((r) => (p(r) ? { ...r, ...patch } : r))
      notify()
    },
  }
}

beforeEach(() => {
  resetGroupByWarnings()
})

// ---------------------------------------------------------------------------
// Basic grouping
// ---------------------------------------------------------------------------

describe('groupBy > basic bucketing', () => {
  it('groups by a single field and runs reducers per bucket', () => {
    const result = new Query<Invoice>(staticSource(SAMPLE))
      .groupBy('clientId')
      .aggregate({ total: sum('amount'), n: count() })
      .run()
    expect(result).toEqual([
      { clientId: 'c1', total: 350,  n: 2 },
      { clientId: 'c2', total: 5800, n: 2 },
      { clientId: 'c3', total: 1500, n: 1 },
    ])
  })

  it('supports multiple reducers per bucket', () => {
    const result = new Query<Invoice>(staticSource(SAMPLE))
      .groupBy('status')
      .aggregate({
        n:       count(),
        total:   sum('amount'),
        average: avg('amount'),
        lo:      min('amount'),
        hi:      max('amount'),
      })
      .run()
    expect(result).toHaveLength(2)
    const open = result.find((r) => r.status === 'open')!
    const paid = result.find((r) => r.status === 'paid')!
    expect(open).toEqual({
      status: 'open', n: 3, total: 5350, average: 5350 / 3, lo: 100, hi: 5000,
    })
    expect(paid).toEqual({
      status: 'paid', n: 2, total: 2300, average: 1150, lo: 800, hi: 1500,
    })
  })

  it('composes with where() — grouping happens after filtering', () => {
    const result = new Query<Invoice>(staticSource(SAMPLE))
      .where('status', '==', 'open')
      .groupBy('clientId')
      .aggregate({ total: sum('amount'), n: count() })
      .run()
    expect(result).toEqual([
      { clientId: 'c1', total: 350,  n: 2 },
      { clientId: 'c2', total: 5000, n: 1 },
    ])
  })

  it('emits buckets in first-seen insertion order', () => {
    // Reorder the sample so c3 appears first, then c1, then c2 —
    // Map preserves insertion order and the result should match.
    const reordered: Invoice[] = [
      { id: 'e', status: 'paid', clientId: 'c3', amount: 1500 },
      { id: 'a', status: 'open', clientId: 'c1', amount: 100  },
      { id: 'c', status: 'open', clientId: 'c2', amount: 5000 },
      { id: 'b', status: 'open', clientId: 'c1', amount: 250  },
    ]
    const result = new Query<Invoice>(staticSource(reordered))
      .groupBy('clientId')
      .aggregate({ n: count() })
      .run()
    expect(result.map((r) => r.clientId)).toEqual(['c3', 'c1', 'c2'])
  })

  it('returns an empty array for an empty result set', () => {
    const result = new Query<Invoice>(staticSource(SAMPLE))
      .where('status', '==', 'nonexistent')
      .groupBy('clientId')
      .aggregate({ n: count() })
      .run()
    expect(result).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Null / undefined key handling
// ---------------------------------------------------------------------------

describe('groupBy > null / undefined key distinction', () => {
  it('records with an explicit null group key get their own bucket', () => {
    const withNulls: Invoice[] = [
      ...SAMPLE,
      { id: 'f', status: 'draft', clientId: null, amount: 99 },
      { id: 'g', status: 'draft', clientId: null, amount: 1  },
    ]
    const result = new Query<Invoice>(staticSource(withNulls))
      .groupBy('clientId')
      .aggregate({ total: sum('amount'), n: count() })
      .run()
    const nullBucket = result.find((r) => r.clientId === null)
    expect(nullBucket).toEqual({ clientId: null, total: 100, n: 2 })
  })

  it('records with a missing field get an undefined-key bucket, separate from null', () => {
    const mixed = [
      { id: '1', clientId: null, amount: 10 },
      { id: '2',                 amount: 20 },
      { id: '3', clientId: null, amount: 30 },
      { id: '4',                 amount: 40 },
    ] as Invoice[]
    const result = new Query<Invoice>(staticSource(mixed))
      .groupBy('clientId')
      .aggregate({ total: sum('amount'), n: count() })
      .run()
    expect(result).toHaveLength(2)
    const nullBucket = result.find((r) => r.clientId === null)
    const undefBucket = result.find((r) => r.clientId === undefined)
    expect(nullBucket).toEqual({ clientId: null,      total: 40, n: 2 })
    expect(undefBucket).toEqual({ clientId: undefined, total: 60, n: 2 })
  })
})

// ---------------------------------------------------------------------------
// Cardinality thresholds
// ---------------------------------------------------------------------------

describe('groupBy > cardinality warn at 10k', () => {
  it('fires a one-shot warning when the bucket count hits the warn threshold', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const records = Array.from({ length: GROUPBY_WARN_CARDINALITY }, (_, i) => ({
      id: `r${i}`,
      bucket: `b${i}`,
      amount: 1,
    }))
    new Query(staticSource(records))
      .groupBy('bucket')
      .aggregate({ n: count() })
      .run()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const msg = warnSpy.mock.calls[0]![0] as string
    expect(msg).toContain(`${GROUPBY_WARN_CARDINALITY} distinct groups`)
    expect(msg).toContain('bucket')
    warnSpy.mockRestore()
  })

  it('does not fire the warning below the threshold', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const records = Array.from({ length: 100 }, (_, i) => ({
      id: `r${i}`,
      bucket: `b${i}`,
      amount: 1,
    }))
    new Query(staticSource(records))
      .groupBy('bucket')
      .aggregate({ n: count() })
      .run()
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('deduplicates the warning across multiple runs of the same field', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const records = Array.from({ length: GROUPBY_WARN_CARDINALITY }, (_, i) => ({
      id: `r${i}`,
      bucket: `b${i}`,
      amount: 1,
    }))
    const q = new Query(staticSource(records))
      .groupBy('bucket')
      .aggregate({ n: count() })
    q.run()
    q.run()
    q.run()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    warnSpy.mockRestore()
  })
})

describe('groupBy > cardinality hard cap at 100k', () => {
  it('throws GroupCardinalityError when the bucket count exceeds the hard cap', () => {
    // Use a much smaller synthetic path: call groupAndReduce directly
    // with 100_001 distinct records so we don't materialize 100k
    // objects just to exercise the failure path.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const records = Array.from({ length: GROUPBY_MAX_CARDINALITY + 1 }, (_, i) => ({
      id: `r${i}`,
      k: `k${i}`,
    }))
    expect(() =>
      groupAndReduce(records, 'k', { n: count() }),
    ).toThrow(GroupCardinalityError)
    warnSpy.mockRestore()
  })

  it('GroupCardinalityError carries the field, cardinality, and cap', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const records = Array.from({ length: GROUPBY_MAX_CARDINALITY + 1 }, (_, i) => ({
      id: `r${i}`,
      k: `k${i}`,
    }))
    try {
      groupAndReduce(records, 'k', { n: count() })
      throw new Error('expected GroupCardinalityError')
    } catch (err) {
      expect(err).toBeInstanceOf(GroupCardinalityError)
      const e = err as GroupCardinalityError
      expect(e.field).toBe('k')
      expect(e.cardinality).toBe(GROUPBY_MAX_CARDINALITY + 1)
      expect(e.maxGroups).toBe(GROUPBY_MAX_CARDINALITY)
      expect(e.code).toBe('GROUP_CARDINALITY')
    }
    warnSpy.mockRestore()
  })

  it('the error class re-exports from the public package barrel', async () => {
    // Guards against a duplicate-export accident where the public
    // barrel (`@noy-db/core`) produces a structurally-similar but
    // distinct class from `errors.ts`. Import dynamically because
    // the test file already imports from the errors module directly.
    const pkg = await import('../src/index.js')
    expect(pkg.GroupCardinalityError).toBe(GroupCardinalityError)
  })
})

// ---------------------------------------------------------------------------
// Pure helper
// ---------------------------------------------------------------------------

describe('groupBy > groupAndReduce pure helper', () => {
  it('runs the same pipeline as .groupBy().aggregate().run()', () => {
    const via = new Query<Invoice>(staticSource(SAMPLE))
      .groupBy('clientId')
      .aggregate({ total: sum('amount'), n: count() })
      .run()
    const direct = groupAndReduce(SAMPLE, 'clientId', {
      total: sum('amount'),
      n: count(),
    })
    expect(direct).toEqual(via)
  })
})

// ---------------------------------------------------------------------------
// Live mode
// ---------------------------------------------------------------------------

describe('groupBy > .live() re-fires on source changes', () => {
  it('computes the initial grouping eagerly', () => {
    const { source } = mutableSource<Invoice>(SAMPLE)
    const live = new Query<Invoice>(source)
      .groupBy('clientId')
      .aggregate({ total: sum('amount'), n: count() })
      .live()
    expect(live.value).toEqual([
      { clientId: 'c1', total: 350,  n: 2 },
      { clientId: 'c2', total: 5800, n: 2 },
      { clientId: 'c3', total: 1500, n: 1 },
    ])
    expect(live.error).toBeUndefined()
    live.stop()
  })

  it('re-fires when a record is inserted into an existing bucket', () => {
    const src = mutableSource<Invoice>(SAMPLE)
    const live = new Query<Invoice>(src.source)
      .groupBy('clientId')
      .aggregate({ total: sum('amount'), n: count() })
      .live()
    src.push({ id: 'new', status: 'open', clientId: 'c1', amount: 50 })
    const c1 = live.value!.find((r) => r.clientId === 'c1')!
    expect(c1).toEqual({ clientId: 'c1', total: 400, n: 3 })
    live.stop()
  })

  it('re-fires and creates a new bucket when the inserted record has a new key', () => {
    const src = mutableSource<Invoice>(SAMPLE)
    const live = new Query<Invoice>(src.source)
      .groupBy('clientId')
      .aggregate({ total: sum('amount'), n: count() })
      .live()
    expect(live.value).toHaveLength(3)
    src.push({ id: 'new', status: 'open', clientId: 'c99', amount: 42 })
    expect(live.value).toHaveLength(4)
    const c99 = live.value!.find((r) => r.clientId === 'c99')
    expect(c99).toEqual({ clientId: 'c99', total: 42, n: 1 })
    live.stop()
  })

  it('re-fires and removes a bucket when its last record is deleted', () => {
    const src = mutableSource<Invoice>(SAMPLE)
    const live = new Query<Invoice>(src.source)
      .groupBy('clientId')
      .aggregate({ total: sum('amount'), n: count() })
      .live()
    src.remove((r) => r.id === 'e') // the only c3
    expect(live.value).toHaveLength(2)
    expect(live.value!.find((r) => r.clientId === 'c3')).toBeUndefined()
    live.stop()
  })

  it('re-fires and moves a record between buckets on update', () => {
    const src = mutableSource<Invoice>(SAMPLE)
    const live = new Query<Invoice>(src.source)
      .groupBy('clientId')
      .aggregate({ n: count() })
      .live()
    expect(live.value!.find((r) => r.clientId === 'c1')!.n).toBe(2)
    expect(live.value!.find((r) => r.clientId === 'c2')!.n).toBe(2)
    src.update((r) => r.id === 'a', { clientId: 'c2' })
    expect(live.value!.find((r) => r.clientId === 'c1')!.n).toBe(1)
    expect(live.value!.find((r) => r.clientId === 'c2')!.n).toBe(3)
    live.stop()
  })

  it('subscribe() notifies listeners on each re-fire, stop() tears down upstreams', () => {
    const src = mutableSource<Invoice>(SAMPLE)
    const live = new Query<Invoice>(src.source)
      .groupBy('clientId')
      .aggregate({ n: count() })
      .live()
    let notifications = 0
    live.subscribe(() => { notifications++ })
    src.push({ id: 'x', status: 'open', clientId: 'c1', amount: 1 })
    src.push({ id: 'y', status: 'open', clientId: 'c2', amount: 1 })
    expect(notifications).toBe(2)
    live.stop()
    src.push({ id: 'z', status: 'open', clientId: 'c1', amount: 1 })
    expect(notifications).toBe(2) // no further notifications after stop
  })
})
