/**
 * #1341, grouped half — per-group incremental maintenance for
 * `groupBy().aggregate().live()`.
 *
 * The decisive assertion is an equivalence property: for a randomised stream
 * of puts, deletes and GROUP-KEY CHANGES, the maintained `live.value` must
 * equal what `.run()` produces, at every step, for every supported grouping
 * shape. Anything weaker ("it emitted something") would pass for a broken
 * patcher — and so would an equality check against hand-written expectations,
 * which only ever catches a wrong expectation.
 *
 * The second thing every test here does is assert WHICH PATH RAN, via
 * `live.maintenanceStats()`. A fallback that quietly re-ran everything would
 * satisfy the equivalence property while delivering nothing, so correctness
 * alone is not evidence that this feature exists.
 */

import { describe, it, expect } from 'vitest'
import { Query, type QuerySource } from '../src/kernel/query/builder.js'
import { dateTrunc } from '../src/kernel/query/date-trunc.js'
import { withReduce, count, sum, avg, min, max } from '../src/with-lookup/reduce/index.js'
import { GroupedMaintainer } from '../src/with-lookup/reduce/index.js'
import { createNoydb, type Noydb } from '../src/kernel/noydb.js'
import { memoryStore } from '../src/kernel/memory-store.js'
import type { Collection } from '../src/kernel/collection.js'

interface Row {
  id: string
  status: 'open' | 'paid' | 'void'
  client: string
  region: string
  amount: number
  at: string
}

/**
 * A `Map`-backed source with the same ordering semantics as Collection's eager
 * cache — set-on-existing keeps its slot, a new key appends — plus counters
 * for the two full-scan entry points, so a test can prove a change was patched
 * rather than re-scanned.
 */
function makeSource(rows: Row[]): {
  source: QuerySource<Row>
  put(row: Row): void
  remove(id: string): void
  ping(): void
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
    /** A notification that cannot say WHICH record moved — the rebuild path. */
    ping() {
      for (const cb of listeners) cb()
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

const q = (source: QuerySource<Row>): Query<Row> =>
  new Query<Row>(source, undefined, undefined, withReduce())

const SPEC = { n: count(), total: sum('amount'), mean: avg('amount'), lo: min('amount'), hi: max('amount') }

/** Every grouping shape the property below is run against. */
const SHAPES: Record<string, (query: Query<Row>) => any> = {
  'single key': query => query.groupBy('client').aggregate(SPEC),
  'single key + where': query => query.where('status', '!=', 'void').groupBy('client').aggregate(SPEC),
  'two keys': query => query.groupBy('client', 'region').aggregate(SPEC),
  'key that is often null/undefined': query => query.groupBy('region').aggregate(SPEC),
  'post-group having + orderBy + limit': query =>
    query.groupBy('client').aggregate(SPEC).having((r: any) => (r.n as number) > 1).orderBy('total', 'desc').limit(3),
  'derived calendar key': query =>
    query.groupBy(dateTrunc('at', 'month', { timeZone: 'UTC' })).aggregate({ n: count(), total: sum('amount') }),
}

const CLIENTS = ['c1', 'c2', 'c3', 'c4']
const REGIONS: (string | null | undefined)[] = ['north', 'south', null, undefined]
const STATUSES: Row['status'][] = ['open', 'paid', 'void']

function seedRows(n: number): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `r${i}`,
    status: STATUSES[i % 3]!,
    client: CLIENTS[i % CLIENTS.length]!,
    region: REGIONS[i % REGIONS.length] as string,
    amount: (i * 17) % 90,
    at: `2026-0${(i % 3) + 1}-1${i % 9}T00:00:00.000Z`,
  }))
}

describe('#1341 grouped incremental maintenance — equivalence with a full re-run', () => {
  for (const [name, shape] of Object.entries(SHAPES)) {
    it(`holds for "${name}" across a randomised mutation stream`, () => {
      const rnd = mulberry32(0x1341c0)
      const rows = seedRows(16)
      const { source, put, remove } = makeSource(rows)
      const live = shape(q(source)).live()
      const ids = new Set(rows.map(r => r.id))
      let nextId = rows.length

      expect(live.value).toEqual(shape(q(source)).run())

      let keyChanges = 0
      let deletes = 0
      let plainUpdates = 0

      for (let step = 0; step < 200; step++) {
        const roll = rnd()
        if (roll < 0.3 || ids.size === 0) {
          // insert
          const id = `r${nextId++}`
          ids.add(id)
          put({
            id,
            status: STATUSES[Math.floor(rnd() * 3)]!,
            client: CLIENTS[Math.floor(rnd() * CLIENTS.length)]!,
            region: REGIONS[Math.floor(rnd() * REGIONS.length)] as string,
            amount: Math.floor(rnd() * 90),
            at: `2026-0${Math.floor(rnd() * 3) + 1}-15T00:00:00.000Z`,
          })
        } else if (roll < 0.6) {
          // update that CHANGES the group key
          const id = [...ids][Math.floor(rnd() * ids.size)]!
          keyChanges++
          put({
            id,
            status: STATUSES[Math.floor(rnd() * 3)]!,
            client: CLIENTS[Math.floor(rnd() * CLIENTS.length)]!,
            region: REGIONS[Math.floor(rnd() * REGIONS.length)] as string,
            amount: Math.floor(rnd() * 90),
            at: `2026-0${Math.floor(rnd() * 3) + 1}-15T00:00:00.000Z`,
          })
        } else if (roll < 0.85) {
          // update that does NOT change the group key — only the reduced field
          const id = [...ids][Math.floor(rnd() * ids.size)]!
          const current = (source.snapshotEntries!() as { id: string; record: Row }[]).find(e => e.id === id)
          if (!current) continue
          plainUpdates++
          put({ ...current.record, amount: Math.floor(rnd() * 90) })
        } else {
          const id = [...ids][Math.floor(rnd() * ids.size)]!
          ids.delete(id)
          deletes++
          remove(id)
        }
        expect(live.value).toEqual(shape(q(source)).run())
      }

      // The stream actually exercised all three transition kinds.
      expect(keyChanges).toBeGreaterThan(10)
      expect(plainUpdates).toBeGreaterThan(10)
      expect(deletes).toBeGreaterThan(10)
      // ...and it did so on the INCREMENTAL path, not by re-running.
      const stats = live.maintenanceStats()
      expect(stats).toBeDefined()
      expect(stats!.patches).toBeGreaterThan(150)
      expect(stats!.rebuilds).toBe(1) // the one eager rebuild before attach
      live.stop()
    })
  }
})

describe('#1341 grouped incremental maintenance — the three membership transitions', () => {
  const spec = { n: count(), total: sum('amount') }
  const row = (id: string, client: string, amount: number): Row => ({
    id, client, amount, status: 'open', region: 'north', at: '2026-01-01T00:00:00.000Z',
  })

  it('a record whose group KEY changes leaves one group and joins another', () => {
    const { source, put } = makeSource([row('a', 'c1', 10), row('b', 'c2', 20)])
    const build = (): any => q(source).groupBy('client').aggregate(spec)
    const live = build().live()
    expect(live.value).toEqual([
      { client: 'c1', n: 1, total: 10 },
      { client: 'c2', n: 1, total: 20 },
    ])

    put(row('a', 'c2', 10))

    // c1 is GONE (it lost its only row) and c2 carries both.
    expect(live.value).toEqual([{ client: 'c2', n: 2, total: 30 }])
    expect(live.value).toEqual(build().run())
    // ...and no ghost row survived in the old bucket, which is the failure a
    // patch that reads the key off the AFTER state alone produces.
    expect((live.value as any[]).some(r => r.client === 'c1')).toBe(false)
    expect(live.maintenanceStats()!.rebuilds).toBe(1)
    live.stop()
  })

  it('a group that loses its last row DISAPPEARS from the result', () => {
    const { source, remove } = makeSource([row('a', 'c1', 10), row('b', 'c2', 20), row('c', 'c2', 5)])
    const build = (): any => q(source).groupBy('client').aggregate(spec)
    const live = build().live()
    expect((live.value as any[]).map(r => r.client)).toEqual(['c1', 'c2'])

    remove('a')
    expect(live.value).toEqual([{ client: 'c2', n: 2, total: 25 }])
    expect(live.value).toEqual(build().run())

    remove('b')
    remove('c')
    // An empty bucket left in place would emit a row `.run()` never produces.
    expect(live.value).toEqual([])
    expect(live.value).toEqual(build().run())
    expect(live.maintenanceStats()!.rebuilds).toBe(1)
    live.stop()
  })

  it('a group that gains its first row APPEARS — in first-seen order, not last', () => {
    // ⭐ The case a naive patch gets wrong. Records sit at sequence 0 (c1) and
    // 1 (c2). Rewriting sequence 0's key to c3 must emit [c3, c2]: bucket order
    // is each bucket's MINIMUM sequence, not the order buckets were created in.
    const { source, put } = makeSource([row('a', 'c1', 10), row('b', 'c2', 20)])
    const build = (): any => q(source).groupBy('client').aggregate(spec)
    const live = build().live()
    expect((live.value as any[]).map(r => r.client)).toEqual(['c1', 'c2'])

    put(row('a', 'c3', 10))
    expect((live.value as any[]).map(r => r.client)).toEqual(['c3', 'c2'])
    expect(live.value).toEqual(build().run())

    // A genuinely new record appends, so its new group is emitted last.
    put(row('z', 'c4', 1))
    expect((live.value as any[]).map(r => r.client)).toEqual(['c3', 'c2', 'c4'])
    expect(live.value).toEqual(build().run())
    expect(live.maintenanceStats()!.rebuilds).toBe(1)
    live.stop()
  })

  it('losing a bucket\'s first-seen record re-reads the key value AND the position', () => {
    // Two records land in one bucket under keys that canonicalise the same but
    // are not identical objects; the emitted key comes from the first-seen one,
    // so removing it must re-read from the new first member.
    const { source, remove, put } = makeSource([
      row('a', 'c1', 10),
      row('b', 'c2', 20),
      row('c', 'c1', 30),
    ])
    const build = (): any => q(source).groupBy('client').aggregate(spec)
    const live = build().live()
    expect((live.value as any[]).map(r => r.client)).toEqual(['c1', 'c2'])

    remove('a')
    // c1's minimum sequence is now record `c` (seq 2), behind c2 (seq 1).
    expect((live.value as any[]).map(r => r.client)).toEqual(['c2', 'c1'])
    expect(live.value).toEqual(build().run())

    put(row('d', 'c1', 1))
    expect(live.value).toEqual(build().run())
    live.stop()
  })
})

describe('#1341 grouped incremental maintenance — the fallback is observable', () => {
  const spec = { n: count(), total: sum('amount') }
  const row = (id: string, client: string, amount: number): Row => ({
    id, client, amount, status: 'open', region: 'north', at: '2026-01-01T00:00:00.000Z',
  })

  it('does not re-scan the source on a change it can patch', () => {
    const { source, put, remove, scans } = makeSource([row('a', 'c1', 10), row('b', 'c2', 20)])
    const live = q(source).groupBy('client').aggregate(spec).live()
    const afterSubscribe = scans()

    put(row('c', 'c1', 5))
    put(row('a', 'c2', 10))
    remove('b')

    // Read the scan counter BEFORE the reference `.run()` — that call scans by
    // design, and checking after it would measure the assertion, not the query.
    // The whole point: three changes, zero full scans.
    expect(scans()).toBe(afterSubscribe)
    expect(live.value).toEqual(q(source).groupBy('client').aggregate(spec).run())
    expect(live.maintenanceStats()).toEqual({
      patches: 3,
      rebuilds: 1,
      bucketsReduced: expect.any(Number),
      recordsFolded: expect.any(Number),
    })
    live.stop()
  })

  it('reduces only the buckets a change touched', () => {
    const rows = Array.from({ length: 40 }, (_, i) => row(`r${i}`, `c${i % 8}`, i))
    const { source, put } = makeSource(rows)
    const live = q(source).groupBy('client').aggregate(spec).live()
    const afterFirstRead = live.maintenanceStats()!
    expect(afterFirstRead.bucketsReduced).toBe(8) // the eager first pass

    put(row('r0', 'c0', 999)) // stays in its own bucket
    expect(live.maintenanceStats()!.bucketsReduced).toBe(9) // ...one more, not nine

    put(row('r1', 'c7', 5)) // c1 → c7: exactly two buckets dirty
    expect(live.maintenanceStats()!.bucketsReduced).toBe(11)
    expect(live.value).toEqual(q(source).groupBy('client').aggregate(spec).run())
    live.stop()
  })

  it('reports NO maintainer for a plan the whitelist refuses, and is still right', () => {
    const { source, put, remove, scans } = makeSource([row('a', 'c1', 10), row('b', 'c2', 20)])
    // `.filter(fn)` is an arbitrary consumer closure — refused by design.
    const build = (): any => q(source).filter(r => r.amount > 1).groupBy('client').aggregate(spec)
    const live = build().live()
    expect(live.maintenanceStats()).toBeUndefined()
    const afterSubscribe = scans()

    put(row('c', 'c3', 7))
    remove('a')
    expect(live.value).toEqual(build().run())
    // The refusal is real: a refused plan DOES re-scan.
    expect(scans()).toBeGreaterThan(afterSubscribe)
    live.stop()
  })

  it('rebuilds — visibly — when the notification carries no delta', () => {
    const { source, put, ping } = makeSource([row('a', 'c1', 10)])
    const live = q(source).groupBy('client').aggregate(spec).live()
    expect(live.maintenanceStats()!.rebuilds).toBe(1)

    put(row('b', 'c2', 20))
    expect(live.maintenanceStats()!.rebuilds).toBe(1)
    expect(live.maintenanceStats()!.patches).toBe(1)

    ping()
    expect(live.maintenanceStats()!.rebuilds).toBe(2)
    expect(live.value).toEqual(q(source).groupBy('client').aggregate(spec).run())
    live.stop()
  })

  it('stops maintaining after stop(), and .run() is never served maintained state', () => {
    const { source, put } = makeSource([row('a', 'c1', 10)])
    const reduction = q(source).groupBy('client').aggregate(spec)
    const live = reduction.live()
    live.stop()
    put(row('b', 'c2', 20))
    expect(reduction.run()).toEqual([
      { client: 'c1', n: 1, total: 10 },
      { client: 'c2', n: 1, total: 20 },
    ])
  })

  it('a reducer that throws mid-patch drops the maintained state instead of half-serving it', () => {
    const { source, put } = makeSource([row('a', 'c1', 10)])
    let armed = false
    const exploding = {
      init: () => 0,
      step: (state: number) => {
        if (armed) throw new Error('boom')
        return state + 1
      },
      finalize: (state: number) => state,
    }
    const live = q(source).groupBy('client').aggregate({ n: exploding } as any).live()
    expect(live.value).toEqual([{ client: 'c1', n: 1 }])
    armed = true
    put(row('b', 'c2', 20))
    // The error is surfaced, the last good value is preserved, and nothing
    // half-patched is emitted.
    expect(live.error).toBeInstanceOf(Error)
    expect(live.value).toEqual([{ client: 'c1', n: 1 }])
    armed = false
    put(row('c', 'c3', 5))
    expect(live.value).toEqual(q(source).groupBy('client').aggregate({ n: exploding } as any).run())
    live.stop()
  })
})

describe('#1341 grouped incremental maintenance — real Collection', () => {
  it('equals a full re-run at every step, over encrypted records', async () => {
    interface Item { id: string; client: string; amount: number; status: 'open' | 'paid' | 'void' }
    const db: Noydb = await createNoydb({
      store: memoryStore(),
      user: 'owner',
      secret: 'grouped-live-incremental-secret-2026',
      reduceStrategy: withReduce(),
    })
    const vault = await db.openVault('TEST')
    const items: Collection<Item> = vault.collection<Item>('items')
    for (let i = 0; i < 12; i++) {
      await items.put(`seed-${i}`, {
        id: `seed-${i}`,
        client: `c${i % 4}`,
        amount: (i * 13) % 60,
        status: (['open', 'paid', 'void'] as const)[i % 3]!,
      })
    }
    const spec = { n: count(), total: sum('amount'), lo: min('amount'), hi: max('amount') }
    const build = (): any => items.query().where('status', '!=', 'void').groupBy('client').aggregate(spec)
    const live = build().live()
    expect(live.value).toEqual(build().run())

    const rnd = mulberry32(0x1341d)
    const ids = new Set(Array.from({ length: 12 }, (_, i) => `seed-${i}`))
    let next = 0
    for (let step = 0; step < 60; step++) {
      const roll = rnd()
      if (roll < 0.4 || ids.size === 0) {
        const id = `g-${next++}`
        ids.add(id)
        await items.put(id, {
          id,
          client: `c${Math.floor(rnd() * 5)}`,
          amount: Math.floor(rnd() * 60),
          status: (['open', 'paid', 'void'] as const)[Math.floor(rnd() * 3)]!,
        })
      } else if (roll < 0.8) {
        const id = [...ids][Math.floor(rnd() * ids.size)]!
        await items.put(id, {
          id,
          client: `c${Math.floor(rnd() * 5)}`,
          amount: Math.floor(rnd() * 60),
          status: (['open', 'paid', 'void'] as const)[Math.floor(rnd() * 3)]!,
        })
      } else {
        const id = [...ids][Math.floor(rnd() * ids.size)]!
        ids.delete(id)
        await items.delete(id)
      }
      expect(live.value).toEqual(build().run())
    }
    expect(live.maintenanceStats()!.patches).toBeGreaterThan(50)
    expect(live.maintenanceStats()!.rebuilds).toBe(1)
    live.stop()
  })
})

describe('#1341 GroupedMaintainer — driven directly', () => {
  it('rebuild and patch agree, whichever order the same edits arrive in', () => {
    const cache = new Map<string, Row>()
    const source = {
      snapshotEntries: () => [...cache.entries()].map(([id, record]) => ({ id, record })),
      lookupById: (id: string) => cache.get(id),
      matches: (record: unknown) => (record as Row).status !== 'void',
    }
    const spec = { n: count(), total: sum('amount') }
    const patched = new GroupedMaintainer({ source, fields: ['client'], spec })
    // Read once, then attach — the lifecycle `LiveReduction` drives, and the
    // one the maintainer documents: attaching without a read in the same turn
    // leaves it stale, so the first delta would be answered by a rebuild.
    patched.rows()
    patched.attach()

    const rnd = mulberry32(0x51de)
    for (let i = 0; i < 300; i++) {
      const id = `r${Math.floor(rnd() * 25)}`
      if (rnd() < 0.25) {
        cache.delete(id)
        patched.apply({ id, action: 'delete' })
      } else {
        cache.set(id, {
          id,
          client: `c${Math.floor(rnd() * 6)}`,
          region: 'north',
          amount: Math.floor(rnd() * 40),
          status: (['open', 'paid', 'void'] as const)[Math.floor(rnd() * 3)]!,
          at: '2026-01-01T00:00:00.000Z',
        })
        patched.apply({ id, action: 'put' })
      }
      // A maintainer that has seen nothing but this snapshot is the oracle.
      const fresh = new GroupedMaintainer({ source, fields: ['client'], spec })
      expect(patched.rows()).toEqual(fresh.rows())
    }
    expect(patched.stats().patches).toBe(300)
    expect(patched.stats().rebuilds).toBe(1)
  })
})
