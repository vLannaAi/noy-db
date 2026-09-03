/**
 * #1341 — the incremental live maintainer against a REAL encrypted
 * Collection, not a hand-rolled source.
 *
 * The decisive assertion is an equivalence property: for a randomised stream
 * of puts and deletes, the maintained `live.value` must equal the value a full
 * `toArray()` re-run produces, at every step, for every supported query shape.
 * Anything weaker ("it emitted something") would pass for a broken patcher.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { createNoydb, type Noydb } from '../src/kernel/noydb.js'
import { memoryStore } from '../src/kernel/memory-store.js'
import { withReduce, sum, count, avg, min, max } from '../src/with-lookup/reduce/index.js'
import { withIndexing } from '../src/with-lookup/indexing/index.js'
import type { Query } from '../src/kernel/query/builder.js'
import type { Collection } from '../src/kernel/collection.js'

interface Item {
  id: string
  status: 'open' | 'paid' | 'void'
  amount: number
  group: number
}

/** Deterministic PRNG — a failure is reproducible from the seed alone. */
function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Shape = (q: Query<Item>) => Query<Item>

const SHAPES: Record<string, Shape> = {
  'unfiltered, unordered': q => q,
  'where': q => q.where('status', '==', 'open'),
  'where + orderBy + limit': q =>
    q.where('status', '!=', 'void').orderBy('amount', 'desc').limit(4),
  'orderBy a tied field + offset + limit': q => q.orderBy('group', 'asc').offset(1).limit(5),
  'compound where, two-key order': q =>
    q.where('amount', '>=', 20).where('status', '!=', 'void').orderBy('group', 'asc').orderBy('amount', 'desc'),
}

describe('#1341 live incremental maintenance — real Collection', () => {
  let db: Noydb
  let items: Collection<Item>

  beforeEach(async () => {
    db = await createNoydb({
      store: memoryStore(),
      user: 'owner',
      secret: 'live-incremental-test-secret-2026',
      reduceStrategy: withReduce(),
    })
    const vault = await db.openVault('TEST')
    items = vault.collection<Item>('items')
    for (let i = 0; i < 10; i++) {
      await items.put(`seed-${i}`, {
        id: `seed-${i}`,
        status: i % 3 === 0 ? 'paid' : 'open',
        amount: (i * 13) % 60,
        group: i % 3,
      })
    }
  })

  for (const [name, shape] of Object.entries(SHAPES)) {
    it(`equals a full re-run at every step — ${name}`, async () => {
      const rnd = mulberry32(0x1341)
      const live = shape(items.query()).live()
      const ids = new Set<string>(Array.from({ length: 10 }, (_, i) => `seed-${i}`))
      let next = 0

      expect(live.value).toEqual(shape(items.query()).toArray())

      for (let step = 0; step < 60; step++) {
        const roll = rnd()
        const statuses: Item['status'][] = ['open', 'paid', 'void']
        if (roll < 0.4 || ids.size === 0) {
          const id = `new-${next++}`
          ids.add(id)
          await items.put(id, {
            id,
            status: statuses[Math.floor(rnd() * 3)]!,
            amount: Math.floor(rnd() * 60),
            group: Math.floor(rnd() * 3),
          })
        } else if (roll < 0.8) {
          const id = [...ids][Math.floor(rnd() * ids.size)]!
          await items.put(id, {
            id,
            status: statuses[Math.floor(rnd() * 3)]!,
            amount: Math.floor(rnd() * 60),
            group: Math.floor(rnd() * 3),
          })
        } else {
          const id = [...ids][Math.floor(rnd() * ids.size)]!
          ids.delete(id)
          await items.delete(id)
        }
        expect(live.value).toEqual(shape(items.query()).toArray())
      }
      live.stop()
    })
  }

  it('a re-added id sorts where a fresh insert would among ties', async () => {
    // The tie-break is the record's slot in the cache Map. Deleting and
    // re-adding an id appends it, so it must move to the END of its tie group.
    const live = items.query().where('group', '==', 9).orderBy('group', 'asc').live()
    for (const id of ['t1', 't2', 't3']) {
      await items.put(id, { id, status: 'open', amount: 1, group: 9 })
    }
    expect(live.value.map(r => r.id)).toEqual(['t1', 't2', 't3'])

    await items.delete('t1')
    await items.put('t1', { id: 't1', status: 'open', amount: 1, group: 9 })
    expect(live.value.map(r => r.id)).toEqual(['t2', 't3', 't1'])
    expect(live.value).toEqual(items.query().where('group', '==', 9).orderBy('group', 'asc').toArray())
    live.stop()
  })

  it('an updated record keeps its cache slot among ties', async () => {
    const live = items.query().where('group', '==', 8).orderBy('group', 'asc').live()
    for (const id of ['u1', 'u2', 'u3']) {
      await items.put(id, { id, status: 'open', amount: 1, group: 8 })
    }
    await items.put('u1', { id: 'u1', status: 'paid', amount: 99, group: 8 })
    expect(live.value.map(r => r.id)).toEqual(['u1', 'u2', 'u3'])
    expect(live.value).toEqual(items.query().where('group', '==', 8).orderBy('group', 'asc').toArray())
    live.stop()
  })

  it('batched mode reaches the same value, one microtask later', async () => {
    const live = items.query().where('status', '==', 'open').orderBy('amount', 'asc').live({ batch: true })
    let notifications = 0
    live.subscribe(() => { notifications++ })

    await items.putMany([
      ['b1', { id: 'b1', status: 'open', amount: 5, group: 0 }],
      ['b2', { id: 'b2', status: 'open', amount: 6, group: 0 }],
      ['b3', { id: 'b3', status: 'paid', amount: 7, group: 0 }],
    ])
    await Promise.resolve()

    expect(live.value).toEqual(items.query().where('status', '==', 'open').orderBy('amount', 'asc').toArray())
    expect(notifications).toBeGreaterThan(0)
    // NOT asserting a coalesced count here, deliberately: every hub write path
    // awaits between records (`putMany` loops over an awaited `put`), so each
    // change event lands in its own turn and there is nothing to coalesce.
    // Batching pays off for an emitter that fires several events in ONE turn —
    // that case is measured in `query-incremental.test.ts`.
    live.stop()
  })

  it('.aggregate().live() equals a full re-run at every step', async () => {
    const rnd = mulberry32(0x1341a)
    const spec = {
      n: count(),
      total: sum('amount'),
      mean: avg('amount'),
      lo: min('amount'),
      hi: max('amount'),
    }
    const build = (): Query<Item> => items.query().where('status', '!=', 'void')
    const live = build().aggregate(spec).live()
    const ids = new Set<string>(Array.from({ length: 10 }, (_, i) => `seed-${i}`))
    let next = 0
    const statuses: Item['status'][] = ['open', 'paid', 'void']

    expect(live.value).toEqual(build().aggregate(spec).run())

    for (let step = 0; step < 60; step++) {
      const roll = rnd()
      if (roll < 0.45 || ids.size === 0) {
        const id = `agg-${next++}`
        ids.add(id)
        await items.put(id, {
          id,
          status: statuses[Math.floor(rnd() * 3)]!,
          amount: Math.floor(rnd() * 60),
          group: Math.floor(rnd() * 3),
        })
      } else if (roll < 0.8) {
        const id = [...ids][Math.floor(rnd() * ids.size)]!
        await items.put(id, {
          id,
          status: statuses[Math.floor(rnd() * 3)]!,
          amount: Math.floor(rnd() * 60),
          group: Math.floor(rnd() * 3),
        })
      } else {
        const id = [...ids][Math.floor(rnd() * ids.size)]!
        ids.delete(id)
        await items.delete(id)
      }
      expect(live.value).toEqual(build().aggregate(spec).run())
    }
    live.stop()
  })

  it('an indexed plan is refused and still returns the right rows', async () => {
    const vault = await db.openVault('IDX')
    const indexed = vault.collection<Item>('indexed', { indexes: ['status'] })
    await indexed.put('i1', { id: 'i1', status: 'open', amount: 1, group: 0 })
    const live = indexed.query().where('status', '==', 'open').live()
    await indexed.put('i2', { id: 'i2', status: 'open', amount: 2, group: 0 })
    await indexed.put('i1', { id: 'i1', status: 'paid', amount: 1, group: 0 })
    expect(live.value).toEqual(indexed.query().where('status', '==', 'open').toArray())
    live.stop()
  })
})

/**
 * #1344 landed two ways for rows to reach the pipeline in INDEX order rather
 * than snapshot order: `lookupRange` off a sorted index, and
 * `orderedIndexRows()` serving `orderBy(f).limit(n)` as an index page. The
 * maintainer's tie-break is snapshot sequence, which is the wrong answer for
 * both — so both must fall back. These are the shapes that would expose it:
 * every one of them sorts on a LOW-CARDINALITY field, so ties are everywhere
 * and an index-ordered page and a cache-ordered one can actually disagree.
 */
describe('#1341 x #1344 — sorted-index plans fall back', () => {
  let db: Noydb
  let indexed: Collection<Item>

  beforeEach(async () => {
    db = await createNoydb({
      store: memoryStore(),
      user: 'owner',
      secret: 'live-incremental-sorted-secret-2026',
      indexingStrategy: withIndexing(),
    })
    const vault = await db.openVault('TEST')
    indexed = vault.collection<Item>('indexed', {
      indexes: [{ fields: ['group'], kind: 'sorted' }, { fields: ['amount'], kind: 'sorted' }],
    })
    for (let i = 0; i < 10; i++) {
      await indexed.put(`seed-${i}`, {
        id: `seed-${i}`,
        status: i % 3 === 0 ? 'paid' : 'open',
        amount: (i * 13) % 60,
        group: i % 3,
      })
    }
  })

  const INDEX_SHAPES: Record<string, Shape> = {
    // orderedIndexRows(): no clauses, one orderBy on a sorted field, a limit.
    'ordered index page over a tied field': q => q.orderBy('group', 'asc').limit(4),
    'ordered index page, desc': q => q.orderBy('group', 'desc').limit(6),
    // lookupRange(): a range clause on a sorted field.
    'sorted-index range clause': q => q.where('amount', '>=', 20).orderBy('group', 'asc'),
    'sorted-index range clause + limit': q => q.where('group', '<', 2).orderBy('amount', 'asc').limit(3),
  }

  for (const [name, shape] of Object.entries(INDEX_SHAPES)) {
    it(`equals a full re-run at every step — ${name}`, async () => {
      const rnd = mulberry32(0x1344)
      const live = shape(indexed.query()).live()
      const ids = new Set<string>(Array.from({ length: 10 }, (_, i) => `seed-${i}`))
      let next = 0
      const statuses: Item['status'][] = ['open', 'paid', 'void']

      expect(live.value).toEqual(shape(indexed.query()).toArray())

      for (let step = 0; step < 40; step++) {
        const roll = rnd()
        if (roll < 0.45 || ids.size === 0) {
          const id = `idx-${next++}`
          ids.add(id)
          await indexed.put(id, {
            id,
            status: statuses[Math.floor(rnd() * 3)]!,
            amount: Math.floor(rnd() * 60),
            group: Math.floor(rnd() * 3),
          })
        } else if (roll < 0.8) {
          const id = [...ids][Math.floor(rnd() * ids.size)]!
          await indexed.put(id, {
            id,
            status: statuses[Math.floor(rnd() * 3)]!,
            amount: Math.floor(rnd() * 60),
            group: Math.floor(rnd() * 3),
          })
        } else {
          const id = [...ids][Math.floor(rnd() * ids.size)]!
          ids.delete(id)
          await indexed.delete(id)
        }
        expect(live.value).toEqual(shape(indexed.query()).toArray())
      }
      live.stop()
    })
  }
})
