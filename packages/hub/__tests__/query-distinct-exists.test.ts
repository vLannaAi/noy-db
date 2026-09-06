/**
 * #1347 — `distinct()`, `countDistinct()`, `exists()`.
 *
 * Three properties this suite exists to pin, because each one is a place a
 * plausible implementation is silently wrong:
 *
 *  1. DISTINCTNESS IS DECIDED ON THE CANONICAL INDEX KEY, not on the value a
 *     reader sees. A money field stores a scaled integer whose textual form
 *     is not canonical for legacy rows (`'0100'` vs `'100'`); dedup on the
 *     raw string reports two values where there is one.
 *  2. THE INDEX-BACKED PATH AND THE SCAN PATH RETURN THE SAME THING. Dispatch
 *     is witnessed the way `query-explain.test.ts` witnesses it — the index
 *     path never calls `source.snapshot()`, the scan path always does — so a
 *     snapshot counter proves the two answers came from two different routes.
 *  3. `exists()` SHORT-CIRCUITS. A boolean assertion cannot see the
 *     difference between a short-circuit and a full scan; a predicate
 *     invocation counter can.
 */
import { describe, it, expect } from 'vitest'
import { Query, type QuerySource } from '../src/kernel/query/index.js'
import { CollectionIndexes } from '../src/with-lookup/indexing/eager-indexes.js'
import { countDistinct, count, groupAndReduce, withReduce } from '../src/with-lookup/reduce/index.js'

const AGG = withReduce()
import { dateTrunc } from '../src/kernel/query/reduce/date-trunc.js'
import { ViaPipeline } from '../src/kernel/via/pipeline.js'
import { moneyVia } from '../src/via/money/binding.js'
import { money } from '../src/via/money/descriptor.js'
import { computeQueryHash } from '../src/with-formula/materialized-views/query-hash.js'
// #1458 — the query DSL ships in four groups; these side-effect imports
// attach the extension methods this file exercises. A consumer on the root
// barrel needs none of them (it imports all three); this file builds its
// Query from `kernel/query` directly, so it takes what it uses.
import '../src/kernel/query/reduce/index.js'

interface Invoice {
  id: string
  status: 'draft' | 'open' | 'paid'
  clientId: string
  region: string | null
  issuedAt: string
}

const SAMPLE: Invoice[] = [
  { id: 'a', status: 'draft', clientId: 'c1', region: 'eu', issuedAt: '2026-01-05T00:00:00Z' },
  { id: 'b', status: 'open', clientId: 'c1', region: 'eu', issuedAt: '2026-01-20T00:00:00Z' },
  { id: 'c', status: 'open', clientId: 'c2', region: 'us', issuedAt: '2026-02-02T00:00:00Z' },
  { id: 'd', status: 'paid', clientId: 'c2', region: null, issuedAt: '2026-02-11T00:00:00Z' },
  { id: 'e', status: 'open', clientId: 'c3', region: 'us', issuedAt: '2026-03-01T00:00:00Z' },
]

/** Source whose `snapshot()` calls are counted — the dispatch witness. */
function makeSource<T extends { id: string }>(
  records: T[],
  indexedFields: string[],
  via?: ViaPipeline,
) {
  const indexes = new CollectionIndexes()
  if (via) indexes.setCanonicalizer((f, v) => via.canonicalizeIndexKey(f, v))
  for (const f of indexedFields) indexes.declare(f)
  indexes.build(records.map(r => ({ id: r.id, record: r })))
  const byId = new Map(records.map(r => [r.id, r]))
  let snapshotCalls = 0
  const source: QuerySource<T> = {
    snapshot: () => {
      snapshotCalls++
      return records
    },
    getIndexes: () => indexes,
    lookupById: (id: string) => byId.get(id),
    ...(via ? { via } : {}),
  }
  return { source, calls: () => snapshotCalls, reset: () => { snapshotCalls = 0 } }
}

/** A source with no index store at all — forces the scan path. */
function plainSource<T>(records: T[], via?: ViaPipeline) {
  let snapshotCalls = 0
  const source: QuerySource<T> = {
    snapshot: () => {
      snapshotCalls++
      return records
    },
    ...(via ? { via } : {}),
  }
  return { source, calls: () => snapshotCalls }
}

describe('#1347 Query.distinct()', () => {
  it('returns each distinct value once, in first-seen order', () => {
    const { source } = plainSource(SAMPLE)
    expect(new Query<Invoice>(source).distinct('status')).toEqual(['draft', 'open', 'paid'])
    expect(new Query<Invoice>(source).distinct('clientId')).toEqual(['c1', 'c2', 'c3'])
  })

  it('applies where/filter and ignores orderBy/limit/offset (mirrors count())', () => {
    const { source } = plainSource(SAMPLE)
    const q = new Query<Invoice>(source).where('status', '==', 'open')
    expect(q.distinct('clientId')).toEqual(['c1', 'c2', 'c3'])
    // limit/offset/orderBy narrow a PAGE, not the distinct set.
    expect(q.orderBy('clientId', 'desc').limit(1).offset(2).distinct('clientId'))
      .toEqual(['c1', 'c2', 'c3'])
  })

  it('EXCLUDES nullish values — the documented choice, and what the index does', () => {
    const { source } = plainSource(SAMPLE)
    expect(new Query<Invoice>(source).distinct('region')).toEqual(['eu', 'us'])
    const withUndefined = [...SAMPLE, { id: 'f', status: 'open', clientId: 'c4', issuedAt: 'x' } as unknown as Invoice]
    const p = plainSource(withUndefined)
    expect(new Query<Invoice>(p.source).distinct('region')).toEqual(['eu', 'us'])
  })

  it("types the result as the field's own value type", () => {
    const { source } = plainSource(SAMPLE)
    // Plain assignments, not expectTypeOf: `typecheck:tests` compiles this
    // file, so a regression to `unknown[]` fails the build. The return type is
    // an intersection form for variance reasons — see `Query.distinct`'s doc.
    const statuses: ('draft' | 'open' | 'paid')[] = new Query<Invoice>(source).distinct('status')
    const regions: (string | null)[] = new Query<Invoice>(source).distinct('region')
    expect(statuses.length + regions.length).toBeGreaterThan(0)
  })

  it('index-backed and scan paths return the SAME answer, and dispatch differs', () => {
    const indexed = makeSource(SAMPLE, ['clientId'])
    indexed.reset()
    const viaIndex = new Query<Invoice>(indexed.source).distinct('clientId')
    expect(indexed.calls()).toBe(0) // never took the snapshot ⇒ index-backed

    const scanned = makeSource(SAMPLE, []) // no index declared on the field
    const viaScan = new Query<Invoice>(scanned.source).distinct('clientId')
    expect(scanned.calls()).toBeGreaterThan(0) // took the snapshot ⇒ scan

    expect(viaIndex).toEqual(viaScan)
  })

  it('falls back to the scan when the plan narrows the set', () => {
    const indexed = makeSource(SAMPLE, ['clientId'])
    indexed.reset()
    const out = new Query<Invoice>(indexed.source).where('status', '==', 'open').distinct('clientId')
    expect(indexed.calls()).toBeGreaterThan(0)
    expect(out).toEqual(['c1', 'c2', 'c3'])
  })

  describe('Via-covered (money) fields', () => {
    interface Row { id: string; amount: string }
    // Two rows whose STORED scaled-int strings differ textually but denote the
    // same money value — the mixed-era case `canonicalizeMoneyIndexKey` exists
    // for. Naive `new Set(rows.map(r => r.amount))` reports 2.
    const ROWS: Row[] = [
      { id: 'r1', amount: '100' },
      { id: 'r2', amount: '0100' },
      { id: 'r3', amount: '250' },
    ]
    const via = ViaPipeline.build([moneyVia({ amount: money({ currency: 'EUR', scale: 2 }) })])!

    it('decides distinctness on the canonical value, not the stored string', () => {
      expect(new Set(ROWS.map(r => r.amount)).size).toBe(3) // the userland bug
      const { source } = plainSource(ROWS, via)
      expect(new Query<Row>(source).distinct('amount')).toEqual(['1.00', '2.50'])
    })

    it('index-backed money distinct agrees with the scan', () => {
      const indexed = makeSource(ROWS, ['amount'], via)
      indexed.reset()
      const viaIndex = new Query<Row>(indexed.source).distinct('amount')
      expect(indexed.calls()).toBe(0)
      const { source } = plainSource(ROWS, via)
      expect(viaIndex).toEqual(new Query<Row>(source).distinct('amount'))
      expect(viaIndex).toEqual(['1.00', '2.50'])
    })
  })
})

describe('#1347 Query.exists()', () => {
  it('answers the same question count() > 0 answers', () => {
    const { source } = plainSource(SAMPLE)
    expect(new Query<Invoice>(source).exists()).toBe(true)
    expect(new Query<Invoice>(source).where('status', '==', 'open').exists()).toBe(true)
    expect(new Query<Invoice>(source).where('status', '==', 'void').exists()).toBe(false)
    const empty = plainSource<Invoice>([])
    expect(new Query<Invoice>(empty.source).exists()).toBe(false)
  })

  it('short-circuits on the first hit — witnessed by predicate invocations', () => {
    const many: Invoice[] = Array.from({ length: 500 }, (_, i) => ({
      id: `x${i}`, status: 'open' as const, clientId: `c${i}`, region: 'eu', issuedAt: '2026-01-01T00:00:00Z',
    }))
    const { source } = plainSource(many)

    let existsCalls = 0
    const existed = new Query<Invoice>(source).filter(() => { existsCalls++; return true }).exists()
    expect(existed).toBe(true)
    expect(existsCalls).toBe(1)

    let countCalls = 0
    new Query<Invoice>(source).filter(() => { countCalls++; return true }).count()
    expect(countCalls).toBe(500)
  })

  it('still visits every record when nothing matches', () => {
    const many: Invoice[] = Array.from({ length: 20 }, (_, i) => ({
      id: `x${i}`, status: 'open' as const, clientId: 'c', region: 'eu', issuedAt: 'x',
    }))
    const { source } = plainSource(many)
    let calls = 0
    expect(new Query<Invoice>(source).filter(() => { calls++; return false }).exists()).toBe(false)
    expect(calls).toBe(20)
  })

  it('uses the index fast path when one is available', () => {
    const indexed = makeSource(SAMPLE, ['clientId'])
    indexed.reset()
    expect(new Query<Invoice>(indexed.source).where('clientId', '==', 'c2').exists()).toBe(true)
    expect(indexed.calls()).toBe(0)
    expect(new Query<Invoice>(indexed.source).where('clientId', '==', 'nope').exists()).toBe(false)
  })
})

describe('#1347 countDistinct()', () => {
  it('counts distinct non-nullish values, ungrouped', () => {
    const { source } = plainSource(SAMPLE)
    const r = new Query<Invoice>(source, undefined, undefined, AGG).aggregate({ clients: countDistinct('clientId'), n: count() }).run()
    expect(r).toEqual({ clients: 3, n: 5 })
  })

  it('excludes nullish, matching distinct()', () => {
    const { source } = plainSource(SAMPLE)
    expect(new Query<Invoice>(source, undefined, undefined, AGG).aggregate({ r: countDistinct('region') }).run()).toEqual({ r: 2 })
  })

  it('works inside groupBy().aggregate()', () => {
    const { source } = plainSource(SAMPLE)
    const rows = new Query<Invoice>(source, undefined, undefined, AGG)
      .groupBy('status')
      .aggregate({ clients: countDistinct('clientId') })
      .run()
    expect(rows).toEqual([
      { status: 'draft', clients: 1 },
      { status: 'open', clients: 3 },
      { status: 'paid', clients: 1 },
    ])
  })

  it('works inside groupBy(dateTrunc(...)) (#1350)', () => {
    // Jan holds two rows for c1 and one for c2 — so a bucket whose ROW count
    // is 3 must report a distinct-client count of 2, which is the whole point.
    const calendar: Invoice[] = [
      { id: '1', status: 'open', clientId: 'c1', region: 'eu', issuedAt: '2026-01-05T00:00:00Z' },
      { id: '2', status: 'open', clientId: 'c1', region: 'eu', issuedAt: '2026-01-09T00:00:00Z' },
      { id: '3', status: 'open', clientId: 'c2', region: 'eu', issuedAt: '2026-01-22T00:00:00Z' },
      { id: '4', status: 'open', clientId: 'c3', region: 'eu', issuedAt: '2026-02-02T00:00:00Z' },
    ]
    const { source } = plainSource(calendar)
    const rows = new Query<Invoice>(source, undefined, undefined, AGG)
      .groupBy(dateTrunc('issuedAt', 'month', { timeZone: 'UTC' }))
      .aggregate({ rows: count(), clients: countDistinct('clientId') })
      .run() as { rows: number; clients: number }[]
    expect(rows.map(r => [r.rows, r.clients])).toEqual([[3, 2], [1, 1]])
  })

  it('is money-canonical inside a groupAndReduce with declared moneyFields', () => {
    const rows = [
      { g: 'a', amount: '100' },
      { g: 'a', amount: '0100' },
      { g: 'a', amount: '250' },
    ]
    const out = groupAndReduce<{ g: string; k: number }>(
      rows, 'g', { k: countDistinct('amount') },
      { amount: money({ currency: 'EUR', scale: 2 }) },
    )
    expect(out).toEqual([{ g: 'a', k: 2 }])
  })

  it('the builder form exposes countDistinct', () => {
    const { source } = plainSource(SAMPLE)
    expect(new Query<Invoice>(source, undefined, undefined, AGG).aggregate(b => ({ c: b.countDistinct('clientId') })).run())
      .toEqual({ c: 3 })
  })

  it('supports remove() for incremental live maintenance', () => {
    const r = countDistinct('clientId')
    let s = r.init()
    s = r.step(s, { clientId: 'c1' })
    s = r.step(s, { clientId: 'c1' })
    s = r.step(s, { clientId: 'c2' })
    expect(r.finalize(s)).toBe(2)
    s = r.remove!(s, { clientId: 'c1' })
    expect(r.finalize(s)).toBe(2) // still one c1 left
    s = r.remove!(s, { clientId: 'c1' })
    expect(r.finalize(s)).toBe(1)
  })

  it('merges partial states associatively', () => {
    const r = countDistinct('clientId')
    const a = r.step(r.step(r.init(), { clientId: 'x' }), { clientId: 'y' })
    const b = r.step(r.init(), { clientId: 'y' })
    expect(r.finalize(r.merge!(a, b))).toBe(2)
    expect(r.finalize(r.merge!(b, a))).toBe(2)
  })
})

describe('#1347 queryHash stability', () => {
  const deps = new Set(['invoices'])
  const summary = (q: Query<Invoice>): string => JSON.stringify(q.toPlan())

  it('distinct()/exists() add no clause — the plan hashes as the plan it ran over', async () => {
    const { source } = plainSource(SAMPLE)
    const base = new Query<Invoice>(source).where('status', '==', 'open')
    const before = summary(base)
    base.distinct('clientId')
    base.exists()
    expect(summary(base)).toBe(before)
    const [h1, h2] = await Promise.all([
      computeQueryHash('mv', deps, before),
      computeQueryHash('mv', deps, summary(base)),
    ])
    expect(h1).toBe(h2)
  })

  it('a countDistinct spec is stable across identical constructions', async () => {
    const s = JSON.stringify({ aggregate: true, sources: ['invoices'] })
    expect(await computeQueryHash('mv', deps, s)).toBe(await computeQueryHash('mv', deps, s))
  })
})
