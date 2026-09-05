/**
 * #1437 — the compiled clause must be OBSERVATIONALLY IDENTICAL to the
 * interpreter, edge cases included.
 *
 * `filterRecords` now compiles `==` and `in` on a via-free top-level field into
 * a direct property read, once per query instead of once per row. That is
 * paying back a cost #1415 introduced on purpose: an `==` served from the hash
 * index now STAYS in the plan and re-checks every candidate, which is what
 * makes index and scan agree by construction.
 *
 * ⛔ A specialisation that disagrees with the interpreter reintroduces the
 * #1402 class from the other side — index and scan answering the same query
 * differently — so this file is an equivalence table, not a behaviour list. It
 * asserts `compiled === interpreted` for every row, and separately that both
 * equal a strict hand-written predicate, so a shared bug in the pair cannot
 * pass.
 *
 * The rows and operands are chosen to hit exactly what the specialisation
 * changed: `readPath`'s nullish handling, `Array.isArray` gating on `in`, and
 * SameValueZero membership (`NaN`, `-0`, object identity) where a `Set`
 * replaced `Array.includes`.
 */
import { describe, it, expect } from 'vitest'
import { Query, type QuerySource } from '../src/kernel/query/index.js'
import { evaluateClause } from '../src/kernel/query/predicate.js'
import type { Clause } from '../src/kernel/query/predicate.js'

const OBJ = { tag: 'shared' }
const D1 = new Date('2026-04-01T00:00:00.000Z')

interface Row { id: string; v: unknown }

/** Values chosen so that every edge the specialisation touches is represented. */
const VALUES: Array<[string, unknown]> = [
  ['str', 'a'],
  ['strNum', '1'],
  ['num', 1],
  ['zero', 0],
  ['negZero', -0],
  ['nan', NaN],
  ['bool', true],
  ['boolStr', 'true'],
  ['nul', null],
  ['undef', undefined],
  ['obj', OBJ],
  ['objCopy', { tag: 'shared' }],
  ['date', D1],
  ['emptyStr', ''],
]

const ROWS: Row[] = VALUES.map(([id, v]) => ({ id, v }))
/** Rows the specialisation must survive without throwing on a property read. */
const HOSTILE: unknown[] = [null, undefined, ...ROWS]

const OPERANDS: unknown[] = [
  'a', '1', 1, 0, -0, NaN, true, 'true', null, undefined, OBJ, { tag: 'shared' }, D1, '',
]

const plain = (records: readonly unknown[]): QuerySource<Row> => ({ snapshot: () => records as readonly Row[] })

const show = (v: unknown): string =>
  v instanceof Date ? `Date(${v.toISOString()})`
    : typeof v === 'object' && v !== null ? JSON.stringify(v)
      : Object.is(v, -0) ? '-0'
        : typeof v === 'string' ? JSON.stringify(v) : String(v)

/** The interpreter, called directly — the definition the compiled form owes. */
function interpreted(op: '==' | 'in', operand: unknown): string[] {
  const clause = { type: 'field', field: 'v', op, value: operand } as unknown as Clause
  return HOSTILE.filter((r) => evaluateClause(r, clause)).map((r) => (r as Row | null)?.id ?? 'nullish')
}

/** The full query path, which is what actually compiles the clause. */
function compiled(op: '==' | 'in', operand: unknown): string[] {
  return new Query<Row>(plain(HOSTILE))
    .where('v', op, operand)
    .toArray()
    .map((r) => (r as Row | null)?.id ?? 'nullish')
}

describe('#1437 — compiled `==` agrees with the interpreter', () => {
  for (const operand of OPERANDS) {
    it(`v == ${show(operand)}`, () => {
      const want = interpreted('==', operand)
      expect(compiled('==', operand)).toEqual(want)
      // And both agree with a strict hand-written predicate, so a shared bug
      // in the pair cannot pass.
      const strict = HOSTILE
        .filter((r) => (r === null || r === undefined ? undefined : (r as Row).v) === operand)
        .map((r) => (r as Row | null)?.id ?? 'nullish')
      expect(want).toEqual(strict)
    })
  }
})

describe('#1437 — compiled `in` agrees with the interpreter', () => {
  const arrays: unknown[] = [
    ['a', '1'],
    [1, 2],
    [NaN],
    [-0],
    [0],
    [null],
    [undefined],
    [OBJ],
    [{ tag: 'shared' }],
    [D1],
    [],
    // Not an array: matches nothing, same as `Array.isArray` gating.
    'a',
    null,
    undefined,
    42,
  ]
  for (const operand of arrays) {
    it(`v in ${show(operand)}`, () => {
      const want = interpreted('in', operand)
      expect(compiled('in', operand)).toEqual(want)
      const strict = HOSTILE
        .filter((r) => Array.isArray(operand)
          && (operand as unknown[]).includes(r === null || r === undefined ? undefined : (r as Row).v))
        .map((r) => (r as Row | null)?.id ?? 'nullish')
      expect(want).toEqual(strict)
    })
  }

  it('a Set matches Array.includes on NaN and on -0/0, which is why it is safe here', () => {
    // The two places `Set.has` and `Array.includes` could have differed.
    // Both use SameValueZero: NaN is found, and -0 matches 0.
    expect([NaN].includes(NaN)).toBe(new Set([NaN]).has(NaN))
    expect([-0].includes(0)).toBe(new Set([-0]).has(0))
    expect([0].includes(-0)).toBe(new Set([0]).has(-0))
  })
})

describe('#1437 — everything else still goes to the interpreter', () => {
  const untouched: Array<{ op: '!=' | '>' | 'startsWith' | 'contains' | '!in'; operand: unknown }> = [
    { op: '!=', operand: 'a' },
    { op: '>', operand: 0 },
    { op: 'startsWith', operand: 'a' },
    { op: 'contains', operand: 'a' },
    { op: '!in', operand: ['a'] },
  ]
  for (const u of untouched) {
    it(`v ${u.op} ${show(u.operand)} is unchanged`, () => {
      const clause = { type: 'field', field: 'v', op: u.op, value: u.operand } as unknown as Clause
      const want = HOSTILE.filter((r) => evaluateClause(r, clause)).map((r) => (r as Row | null)?.id ?? 'nullish')
      const got = new Query<Row>(plain(HOSTILE)).where('v', u.op, u.operand).toArray()
        .map((r) => (r as Row | null)?.id ?? 'nullish')
      expect(got).toEqual(want)
    })
  }

  it('a DOTTED path is not specialised and still resolves', () => {
    interface Nested { id: string; a?: { b?: unknown } }
    const rows: Nested[] = [
      { id: 'hit', a: { b: 1 } },
      { id: 'miss', a: { b: 2 } },
      { id: 'noA' },
      { id: 'noB', a: {} },
    ]
    const got = new Query<Nested>({ snapshot: () => rows }).where('a.b', '==', 1).toArray()
    expect(got.map((r) => r.id)).toEqual(['hit'])
  })

  it('a multi-clause plan compiles each clause independently', () => {
    interface Two { id: string; a: unknown; b: unknown }
    const rows: Two[] = [
      { id: 'both', a: 1, b: 'x' },
      { id: 'aOnly', a: 1, b: 'y' },
      { id: 'neither', a: 2, b: 'y' },
    ]
    const got = new Query<Two>({ snapshot: () => rows }).where('a', '==', 1).where('b', 'in', ['x']).toArray()
    expect(got.map((r) => r.id)).toEqual(['both'])
  })
})
