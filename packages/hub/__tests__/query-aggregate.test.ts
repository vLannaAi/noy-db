/**
 * Tests for Query.aggregate() — v0.6 #97.
 *
 * Covers the reducer factories (count/sum/avg/min/max), the
 * .aggregate().run() static terminal, and the .aggregate().live()
 * reactive terminal. Also verifies the #87 constraint #2 seam: every
 * reducer factory accepts a `{ seed }` parameter that is plumbed
 * through but unused by the v0.6 executor.
 *
 * All tests use plain-object QuerySource implementations so the
 * reduction pipeline can be exercised without spinning up a full
 * Collection — same pattern as query-builder.test.ts.
 */

import { describe, it, expect } from 'vitest'
import {
  Query,
  count,
  sum,
  avg,
  min,
  max,
  reduceRecords,
  type QuerySource,
} from '../src/query/index.js'

interface Invoice {
  id: string
  status: 'draft' | 'open' | 'paid' | 'overdue'
  amount: number
  client: string
}

const SAMPLE: Invoice[] = [
  { id: 'a', status: 'draft',   amount: 100,  client: 'Alpha'   },
  { id: 'b', status: 'open',    amount: 250,  client: 'Bravo'   },
  { id: 'c', status: 'open',    amount: 5000, client: 'Charlie' },
  { id: 'd', status: 'paid',    amount: 800,  client: 'Delta'   },
  { id: 'e', status: 'overdue', amount: 1500, client: 'Echo'    },
]

function staticSource<T>(records: T[]): QuerySource<T> {
  return { snapshot: () => records }
}

/**
 * Minimal mutable source with subscribe support for live-mode tests.
 * Holds the record array directly and fires listeners on every mutation.
 */
function mutableSource<T>(initial: T[]): {
  source: QuerySource<T>
  push: (record: T) => void
  remove: (predicate: (r: T) => boolean) => void
  update: (predicate: (r: T) => boolean, patch: Partial<T>) => void
  set: (records: T[]) => void
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
    push: (record) => {
      records = [...records, record]
      notify()
    },
    remove: (predicate) => {
      records = records.filter((r) => !predicate(r))
      notify()
    },
    update: (predicate, patch) => {
      records = records.map((r) => (predicate(r) ? { ...r, ...patch } : r))
      notify()
    },
    set: (next) => {
      records = [...next]
      notify()
    },
  }
}

// ---------------------------------------------------------------------------
// Reducer factories — individual and combined
// ---------------------------------------------------------------------------

describe('aggregate > count()', () => {
  it('counts the number of matching records', () => {
    const result = new Query<Invoice>(staticSource(SAMPLE))
      .aggregate({ n: count() })
      .run()
    expect(result.n).toBe(5)
  })

  it('counts zero for an empty result set', () => {
    const result = new Query<Invoice>(staticSource(SAMPLE))
      .where('status', '==', 'nonexistent')
      .aggregate({ n: count() })
      .run()
    expect(result.n).toBe(0)
  })

  it('counts filtered matches only', () => {
    const result = new Query<Invoice>(staticSource(SAMPLE))
      .where('status', '==', 'open')
      .aggregate({ n: count() })
      .run()
    expect(result.n).toBe(2)
  })
})

describe('aggregate > sum()', () => {
  it('sums a numeric field across all records', () => {
    const result = new Query<Invoice>(staticSource(SAMPLE))
      .aggregate({ total: sum('amount') })
      .run()
    expect(result.total).toBe(100 + 250 + 5000 + 800 + 1500)
  })

  it('returns 0 for an empty result set', () => {
    const result = new Query<Invoice>(staticSource(SAMPLE))
      .where('status', '==', 'nonexistent')
      .aggregate({ total: sum('amount') })
      .run()
    expect(result.total).toBe(0)
  })

  it('sums a filtered slice only', () => {
    const result = new Query<Invoice>(staticSource(SAMPLE))
      .where('status', '==', 'open')
      .aggregate({ total: sum('amount') })
      .run()
    expect(result.total).toBe(250 + 5000)
  })

  it('coerces non-number field values to 0', () => {
    const result = new Query(staticSource([
      { id: '1', amount: 100 },
      { id: '2', amount: 'oops' as unknown as number },
      { id: '3', amount: 200 },
    ]))
      .aggregate({ total: sum('amount') })
      .run()
    expect(result.total).toBe(300)
  })
})

describe('aggregate > avg()', () => {
  it('computes the arithmetic mean of a numeric field', () => {
    const result = new Query<Invoice>(staticSource(SAMPLE))
      .aggregate({ meanAmount: avg('amount') })
      .run()
    const expected = (100 + 250 + 5000 + 800 + 1500) / 5
    expect(result.meanAmount).toBe(expected)
  })

  it('returns null for an empty result set (not NaN)', () => {
    const result = new Query<Invoice>(staticSource(SAMPLE))
      .where('status', '==', 'nonexistent')
      .aggregate({ meanAmount: avg('amount') })
      .run()
    expect(result.meanAmount).toBeNull()
  })
})

describe('aggregate > min() / max()', () => {
  it('finds the minimum of a numeric field', () => {
    const result = new Query<Invoice>(staticSource(SAMPLE))
      .aggregate({ smallest: min('amount') })
      .run()
    expect(result.smallest).toBe(100)
  })

  it('finds the maximum of a numeric field', () => {
    const result = new Query<Invoice>(staticSource(SAMPLE))
      .aggregate({ largest: max('amount') })
      .run()
    expect(result.largest).toBe(5000)
  })

  it('returns null for an empty result set (not -Infinity / Infinity)', () => {
    const empty = new Query<Invoice>(staticSource(SAMPLE))
      .where('status', '==', 'nonexistent')
      .aggregate({ lo: min('amount'), hi: max('amount') })
      .run()
    expect(empty.lo).toBeNull()
    expect(empty.hi).toBeNull()
  })
})

describe('aggregate > combined spec', () => {
  it('runs multiple reducers in a single pass and returns a named object', () => {
    const result = new Query<Invoice>(staticSource(SAMPLE))
      .where('status', '==', 'open')
      .aggregate({
        total:     sum('amount'),
        n:         count(),
        meanAmount: avg('amount'),
        smallest:  min('amount'),
        largest:   max('amount'),
      })
      .run()
    expect(result).toEqual({
      total: 5250,
      n: 2,
      meanAmount: 2625,
      smallest: 250,
      largest: 5000,
    })
  })

  it('preserves the shape of the spec at the type level', () => {
    // Compile-time check — if this assigns, the mapped type
    // AggregateResult<Spec> is extracting R correctly from each
    // Reducer<R, _> in the spec.
    const result = new Query<Invoice>(staticSource(SAMPLE))
      .aggregate({
        total: sum('amount'),
        n: count(),
        meanAmount: avg('amount'),
      })
      .run()
    const total: number = result.total
    const n: number = result.n
    const meanAmount: number | null = result.meanAmount
    expect([total, n, meanAmount]).toEqual([7650, 5, 1530])
  })
})

// ---------------------------------------------------------------------------
// #87 constraint #2 — seed parameter plumbing
// ---------------------------------------------------------------------------

describe('aggregate > #87 seed parameter seam', () => {
  it('every reducer factory accepts a { seed } option without affecting v0.6 output', () => {
    // v0.6 executor intentionally ignores seed — this test pins that
    // behavior. When v0.10 partition-aware aggregation lands, the
    // expectation here changes and the test moves to a partition-
    // awareness suite. For now: passing a seed must be a no-op.
    const withoutSeed = new Query<Invoice>(staticSource(SAMPLE))
      .aggregate({
        total:     sum('amount'),
        n:         count(),
        meanAmount: avg('amount'),
        lo:        min('amount'),
        hi:        max('amount'),
      })
      .run()
    const withSeed = new Query<Invoice>(staticSource(SAMPLE))
      .aggregate({
        total:     sum('amount', { seed: 999_999 }),
        n:         count({ seed: 42 }),
        meanAmount: avg('amount', { seed: { sum: 1000, count: 10 } }),
        lo:        min('amount', { seed: -9999 }),
        hi:        max('amount', { seed: 9999 }),
      })
      .run()
    expect(withSeed).toEqual(withoutSeed)
  })
})

// ---------------------------------------------------------------------------
// reduceRecords — pure helper exercised directly (future #99 shape)
// ---------------------------------------------------------------------------

describe('aggregate > reduceRecords pure helper', () => {
  it('reduces a plain record array against a spec', () => {
    const result = reduceRecords(SAMPLE, {
      total: sum('amount'),
      n: count(),
    })
    expect(result.total).toBe(7650)
    expect(result.n).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// Live aggregation — reactive terminal
// ---------------------------------------------------------------------------

describe('aggregate > .live() initial state', () => {
  it('computes the initial value eagerly in the constructor', () => {
    const { source } = mutableSource<Invoice>(SAMPLE)
    const live = new Query<Invoice>(source)
      .aggregate({ total: sum('amount'), n: count() })
      .live()
    expect(live.value).toEqual({ total: 7650, n: 5 })
    expect(live.error).toBeUndefined()
    live.stop()
  })

  it('initial value is computed for an empty source', () => {
    const { source } = mutableSource<Invoice>([])
    const live = new Query<Invoice>(source)
      .aggregate({ total: sum('amount'), n: count() })
      .live()
    expect(live.value).toEqual({ total: 0, n: 0 })
    live.stop()
  })
})

describe('aggregate > .live() re-fires on source changes', () => {
  it('re-fires when a record is inserted', () => {
    const src = mutableSource<Invoice>([
      { id: 'a', status: 'open', amount: 100, client: 'A' },
    ])
    const live = new Query<Invoice>(src.source)
      .aggregate({ total: sum('amount'), n: count() })
      .live()
    expect(live.value).toEqual({ total: 100, n: 1 })

    const notifications: Array<{ total: number; n: number }> = []
    live.subscribe(() => {
      if (live.value) notifications.push(live.value)
    })

    src.push({ id: 'b', status: 'open', amount: 200, client: 'B' })
    expect(live.value).toEqual({ total: 300, n: 2 })
    expect(notifications).toHaveLength(1)
    expect(notifications[0]).toEqual({ total: 300, n: 2 })

    src.push({ id: 'c', status: 'open', amount: 50, client: 'C' })
    expect(live.value).toEqual({ total: 350, n: 3 })
    expect(notifications).toHaveLength(2)

    live.stop()
  })

  it('re-fires when a record is removed', () => {
    const src = mutableSource<Invoice>(SAMPLE)
    const live = new Query<Invoice>(src.source)
      .aggregate({ total: sum('amount') })
      .live()
    expect(live.value?.total).toBe(7650)

    src.remove((r) => r.id === 'c') // remove the 5000
    expect(live.value?.total).toBe(2650)

    live.stop()
  })

  it('re-fires when a record is updated', () => {
    const src = mutableSource<Invoice>(SAMPLE)
    const live = new Query<Invoice>(src.source)
      .aggregate({ total: sum('amount') })
      .live()
    expect(live.value?.total).toBe(7650)

    src.update((r) => r.id === 'a', { amount: 100_000 })
    expect(live.value?.total).toBe(7650 - 100 + 100_000)

    live.stop()
  })

  it('tracks min/max across the current extremum being removed (O(N) edge case)', () => {
    const src = mutableSource<Invoice>(SAMPLE)
    const live = new Query<Invoice>(src.source)
      .aggregate({ lo: min('amount'), hi: max('amount') })
      .live()
    expect(live.value).toEqual({ lo: 100, hi: 5000 })

    // Remove the current max (5000) — next max should be 1500
    src.remove((r) => r.id === 'c')
    expect(live.value).toEqual({ lo: 100, hi: 1500 })

    // Remove the current min (100) — next min should be 250
    src.remove((r) => r.id === 'a')
    expect(live.value).toEqual({ lo: 250, hi: 1500 })

    live.stop()
  })
})

describe('aggregate > .live() subscribe / stop semantics', () => {
  it('supports multiple subscribers and notifies each on change', () => {
    const src = mutableSource<Invoice>(SAMPLE)
    const live = new Query<Invoice>(src.source)
      .aggregate({ n: count() })
      .live()

    let aCount = 0
    let bCount = 0
    live.subscribe(() => { aCount++ })
    live.subscribe(() => { bCount++ })

    src.push({ id: 'f', status: 'open', amount: 1, client: 'F' })
    expect(aCount).toBe(1)
    expect(bCount).toBe(1)

    src.push({ id: 'g', status: 'open', amount: 1, client: 'G' })
    expect(aCount).toBe(2)
    expect(bCount).toBe(2)

    live.stop()
  })

  it('individual subscribers can unsubscribe without affecting the others', () => {
    const src = mutableSource<Invoice>(SAMPLE)
    const live = new Query<Invoice>(src.source)
      .aggregate({ n: count() })
      .live()

    let aCount = 0
    let bCount = 0
    const unsubA = live.subscribe(() => { aCount++ })
    live.subscribe(() => { bCount++ })

    src.push({ id: 'f', status: 'open', amount: 1, client: 'F' })
    expect(aCount).toBe(1)
    expect(bCount).toBe(1)

    unsubA()
    src.push({ id: 'g', status: 'open', amount: 1, client: 'G' })
    expect(aCount).toBe(1) // unchanged
    expect(bCount).toBe(2)

    live.stop()
  })

  it('stop() is idempotent and tears down upstream subscriptions', () => {
    const src = mutableSource<Invoice>(SAMPLE)
    const live = new Query<Invoice>(src.source)
      .aggregate({ n: count() })
      .live()
    const snapshot = live.value
    expect(snapshot).toBeDefined()

    live.stop()
    live.stop() // no throw

    // After stop, mutations must NOT re-fire the aggregation.
    const beforeValue = live.value
    src.push({ id: 'f', status: 'open', amount: 1, client: 'F' })
    expect(live.value).toBe(beforeValue)
  })

  it('subscribe() after stop() is a no-op and returns a safe unsubscribe', () => {
    const src = mutableSource<Invoice>(SAMPLE)
    const live = new Query<Invoice>(src.source)
      .aggregate({ n: count() })
      .live()
    live.stop()

    let fired = 0
    const unsub = live.subscribe(() => { fired++ })
    src.push({ id: 'f', status: 'open', amount: 1, client: 'F' })
    expect(fired).toBe(0)
    expect(() => unsub()).not.toThrow()
  })
})

describe('aggregate > .live() without subscribe support', () => {
  it('builds a LiveAggregation with an initial value over a static source', () => {
    // Sources without subscribe (e.g. plain arrays) still get a
    // one-shot initial computation. Calling .live() on them is
    // equivalent to .run() — no re-fires, but the reactive shape is
    // still returned so consumers don't have to branch on source
    // capabilities.
    const live = new Query<Invoice>(staticSource(SAMPLE))
      .aggregate({ total: sum('amount'), n: count() })
      .live()
    expect(live.value).toEqual({ total: 7650, n: 5 })
    expect(live.error).toBeUndefined()
    live.stop()
  })
})
