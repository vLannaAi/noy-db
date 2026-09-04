/**
 * #1415 — the indexed answer to `==` / `in` must equal the scanned one.
 *
 * The hash index buckets by `stringifyBucketKey`, so `1` and `'1'` share a
 * bucket; the scan compares with `===`. Before this fix `candidateRecords()`
 * DROPPED the index-driving clause from `remainingClauses`, so nothing
 * re-checked the operand's type and the two paths returned different rows for
 * the same query — the #1402 class, on the ordinary equality path.
 *
 * ⚠️ EVERY DISAGREEING ROW BELOW IS DE-VACUUMED. A coercion case can only
 * collide when some STORED value stringifies to the operand's stringification,
 * so the fixture carries a record for each: `s: '1'` for `s == 1`, `s: '0'`
 * for `s == 0`, `s: 'true'` for `s == true`, `s: ISO1` for `s == D1`,
 * `n: 1`/`n: 0` for `n == '1'`/`n == '0'`, the boolean rows for `b == 'true'`,
 * the Date rows for `d == ISO1`, and `n: NaN` for `n == NaN`. Without those
 * rows the table passes on a fixture where the collision cannot occur.
 *
 * ⛔ TWO ROWS THAT LOOK LIKE COVERAGE ARE STRUCTURALLY VACUOUS AND CANNOT BE
 * DE-VACUUMED: `n == true` and `b == 1`. No number stringifies to `'true'`
 * and no boolean to `'1'`, so no fixture can make those collide. They are
 * kept, labelled, and must not be read as evidence that anything declined
 * them.
 */
import { describe, it, expect } from 'vitest'
import { Query, type QuerySource } from '../src/kernel/query/index.js'
import { CollectionIndexes } from '../src/with-lookup/indexing/eager-indexes.js'
import { createNoydb } from '../src/kernel/noydb.js'
import { memoryStore } from '../src/kernel/memory-store.js'
import { withIndexing } from '../src/with-lookup/indexing/index.js'

const D1 = new Date('2026-04-01T00:00:00.000Z')
const D2 = new Date('2026-05-01T00:00:00.000Z')
const ISO1 = D1.toISOString()

interface Row {
  id: string
  /** String field — the only one that can spell a number, a boolean or an ISO date. */
  s: string
  n: number
  b: boolean
  d: Date
}

/**
 * The de-vacuumed fixture. Read the `s` column as "the collision bait":
 * `'1'`, `'0'`, `'true'` and `ISO1` are exactly the stringifications of the
 * mistyped operands the table probes.
 */
const ROWS: Row[] = [
  { id: 'a', s: '1', n: 1, b: true, d: D1 },
  { id: 'b', s: '01', n: 2, b: false, d: D2 },
  { id: 'c', s: 'true', n: 0, b: true, d: D1 },
  { id: 'e', s: '0', n: 3, b: false, d: D2 },
  { id: 'f', s: ISO1, n: 4, b: false, d: D2 },
  { id: 'g', s: 'g', n: NaN, b: false, d: D2 },
]

const INDEXED_FIELDS = ['s', 'n', 'b', 'd'] as const

function indexedSource(records: Row[]): QuerySource<Row> {
  const indexes = new CollectionIndexes()
  for (const f of INDEXED_FIELDS) indexes.declare(f)
  indexes.build(records.map(r => ({ id: r.id, record: r })))
  const byId = new Map(records.map(r => [r.id, r]))
  return {
    snapshot: () => records,
    getIndexes: () => indexes,
    lookupById: (id: string) => byId.get(id),
  }
}

function plainSource(records: Row[]): QuerySource<Row> {
  return { snapshot: () => records }
}

const ids = (rows: readonly Row[]): string[] => rows.map(r => r.id).sort()

type Field = (typeof INDEXED_FIELDS)[number]

interface Case {
  readonly field: Field
  readonly op: '==' | 'in'
  readonly operand: unknown
  /** How this case was de-vacuumed, or why it cannot be. */
  readonly why: string
}

/** The strict, record-by-record answer — the definition the other two owe. */
function byFilter(c: Case): string[] {
  return ids(
    ROWS.filter(r => {
      const actual = r[c.field] as unknown
      return c.op === '=='
        ? actual === c.operand
        : Array.isArray(c.operand) && c.operand.includes(actual)
    }),
  )
}

function byIndex(c: Case): string[] {
  return ids(new Query<Row>(indexedSource(ROWS)).where(c.field, c.op, c.operand).toArray())
}

function byScan(c: Case): string[] {
  return ids(new Query<Row>(plainSource(ROWS)).where(c.field, c.op, c.operand).toArray())
}

/** The type-mismatched operands. Each one collides with a real stored key. */
const COERCING: readonly Case[] = [
  { field: 's', op: '==', operand: 1, why: "record a stores s: '1'" },
  { field: 's', op: '==', operand: 0, why: "record e stores s: '0'" },
  { field: 's', op: '==', operand: true, why: "record c stores s: 'true'" },
  { field: 's', op: '==', operand: D1, why: 'record f stores s: ISO1' },
  { field: 'n', op: '==', operand: '1', why: 'record a stores n: 1' },
  { field: 'n', op: '==', operand: '0', why: 'record c stores n: 0' },
  { field: 'n', op: '==', operand: NaN, why: 'record g stores n: NaN — and NaN !== NaN' },
  { field: 'b', op: '==', operand: 'true', why: 'records a and c store b: true' },
  { field: 'b', op: '==', operand: 'false', why: 'records b, e, f, g store b: false' },
  { field: 'd', op: '==', operand: ISO1, why: 'records a and c store d: D1' },
  { field: 's', op: 'in', operand: [1, '01'], why: "1 collides with a's s: '1'; '01' is a true hit" },
  { field: 'n', op: 'in', operand: ['1', 2], why: "'1' collides with a's n: 1; 2 is a true hit" },
  { field: 'd', op: 'in', operand: [ISO1, D2], why: 'ISO1 collides with D1; D2 is a true hit' },
]

/** Correct-type operands. These must keep matching, and keep using the index. */
const CONTROLS: readonly Case[] = [
  { field: 's', op: '==', operand: '1', why: 'control — exact string' },
  { field: 'n', op: '==', operand: 1, why: 'control — exact number' },
  { field: 'b', op: '==', operand: true, why: 'control — exact boolean' },
  { field: 'd', op: '==', operand: D1, why: 'control — the very Date object stored' },
  { field: 's', op: 'in', operand: ['1', '01'], why: 'control — exact strings' },
  { field: 'd', op: 'in', operand: [D1], why: 'control — the very Date object stored' },
]

/**
 * Cannot collide under ANY fixture — kept so a future reader does not mistake
 * their agreement for a guard. See the file header.
 */
const STRUCTURALLY_VACUOUS: readonly Case[] = [
  { field: 'n', op: '==', operand: true, why: 'no number stringifies to "true" — vacuous' },
  { field: 'b', op: '==', operand: 1, why: 'no boolean stringifies to "1" — vacuous' },
]

/**
 * A label that does NOT lie about the operand's type — `JSON.stringify` alone
 * renders `NaN` as `null` and a Date as its ISO string, which is exactly the
 * conflation this file is about.
 */
function show(value: unknown): string {
  if (value instanceof Date) return `Date(${value.toISOString()})`
  if (Array.isArray(value)) return `[${value.map(show).join(', ')}]`
  if (typeof value === 'string') return JSON.stringify(value)
  return String(value)
}

const label = (c: Case): string => `${c.field} ${c.op} ${show(c.operand)}`

describe('#1415 — index / scan / filter agree on == and in', () => {
  for (const c of [...COERCING, ...CONTROLS, ...STRUCTURALLY_VACUOUS]) {
    it(`${label(c)} (${c.why})`, () => {
      const expected = byFilter(c)
      expect(byIndex(c)).toEqual(expected)
      expect(byScan(c)).toEqual(expected)
    })
  }

  it('the coercing operands are all de-vacuumed — each has a stored key that stringifies to it', () => {
    // Guards the fixture, not the engine: if a future edit drops the bait
    // record, the row above starts passing for the wrong reason. The one
    // exception is NaN, whose bait row matches nothing by definition.
    for (const c of COERCING) {
      if (c.op === 'in') continue
      const coerced = ids(ROWS.filter(r => stringifyLike(r[c.field]) === stringifyLike(c.operand)))
      expect(coerced.length, `no bait record for ${label(c)}`).toBeGreaterThan(0)
    }
  })
})

/** The bucket key the index would compute — duplicated here on purpose, so the fixture guard does not depend on the code under test. */
function stringifyLike(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value)
}

describe('#1415 — the index still SERVES the correct-type operands', () => {
  // A fix that declined every primitive would pass the equivalence table
  // while destroying the index. `explain()` is the witness that it did not.
  for (const c of CONTROLS) {
    it(`${label(c)} is dispatched to the hash index`, () => {
      const e = new Query<Row>(indexedSource(ROWS)).where(c.field, c.op, c.operand).explain()
      const where = e.nodes.find(n => n.op === 'where')
      expect(where?.dispatch).toBe('index:hash')
    })
  }

  it('a coercing operand may still be index-dispatched — the answer is what must agree', () => {
    // Deliberately NOT asserting a dispatch here: this fix restores the
    // result, and leaves the planner free to narrow through the bucket and
    // re-filter. Kept as documentation of the boundary.
    const e = new Query<Row>(indexedSource(ROWS)).where('n', '==', '1').explain()
    expect(e.nodes.find(n => n.op === 'where')).toBeDefined()
  })
})

describe('#1415 — operators OUTSIDE the fix must not move', () => {
  const untouched: Array<{ op: '!=' | 'startsWith' | '>' | '<'; field: Field; operand: unknown }> = [
    { op: '!=', field: 's', operand: 1 },
    { op: '!=', field: 'n', operand: '1' },
    { op: 'startsWith', field: 's', operand: '0' },
    { op: '>', field: 'n', operand: 1 },
    { op: '<', field: 'n', operand: 3 },
  ]
  for (const u of untouched) {
    it(`${u.field} ${u.op} ${String(u.operand)} agrees across index and scan`, () => {
      const indexed = ids(new Query<Row>(indexedSource(ROWS)).where(u.field, u.op, u.operand).toArray())
      const scanned = ids(new Query<Row>(plainSource(ROWS)).where(u.field, u.op, u.operand).toArray())
      expect(indexed).toEqual(scanned)
    })
  }
})

describe('#1415 — end to end through withIndexing(), the pilot\'s configuration', () => {
  interface Worker {
    id: string
    /** A national id: a STRING that spells a number — the pilot's real case. */
    pin: string
  }

  it('a number operand against a string field returns the same rows indexed and unindexed', async () => {
    const db = await createNoydb({
      store: memoryStore(),
      user: 'owner',
      secret: 'issue-1415-equivalence-secret',
      indexingStrategy: withIndexing(),
    })
    const vault = await db.openVault('TEST')
    const indexed = vault.collection<Worker>('indexed', { indexes: ['pin'] })
    const plain = vault.collection<Worker>('plain')
    const rows: Worker[] = [
      { id: 'w1', pin: '1100400123450' },
      { id: 'w2', pin: '1100400123451' },
    ]
    for (const r of rows) {
      await indexed.put(r.id, r)
      await plain.put(r.id, r)
    }

    const asNumber = 1100400123450
    const indexedHits = indexed.query().where('pin', '==', asNumber).toArray()
    const plainHits = plain.query().where('pin', '==', asNumber).toArray()
    const strictHits = rows.filter(r => (r.pin as unknown) === asNumber)

    expect(indexedHits.map(r => r.id)).toEqual(plainHits.map(r => r.id))
    expect(indexedHits.map(r => r.id)).toEqual(strictHits.map(r => r.id))
    expect(indexedHits).toHaveLength(0)

    // The control: the correctly-typed operand still finds the row.
    expect(indexed.query().where('pin', '==', '1100400123450').toArray().map(r => r.id)).toEqual(['w1'])
  })

  it('`in` over a mixed array over-matches by nothing — each element is compared strictly', async () => {
    const db = await createNoydb({
      store: memoryStore(),
      user: 'owner',
      secret: 'issue-1415-equivalence-secret-2',
      indexingStrategy: withIndexing(),
    })
    const vault = await db.openVault('TEST')
    const indexed = vault.collection<Worker>('indexed', { indexes: ['pin'] })
    await indexed.put('w1', { id: 'w1', pin: '1' })
    await indexed.put('w2', { id: 'w2', pin: '01' })

    const hits = indexed.query().where('pin', 'in', [1, '01']).toArray()
    expect(hits.map(r => r.id)).toEqual(['w2'])
  })
})
