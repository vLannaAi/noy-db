/**
 * #1339 — `.joinOn(target, { on })`: declared non-equi and composite joins.
 *
 * ⭐ THE DECLARED FORM IS THE WHOLE POINT. `.crossJoin({ on: fn })` already
 * pairs arbitrary rows; what it cannot do is fold into `queryHash`, because a
 * closure has no serialization. Every test below that asserts rows has a
 * sibling asserting the SAME predicate survives `toPlan()` and
 * `summarizeQueryPlan()` — if the `on` cannot be serialised deterministically,
 * this is `crossJoin` with extra steps.
 */
import { describe, it, expect } from 'vitest'
import { Query } from '../src/kernel/query/index.js'
import type { QuerySource } from '../src/kernel/query/index.js'
import type { JoinContext, JoinableSource } from '../src/kernel/query/relate/join.js'
import { summarizeQueryPlan } from '../src/with-formula/materialized-views/dependency-analyzer.js'
import { JoinTooLargeError } from '../src/kernel/errors.js'
// #1458 — the query DSL ships in four groups; these side-effect imports
// attach the extension methods this file exercises. A consumer on the root
// barrel needs none of them (it imports all three); this file builds its
// Query from `kernel/query` directly, so it takes what it uses.
import '../src/kernel/query/relate/index.js'

interface Entry {
  id: string
  clientId: string
  year: number
  date: string
  hours: number
}

interface Rate {
  id: string
  clientId: string
  year: number
  from: string
  to: string
  rate: number
}

const ENTRIES: Entry[] = [
  { id: 'e1', clientId: 'c1', year: 2026, date: '2026-03-10', hours: 3 },
  { id: 'e2', clientId: 'c1', year: 2025, date: '2025-07-01', hours: 5 },
  { id: 'e3', clientId: 'c2', year: 2026, date: '2026-01-05', hours: 2 },
  { id: 'e4', clientId: 'c9', year: 2026, date: '2026-06-30', hours: 1 },
]

const RATES: Rate[] = [
  { id: 'r1', clientId: 'c1', year: 2026, from: '2026-01-01', to: '2026-06-30', rate: 100 },
  { id: 'r2', clientId: 'c1', year: 2025, from: '2025-01-01', to: '2025-12-31', rate: 90 },
  { id: 'r3', clientId: 'c2', year: 2026, from: '2026-01-01', to: '2026-12-31', rate: 120 },
  { id: 'r4', clientId: 'c1', year: 2026, from: '2026-03-01', to: '2026-03-31', rate: 150 },
]

function plainSource<T>(records: T[]): QuerySource<T> {
  return { snapshot: () => records }
}

/** A right side that counts the RECORDS the join read out of the snapshot. */
function witnessRates(records: Rate[] = RATES) {
  let reads = 0
  const proxied = new Proxy(records, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && /^\d+$/.test(prop)) reads++
      return Reflect.get(target, prop, receiver) as unknown
    },
  })
  const source: JoinableSource = {
    snapshot: () => proxied,
    lookupById: (id: string) => records.find(r => r.id === id),
  }
  return { source, reset: () => { reads = 0 }, reads: () => reads }
}

function ctxFor(right: JoinableSource): JoinContext {
  return {
    leftCollection: 'entries',
    resolveRef: () => null,
    resolveSource: (name: string) => (name === 'rates' ? right : null),
  }
}

function q(right?: JoinableSource): Query<Entry> {
  return new Query<Entry>(plainSource(ENTRIES), undefined, ctxFor(right ?? witnessRates().source))
}

describe('#1339 > composite equality — hash join over a tuple key', () => {
  it('matches on every declared pair, and emits one row per match', () => {
    const rows = q()
      .joinOn<'rate', Rate>('rates', { as: 'rate', on: [['clientId', 'clientId'], ['year', 'year']] })
      .toArray() as Array<Entry & { rate: Rate | null }>

    // e1 (c1/2026) matches r1 AND r4 → two rows.
    expect(rows.filter(r => r.id === 'e1').map(r => r.rate?.id).sort()).toEqual(['r1', 'r4'])
    expect(rows.filter(r => r.id === 'e2').map(r => r.rate?.id)).toEqual(['r2'])
    expect(rows.filter(r => r.id === 'e3').map(r => r.rate?.id)).toEqual(['r3'])
    // e4 (c9) matches nothing — LEFT outer by default, so the row survives.
    expect(rows.filter(r => r.id === 'e4').map(r => r.rate)).toEqual([null])
  })

  it('is kind-partitioned per component: the string "2026" never matches the number 2026', () => {
    const stringYear: Entry[] = [{ id: 's1', clientId: 'c1', year: '2026' as unknown as number, date: 'x', hours: 0 }]
    const rows = new Query<Entry>(plainSource(stringYear), undefined, ctxFor(witnessRates().source))
      .joinOn<'rate', Rate>('rates', { as: 'rate', on: [['clientId', 'clientId'], ['year', 'year']] })
      .toArray() as Array<Entry & { rate: Rate | null }>
    expect(rows.map(r => r.rate)).toEqual([null])
  })

  it('mode: "inner" drops the unmatched left row', () => {
    const rows = q()
      .joinOn<'rate', Rate>('rates', {
        as: 'rate',
        mode: 'inner',
        on: [['clientId', 'clientId'], ['year', 'year']],
      })
      .toArray() as Array<Entry & { rate: Rate }>
    expect(rows.map(r => r.id).sort()).toEqual(['e1', 'e1', 'e2', 'e3'])
  })

  it('walks the right snapshot ONCE, not once per left row — the executor-side witness', () => {
    const w = witnessRates()
    const query = new Query<Entry>(plainSource(ENTRIES), undefined, ctxFor(w.source)).joinOn('rates', {
      as: 'rate',
      on: [['clientId', 'clientId'], ['year', 'year']],
    })
    w.reset()
    query.toArray()
    // One build pass over the 4 right records. An O(n·m) theta join would
    // read 4 left × 4 right = 16.
    expect(w.reads()).toBe(RATES.length)
  })
})

describe('#1339 > range join — nested loop over a sorted right side', () => {
  it('between: the left date falls inside the right interval', () => {
    const rows = q()
      .joinOn<'rate', Rate>('rates', {
        as: 'rate',
        on: { left: 'date', op: 'between', right: ['from', 'to'] },
      })
      .toArray() as Array<Entry & { rate: Rate | null }>

    // e1 2026-03-10 ∈ r1 [01-01..06-30], r3 [2026-01-01..12-31] and r4
    // [03-01..03-31]. r3 belongs to another client — a range `on` constrains
    // ONLY what it names, which is exactly the property that makes it a theta
    // join rather than a filtered equi-join.
    expect(rows.filter(r => r.id === 'e1').map(r => r.rate?.id).sort()).toEqual(['r1', 'r3', 'r4'])
    // e2 2025-07-01 ∈ r2 only
    expect(rows.filter(r => r.id === 'e2').map(r => r.rate?.id)).toEqual(['r2'])
    // e3 2026-01-05 ∈ r1 and r3
    expect(rows.filter(r => r.id === 'e3').map(r => r.rate?.id).sort()).toEqual(['r1', 'r3'])
    // e4 2026-06-30 ∈ r1 (inclusive upper bound) and r3
    expect(rows.filter(r => r.id === 'e4').map(r => r.rate?.id).sort()).toEqual(['r1', 'r3'])
  })

  it('a scalar comparison serves a contiguous slice', () => {
    const rows = q()
      .joinOn<'rate', Rate>('rates', { as: 'rate', on: { left: 'hours', op: '>', right: 'rate' } })
      .toArray() as Array<Entry & { rate: Rate | null }>
    // No entry has more hours than any rate → every row is unmatched.
    expect(rows.every(r => r.rate === null)).toBe(true)

    const rows2 = q()
      .joinOn<'rate', Rate>('rates', { as: 'rate', on: { left: 'hours', op: '<', right: 'rate' } })
      .toArray() as Array<Entry & { rate: Rate | null }>
    expect(rows2.filter(r => r.id === 'e1')).toHaveLength(RATES.length)
  })

  it('a left row matching nothing keeps its row with a null alias', () => {
    const rows = q()
      .joinOn<'rate', Rate>('rates', {
        as: 'rate',
        on: { left: 'date', op: 'between', right: ['from', 'to'] },
      })
      .toArray() as Array<Entry & { rate: Rate | null }>
    const noMatch = new Query<Entry>(
      plainSource([{ id: 'z', clientId: 'c1', year: 2030, date: '2030-01-01', hours: 1 }]),
      undefined,
      ctxFor(witnessRates().source),
    )
      .joinOn<'rate', Rate>('rates', {
        as: 'rate',
        on: { left: 'date', op: 'between', right: ['from', 'to'] },
      })
      .toArray() as Array<Entry & { rate: Rate | null }>
    expect(noMatch.map(r => r.rate)).toEqual([null])
    expect(rows.length).toBeGreaterThan(0)
  })

  it('sorts the right side once — the snapshot is walked once, not per left row', () => {
    const w = witnessRates()
    const query = new Query<Entry>(plainSource(ENTRIES), undefined, ctxFor(w.source)).joinOn('rates', {
      as: 'rate',
      on: { left: 'date', op: 'between', right: ['from', 'to'] },
    })
    w.reset()
    query.toArray()
    expect(w.reads()).toBe(RATES.length)
  })
})

describe('#1339 > the ceilings still apply', () => {
  it('an unbounded theta join throws JoinTooLargeError on the OUTPUT, not a hang', () => {
    const many: Entry[] = Array.from({ length: 40 }, (_, i) => ({
      id: `x${i}`, clientId: 'c1', year: 2026, date: '2026-03-10', hours: 1,
    }))
    const rates: Rate[] = Array.from({ length: 40 }, (_, i) => ({
      id: `y${i}`, clientId: 'c1', year: 2026, from: '2026-01-01', to: '2026-12-31', rate: 1,
    }))
    const query = new Query<Entry>(plainSource(many), undefined, ctxFor(witnessRates(rates).source)).joinOn(
      'rates',
      { as: 'rate', maxRows: 100, on: { left: 'date', op: 'between', right: ['from', 'to'] } },
    )
    expect(() => query.toArray()).toThrow(JoinTooLargeError)
  })
})

describe('#1339 > plan-time validation of the declared `on`', () => {
  it('refuses an empty composite pair list', () => {
    expect(() => q().joinOn('rates', { as: 'rate', on: [] })).toThrow(/at least one/i)
  })

  it('refuses a malformed pair', () => {
    expect(() =>
      q().joinOn('rates', { as: 'rate', on: [['clientId'] as unknown as [string, string]] }),
    ).toThrow(/\[leftField, rightField\]/)
  })

  it('refuses an unknown operator', () => {
    expect(() =>
      q().joinOn('rates', { as: 'rate', on: { left: 'date', op: '~' as never, right: 'from' } }),
    ).toThrow(/operator/i)
  })

  it('refuses `between` whose right side is not a two-field tuple', () => {
    expect(() =>
      q().joinOn('rates', { as: 'rate', on: { left: 'date', op: 'between', right: 'from' as never } }),
    ).toThrow(/two/i)
  })

  it('refuses a joinOn with no join context', () => {
    expect(() =>
      new Query<Entry>(plainSource(ENTRIES)).joinOn('rates', { as: 'rate', on: [['clientId', 'clientId']] }),
    ).toThrow(/join context/)
  })
})

// ── the reason this issue exists ────────────────────────────────────────────

describe('#1339 > the declared `on` folds into queryHash', () => {
  /** `summarizeQueryPlan` is the exact string `computeQueryHash` consumes. */
  function summary(build: (base: Query<Entry>) => Query<unknown>): string {
    return summarizeQueryPlan(build(q()) as Query<Record<string, unknown>>)
  }

  it('two joinOn plans differing ONLY in the `on` produce different summaries', () => {
    const a = summary(base => base.joinOn('rates', { as: 'rate', on: [['clientId', 'clientId']] }))
    const b = summary(base => base.joinOn('rates', { as: 'rate', on: [['clientId', 'clientId'], ['year', 'year']] }))
    expect(a).not.toBe(b)
  })

  it('an equality `on` and a range `on` over the same fields differ', () => {
    const a = summary(base => base.joinOn('rates', { as: 'rate', on: [['date', 'from']] }))
    const b = summary(base => base.joinOn('rates', { as: 'rate', on: { left: 'date', op: '>=', right: 'from' } }))
    expect(a).not.toBe(b)
  })

  it('the same `on` written twice produces the SAME summary — deterministic, not identity-based', () => {
    const a = summary(base => base.joinOn('rates', { as: 'rate', on: { left: 'date', op: 'between', right: ['from', 'to'] } }))
    const b = summary(base => base.joinOn('rates', { as: 'rate', on: { left: 'date', op: 'between', right: ['from', 'to'] } }))
    expect(a).toBe(b)
  })

  it('composite pairs are normalised, so declaration order does not change the hash', () => {
    const a = summary(base => base.joinOn('rates', { as: 'rate', on: [['clientId', 'clientId'], ['year', 'year']] }))
    const b = summary(base => base.joinOn('rates', { as: 'rate', on: [['year', 'year'], ['clientId', 'clientId']] }))
    expect(a).toBe(b)
  })

  it('a plan carrying NO joinOn leg summarises byte-identically to before #1339', () => {
    // The regression that would move every stored MV hash: `on` must be
    // OMITTED at its default, never written as null/undefined-with-a-key.
    const plain = summarizeQueryPlan(q().where('year', '==', 2026) as unknown as Query<Record<string, unknown>>)
    expect(plain).not.toContain('"on"')
  })

  it('`toPlan()` carries the normalised `on` verbatim', () => {
    const plan = q().joinOn('rates', { as: 'rate', on: { left: 'date', op: 'between', right: ['from', 'to'] } }).toPlan() as {
      joins: Array<{ on?: unknown; target: string; as: string }>
    }
    expect(plan.joins[0]!.target).toBe('rates')
    expect(plan.joins[0]!.on).toEqual({ kind: 'range', left: 'date', op: 'between', right: ['from', 'to'] })
  })

  it('the join target is a materialized-view dependency, same as a ref join', async () => {
    const { analyzeDependencies } = await import('../src/with-formula/materialized-views/dependency-analyzer.js')
    const deps = analyzeDependencies(
      q().joinOn('rates', { as: 'rate', on: [['clientId', 'clientId']] }) as unknown as Query<Record<string, unknown>>,
    )
    expect([...deps].sort()).toEqual(['entries', 'rates'])
  })
})

describe('#1339 > explain()', () => {
  it('labels the composite hash join and counts both sides against the cap', () => {
    const e = q()
      .joinOn('rates', { as: 'rate', on: [['clientId', 'clientId'], ['year', 'year']] })
      .explain()
    const join = e.nodes.find(n => n.op === 'join')!
    expect(join.dispatch).toBe('join:composite-hash')
    expect(join.detail).toContain('clientId = clientId')
    expect(join.notes.join(' ')).toContain('right side 4 rows')
    expect(e.caps.some(c => c.name === 'join:rate:right')).toBe(true)
  })

  it('labels the range join and says the right side is sorted', () => {
    const e = q()
      .joinOn('rates', { as: 'rate', on: { left: 'date', op: 'between', right: ['from', 'to'] } })
      .explain()
    const join = e.nodes.find(n => n.op === 'join')!
    expect(join.dispatch).toBe('join:sorted-range')
    expect(join.detail).toContain('date between')
    expect(join.notes.join(' ')).toContain('sorted')
  })

  it('says the row count is no longer a pass-through', () => {
    const e = q()
      .joinOn('rates', { as: 'rate', on: [['clientId', 'clientId']] })
      .explain()
    const join = e.nodes.find(n => n.op === 'join')!
    expect(join.notes.join(' ')).toMatch(/many-to-many|upper bound/i)
  })
})
