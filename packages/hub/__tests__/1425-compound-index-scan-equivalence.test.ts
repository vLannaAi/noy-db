/**
 * #1425 — #1415's defect, one dispatch over: the compound index and the
 * scan must answer the same query identically.
 *
 * `compoundCandidates()` served an equality prefix from the tuple index and
 * DROPPED the consumed clauses from `remainingClauses`, so nothing re-checked
 * the operands against the stored values. `compoundOrderedRows()` is worse
 * still: it returns already-limited rows that nothing filters at all.
 *
 * ⚠️ NARROWER THAN #1415, AND THE NARROWNESS IS THE TRAP. Compound keys are
 * type-tagged, so none of #1415's string↔number↔boolean coercion reaches
 * here. The single leak is **Date object identity** — two `Date`s at the same
 * instant encode to the same tuple key and are not `===`. A fixture that does
 * not carry a `Date` field therefore passes while proving nothing, which is
 * exactly the vacuity #1415's header warns about.
 *
 * ⛔ THE DE-VACUUMING GUARD IS A TEST IN ITS OWN RIGHT (last block): it
 * recomputes the collision independently of the code under test and requires
 * a colliding stored row for every disagreeing case. Drop the bait row and
 * that guard fails rather than the table quietly going green.
 */
import { describe, it, expect } from 'vitest'
import { Query, type QuerySource } from '../src/kernel/query/index.js'
import { CollectionIndexes } from '../src/with-lookup/indexing/eager-indexes.js'

const D1 = new Date('2026-04-01T00:00:00.000Z')
const D2 = new Date('2026-05-01T00:00:00.000Z')
/** Equal instant, DIFFERENT object — the whole defect in one value. */
const D1_TWIN = new Date(D1.getTime())

interface Row {
  id: string
  d: Date
  k: string
  n: number
}

/**
 * De-vacuumed: rows 'a' and 'c' store `d: D1`, so probing with `D1_TWIN`
 * produces a tuple hit that `===` rejects. Rows differing only in `k` give
 * the ordered path something to page through.
 */
const ROWS: Row[] = [
  { id: 'a', d: D1, k: 'x', n: 1 },
  { id: 'b', d: D2, k: 'x', n: 2 },
  { id: 'c', d: D1, k: 'y', n: 3 },
  { id: 'e', d: D2, k: 'y', n: 4 },
  { id: 'f', d: D1, k: 'z', n: 5 },
]

const TUPLES: ReadonlyArray<readonly string[]> = [
  ['d', 'k'],
  ['k', 'n'],
]

function indexedSource(records: Row[]): QuerySource<Row> {
  const indexes = new CollectionIndexes()
  for (const f of ['d', 'k', 'n'] as const) {
    indexes.declare(f)
    indexes.declareSorted(f)
  }
  for (const t of TUPLES) indexes.declareCompound(t)
  indexes.build(records.map(r => ({ id: r.id, record: r })))
  const byId = new Map(records.map(r => [r.id, r]))
  return {
    snapshot: () => records,
    getIndexes: () => indexes,
    lookupById: (id: string) => byId.get(id),
  }
}

const plainSource = (records: Row[]): QuerySource<Row> => ({ snapshot: () => records })

const idsOf = (rows: readonly Row[]): string[] => rows.map(r => r.id)
const sorted = (rows: readonly Row[]): string[] => idsOf(rows).sort()

describe('#1425 — compound candidate path (where + where)', () => {
  it('a Date twin operand returns the same rows indexed and scanned — the reported case', () => {
    const q = (s: QuerySource<Row>): string[] =>
      sorted(new Query<Row>(s).where('d', '==', D1_TWIN).where('k', '==', 'x').toArray())

    // Strict definition both paths owe.
    const strict = sorted(ROWS.filter(r => (r.d as unknown) === D1_TWIN && r.k === 'x'))
    expect(strict).toEqual([])

    expect(q(indexedSource(ROWS))).toEqual(strict)
    expect(q(plainSource(ROWS))).toEqual(strict)
  })

  it('the identical Date object still matches — the fix must not decline every operand', () => {
    const q = (s: QuerySource<Row>): string[] =>
      sorted(new Query<Row>(s).where('d', '==', D1).where('k', '==', 'x').toArray())

    expect(q(indexedSource(ROWS))).toEqual(['a'])
    expect(q(plainSource(ROWS))).toEqual(['a'])
  })

  it('still narrows through the compound index — the win is the candidate set, not the clause', () => {
    const e = new Query<Row>(indexedSource(ROWS)).where('d', '==', D1).where('k', '==', 'x').explain()
    const where = e.nodes.find(n => n.op === 'where')
    expect(where?.dispatch).toBe('index:compound')
    // ...and explain now SAYS the clause is not consumed (#1375's mirror rule).
    expect(where?.notes.join(' ')).toMatch(/superset/)
  })

  it('an equality prefix plus a range agrees too', () => {
    const q = (s: QuerySource<Row>): string[] =>
      sorted(new Query<Row>(s).where('k', '==', 'x').where('n', '>=', 2).toArray())
    expect(q(indexedSource(ROWS))).toEqual(q(plainSource(ROWS)))
    expect(q(indexedSource(ROWS))).toEqual(['b'])
  })
})

describe('#1425 — compound ordered path (where + orderBy + limit)', () => {
  const cases: ReadonlyArray<{ readonly why: string; readonly operand: Date; readonly offset: number }> = [
    { why: 'Date twin, page 1', operand: D1_TWIN, offset: 0 },
    { why: 'Date twin, page 2', operand: D1_TWIN, offset: 1 },
    { why: 'exact Date, page 1', operand: D1, offset: 0 },
    { why: 'exact Date, page 2', operand: D1, offset: 1 },
  ]

  for (const c of cases) {
    it(`${c.why} agrees across index and scan`, () => {
      const run = (s: QuerySource<Row>): string[] =>
        idsOf(
          new Query<Row>(s)
            .where('d', '==', c.operand)
            .orderBy('k')
            .offset(c.offset)
            .limit(5)
            .toArray(),
        )
      expect(run(indexedSource(ROWS))).toEqual(run(plainSource(ROWS)))
    })
  }

  it('the exact operand still returns a full, correctly ordered page', () => {
    const run = (s: QuerySource<Row>): string[] =>
      idsOf(new Query<Row>(s).where('d', '==', D1).orderBy('k').limit(5).toArray())
    // 'a' (k=x), 'c' (k=y), 'f' (k=z)
    expect(run(indexedSource(ROWS))).toEqual(['a', 'c', 'f'])
    expect(run(plainSource(ROWS))).toEqual(['a', 'c', 'f'])
  })

  it('offset counts MATCHING rows, not index positions', () => {
    const run = (s: QuerySource<Row>): string[] =>
      idsOf(new Query<Row>(s).where('d', '==', D1).orderBy('k').offset(1).limit(1).toArray())
    expect(run(indexedSource(ROWS))).toEqual(['c'])
    expect(run(plainSource(ROWS))).toEqual(['c'])
  })

  it('a limit smaller than the match count still fills the page', () => {
    const run = (s: QuerySource<Row>): string[] =>
      idsOf(new Query<Row>(s).where('d', '==', D1).orderBy('k').limit(2).toArray())
    expect(run(indexedSource(ROWS))).toEqual(['a', 'c'])
    expect(run(plainSource(ROWS))).toEqual(['a', 'c'])
  })
})

describe('#1425 — the fixture is de-vacuumed', () => {
  /**
   * The tuple key the index would compute for `d`, recomputed here so the
   * guard does not depend on the code under test. Equal keys + `!==` values
   * is precisely the collision the two paths used to disagree on.
   */
  const keyLike = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v))

  it('D1_TWIN collides with stored rows while being a different object', () => {
    const colliding = ROWS.filter(r => keyLike(r.d) === keyLike(D1_TWIN))
    expect(colliding.map(r => r.id)).toEqual(['a', 'c', 'f'])
    // If this ever becomes true the whole file goes vacuous.
    expect(colliding.every(r => (r.d as unknown) !== D1_TWIN)).toBe(true)
  })

  it('the ordered path really is the one under test — the shape dispatches to it', () => {
    const e = new Query<Row>(indexedSource(ROWS)).where('d', '==', D1).orderBy('k').limit(5).explain()
    expect(e.nodes.some(n => n.dispatch === 'index:compound')).toBe(true)
  })
})
