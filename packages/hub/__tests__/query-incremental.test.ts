/**
 * #1341 — the delta maintainer, exercised through `Query.live()` over a
 * hand-rolled source so the test can COUNT what the live query touches.
 *
 * The equivalence property (maintained value === full re-run value, at every
 * step, for a randomised mutation stream) lives here too, at the unit level;
 * `query-incremental-collection.test.ts` runs the same property against a real
 * encrypted Collection.
 */

import { describe, it, expect } from 'vitest'
import { Query, type QuerySource } from '../src/kernel/query/builder.js'
import { canMaintainIncrementally } from '../src/kernel/query/incremental.js'
import { withReduce, count, sum } from '../src/with-lookup/reduce/index.js'

interface Row {
  id: string
  status: 'open' | 'paid'
  amount: number
  group: number
}

/**
 * A `Map`-backed source with the same ordering semantics as Collection's
 * eager cache — set-on-existing keeps its slot, a new key appends — plus
 * counters for the two full-scan entry points.
 */
function makeSource(rows: Row[]): {
  source: QuerySource<Row>
  put(row: Row): void
  remove(id: string): void
  scans: () => number
} {
  const cache = new Map<string, Row>(rows.map(r => [r.id, r]))
  const listeners = new Set<(change?: { id: string; action: 'put' | 'delete' }) => void>()
  let scans = 0
  const source: QuerySource<Row> = {
    snapshot: () => {
      scans++
      return [...cache.values()]
    },
    snapshotEntries: () => {
      scans++
      return [...cache.entries()].map(([id, record]) => ({ id, record }))
    },
    lookupById: (id: string) => cache.get(id),
    subscribe: cb => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }
  return {
    source,
    put(row) {
      cache.set(row.id, row)
      for (const cb of listeners) cb({ id: row.id, action: 'put' })
    },
    remove(id) {
      cache.delete(id)
      for (const cb of listeners) cb({ id, action: 'delete' })
    },
    scans: () => scans,
  }
}

/** Deterministic PRNG so a failure is reproducible from the seed alone. */
function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const SHAPES: Record<string, (q: Query<Row>) => Query<Row>> = {
  'no predicate, no order': q => q,
  'where only': q => q.where('status', '==', 'open'),
  'where + order + limit': q =>
    q.where('status', '==', 'open').orderBy('amount', 'desc').limit(5),
  'order on a tied field + offset + limit': q =>
    q.orderBy('group', 'asc').offset(2).limit(6),
  'two-key order': q => q.orderBy('group', 'desc').orderBy('amount', 'asc'),
  'order + where, unbounded': q => q.where('amount', '>', 40).orderBy('amount', 'asc'),
}

describe('#1341 incremental live maintenance', () => {
  describe('equivalence with a full re-run', () => {
    for (const [name, shape] of Object.entries(SHAPES)) {
      it(`holds for "${name}" across a randomised mutation stream`, () => {
        const rnd = mulberry32(0xc0ffee)
        const seedRows: Row[] = Array.from({ length: 12 }, (_, i) => ({
          id: `r${i}`,
          status: i % 3 === 0 ? 'paid' : 'open',
          amount: (i * 17) % 90,
          group: i % 3,
        }))
        const { source, put, remove } = makeSource(seedRows)
        const live = shape(new Query<Row>(source)).live()
        const ids = new Set(seedRows.map(r => r.id))
        let nextId = seedRows.length

        expect(live.value).toEqual(shape(new Query<Row>(source)).toArray())

        for (let step = 0; step < 200; step++) {
          const roll = rnd()
          if (roll < 0.35 || ids.size === 0) {
            const id = `r${nextId++}`
            ids.add(id)
            put({
              id,
              status: rnd() < 0.5 ? 'open' : 'paid',
              amount: Math.floor(rnd() * 100),
              group: Math.floor(rnd() * 3),
            })
          } else if (roll < 0.8) {
            const id = [...ids][Math.floor(rnd() * ids.size)]!
            put({
              id,
              status: rnd() < 0.5 ? 'open' : 'paid',
              amount: Math.floor(rnd() * 100),
              group: Math.floor(rnd() * 3),
            })
          } else {
            const id = [...ids][Math.floor(rnd() * ids.size)]!
            ids.delete(id)
            remove(id)
          }
          expect(live.value).toEqual(shape(new Query<Row>(source)).toArray())
        }
        live.stop()
      })
    }
  })

  /**
   * The maintainer's correctness argument rests on ONE property of the order
   * key plan it borrows from `sortRecords` (#1346): `compareOrderKeys` returns
   * 0 for equal sort keys and resolves nothing further, leaving ties to the
   * caller — the stable sort's input order eagerly, snapshot sequence here.
   *
   * If that comparator ever started breaking ties itself (by id, say, which is
   * what the keyset cursor does one level up in `page()`), the two paths would
   * silently disagree wherever sort keys repeat. This test fails in that case:
   * the expected order is INSERTION order, and an id tiebreak would return
   * these three rows sorted the other way regardless of how they went in.
   */
  it('inherits an order key plan that leaves equal keys to the tiebreak', () => {
    const tied = (id: string): Row => ({ id, status: 'open', amount: 7, group: 1 })
    const { source, put } = makeSource([])
    const shape = (q: Query<Row>): Query<Row> => q.orderBy('group', 'asc')
    const live = shape(new Query<Row>(source)).live()

    // Ids descend while insertion ascends, so snapshot order and id order are
    // opposites and only one of them can be the answer.
    for (const id of ['z', 'm', 'a']) put(tied(id))

    expect(shape(new Query<Row>(source)).toArray().map(r => r.id)).toEqual(['z', 'm', 'a'])
    expect(live.value.map(r => r.id)).toEqual(['z', 'm', 'a'])
    live.stop()
  })

  it('does not re-scan the source on a change it can patch', () => {
    const { source, put, scans } = makeSource([
      { id: 'a', status: 'open', amount: 10, group: 0 },
      { id: 'b', status: 'paid', amount: 20, group: 1 },
    ])
    const live = new Query<Row>(source).where('status', '==', 'open').orderBy('amount', 'asc').live()
    const afterSubscribe = scans()

    put({ id: 'c', status: 'open', amount: 5, group: 0 })
    put({ id: 'd', status: 'open', amount: 30, group: 2 })
    put({ id: 'b', status: 'open', amount: 20, group: 1 })

    expect(live.value.map(r => r.id)).toEqual(['c', 'a', 'b', 'd'])
    // The whole point: three changes, zero full scans.
    expect(scans()).toBe(afterSubscribe)
    live.stop()
  })

  it('re-runs in full when the notification carries no delta', () => {
    const cache = new Map<string, Row>([['a', { id: 'a', status: 'open', amount: 1, group: 0 }]])
    let notify: (() => void) | undefined
    const source: QuerySource<Row> = {
      snapshot: () => [...cache.values()],
      snapshotEntries: () => [...cache.entries()].map(([id, record]) => ({ id, record })),
      lookupById: id => cache.get(id),
      subscribe: cb => {
        notify = () => cb()
        return () => {}
      },
    }
    const live = new Query<Row>(source).live()
    cache.set('b', { id: 'b', status: 'open', amount: 2, group: 0 })
    notify!()
    expect(live.value.map(r => r.id)).toEqual(['a', 'b'])
    live.stop()
  })

  describe('batching', () => {
    it('coalesces a burst into one notification and one value', async () => {
      const { source, put } = makeSource([{ id: 'a', status: 'open', amount: 1, group: 0 }])
      const live = new Query<Row>(source).orderBy('amount', 'asc').live({ batch: true })
      let notifications = 0
      live.subscribe(() => { notifications++ })

      put({ id: 'b', status: 'open', amount: 2, group: 0 })
      put({ id: 'c', status: 'open', amount: 3, group: 0 })
      put({ id: 'd', status: 'open', amount: 4, group: 0 })
      expect(notifications).toBe(0)

      await Promise.resolve()
      expect(notifications).toBe(1)
      expect(live.value.map(r => r.id)).toEqual(['a', 'b', 'c', 'd'])
      live.stop()
    })

    it('is off by default — one notification per change', () => {
      const { source, put } = makeSource([{ id: 'a', status: 'open', amount: 1, group: 0 }])
      const live = new Query<Row>(source).live()
      let notifications = 0
      live.subscribe(() => { notifications++ })
      put({ id: 'b', status: 'open', amount: 2, group: 0 })
      put({ id: 'c', status: 'open', amount: 3, group: 0 })
      expect(notifications).toBe(2)
      live.stop()
    })
  })

  describe('canMaintainIncrementally — the fallback whitelist', () => {
    const base = { clauses: [], orderBy: [], limit: undefined, joins: [] }
    /** Every field carries a hash index; `sortedFields` also carry a sorted one. */
    const probe = (sortedFields: string[] = []): { covers: (f: string) => boolean; sorted: (f: string) => boolean } => ({
      covers: () => true,
      sorted: f => sortedFields.includes(f),
    })

    it('admits a plain filtered + ordered plan', () => {
      expect(canMaintainIncrementally(base, null)).toBe(true)
      expect(
        canMaintainIncrementally(
          { ...base, clauses: [{ type: 'field', field: 'a', op: '==', value: 1 }] },
          null,
        ),
      ).toBe(true)
      // An UNindexed range clause is fine — nothing serves it off an index.
      expect(
        canMaintainIncrementally(
          { ...base, clauses: [{ type: 'field', field: 'a', op: '>', value: 1 }] },
          null,
        ),
      ).toBe(true)
    })

    it('refuses joins, .filter(fn) and label-sort', () => {
      expect(canMaintainIncrementally({ ...base, joins: [{}] }, null)).toBe(false)
      expect(
        canMaintainIncrementally({ ...base, clauses: [{ type: 'filter', fn: () => true }] }, null),
      ).toBe(false)
      expect(
        canMaintainIncrementally(
          {
            ...base,
            clauses: [{ type: 'group', op: 'and', clauses: [{ type: 'filter', fn: () => true }] }],
          },
          null,
        ),
      ).toBe(false)
      expect(
        canMaintainIncrementally(
          { ...base, orderBy: [{ field: 'code', direction: 'asc', by: 'label' }] },
          null,
        ),
      ).toBe(false)
    })

    it('refuses every index-driven shape, including the two #1344 added', () => {
      // 1. `==` / `in` off a hash index (the original case).
      expect(
        canMaintainIncrementally(
          { ...base, clauses: [{ type: 'field', field: 'a', op: '==', value: 1 }] },
          probe(),
        ),
      ).toBe(false)
      // 2. #1344 `lookupRange` — a range clause on a SORTED-indexed field.
      const rangeOps = ['<', '<=', '>', '>=', 'between', 'startsWith'] as const
      for (const op of rangeOps) {
        expect(
          canMaintainIncrementally(
            { ...base, clauses: [{ type: 'field', field: 'a', op, value: 1 }] },
            probe(['a']),
          ),
        ).toBe(false)
      }
      // ...but on a hash-only field `lookupRange` returns null and the plan
      // scans in snapshot order, so that range clause stays maintainable.
      expect(
        canMaintainIncrementally(
          { ...base, clauses: [{ type: 'field', field: 'a', op: '>', value: 1 }] },
          { covers: () => true, sorted: () => false },
        ),
      ).toBe(true)
      // 3. #1344 `orderedIndexRows` — orderBy(f).limit(n) served straight off
      //    the sorted index, in the index's tie order rather than the cache's.
      expect(
        canMaintainIncrementally(
          { ...base, orderBy: [{ field: 'amount', direction: 'asc' }], limit: 10 },
          probe(['amount']),
        ),
      ).toBe(false)
      // Same shape without a limit never reaches that path.
      expect(
        canMaintainIncrementally(
          { ...base, orderBy: [{ field: 'amount', direction: 'asc' }] },
          probe(['amount']),
        ),
      ).toBe(true)
      // ...and with a where clause it takes the scan path, not the ordered page.
      expect(
        canMaintainIncrementally(
          {
            ...base,
            clauses: [{ type: 'field', field: 'other', op: 'contains', value: 'x' }],
            orderBy: [{ field: 'amount', direction: 'asc' }],
            limit: 10,
          },
          probe(['amount']),
        ),
      ).toBe(true)
    })
  })

  describe('.aggregate().live()', () => {
    const spec = { n: count(), total: sum('amount') }

    it('folds over a maintained match set instead of re-scanning', () => {
      const { source, put, remove, scans } = makeSource([
        { id: 'a', status: 'open', amount: 10, group: 0 },
        { id: 'b', status: 'paid', amount: 20, group: 1 },
      ])
      const live = new Query<Row>(source, undefined, undefined, withReduce())
        .where('status', '==', 'open')
        .aggregate(spec)
        .live()
      const afterSubscribe = scans()

      put({ id: 'c', status: 'open', amount: 5, group: 0 })
      expect(live.value).toEqual({ n: 2, total: 15 })
      put({ id: 'a', status: 'paid', amount: 10, group: 0 })
      expect(live.value).toEqual({ n: 1, total: 5 })
      remove('c')
      expect(live.value).toEqual({ n: 0, total: 0 })

      expect(scans()).toBe(afterSubscribe)
      live.stop()
    })

    it('.run() after .live().stop() is not served stale maintained state', () => {
      const { source, put } = makeSource([{ id: 'a', status: 'open', amount: 10, group: 0 }])
      const reduction = new Query<Row>(source, undefined, undefined, withReduce())
        .where('status', '==', 'open')
        .aggregate(spec)
      const live = reduction.live()
      live.stop()
      // Nothing is feeding deltas any more, so the maintained set must not be
      // trusted — this read has to go back to the snapshot.
      put({ id: 'b', status: 'open', amount: 4, group: 0 })
      expect(reduction.run()).toEqual({ n: 2, total: 14 })
    })

    it('still re-runs in full for a plan the whitelist refuses', () => {
      const { source, put } = makeSource([{ id: 'a', status: 'open', amount: 10, group: 0 }])
      const live = new Query<Row>(source, undefined, undefined, withReduce())
        .filter(r => r.amount > 1)
        .aggregate(spec)
        .live()
      put({ id: 'b', status: 'open', amount: 4, group: 0 })
      expect(live.value).toEqual({ n: 2, total: 14 })
      live.stop()
    })
  })

  it('a refused plan still produces the right answer, by full re-run', () => {
    const { source, put, remove } = makeSource([
      { id: 'a', status: 'open', amount: 10, group: 0 },
      { id: 'b', status: 'paid', amount: 20, group: 1 },
    ])
    // `.filter(fn)` is refused by the whitelist — this exercises the fallback.
    const shape = (q: Query<Row>): Query<Row> => q.filter(r => r.amount > 5).orderBy('amount', 'asc')
    const live = shape(new Query<Row>(source)).live()
    put({ id: 'c', status: 'open', amount: 1, group: 0 })
    expect(live.value).toEqual(shape(new Query<Row>(source)).toArray())
    remove('a')
    expect(live.value).toEqual(shape(new Query<Row>(source)).toArray())
    live.stop()
  })
})
