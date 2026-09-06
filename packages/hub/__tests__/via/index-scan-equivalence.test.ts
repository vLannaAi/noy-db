/**
 * #1402 — INDEX/SCAN EQUIVALENCE over every Via-covered field and every
 * operator.
 *
 * This is the property the bug actually violated, and it is strictly
 * stronger than "the binding claims the operator": claiming is one way to
 * satisfy it, and a test that only checks the claim cannot tell you whether
 * the two paths agree. Two collections hold byte-identical records; one
 * declares a `sorted` index on the Via field (which keeps the hash index
 * too, so `==`/`in` take a bucket lookup and `<`/`between`/`startsWith`
 * take the ordered array), the other declares none and can only scan. For
 * every operator in the `Operator` union and every operand below, the two
 * must return the same ids — or BOTH throw.
 *
 * A disagreement here is the #1402 failure mode exactly: silently wrong
 * rows, visible only where an index happens to exist. Before PR #1400,
 * `where('at','startsWith','gc')` on a `geo()` field returned 41 rows
 * indexed against 0 scanned, because the index answered over the geohash
 * key while the scan compared a `{ lat, lng }` object.
 *
 * ## Which fields are covered here, and which are excluded and why
 *
 * `geo`, `money`, `lookup` and `i18n` are exercised end to end below.
 * The other three `src/via/**` bindings cannot reach this path at all:
 *
 *  - **blob** and **computed** declare `queryable: 'none'`, so `where()`
 *    throws `FieldNotQueryableError` at the call site before any clause is
 *    built — asserted below rather than assumed.
 *  - **classified** is sealed at rest and its `digest-only` storage form is
 *    refused outright when the field is also indexed (guards.ts R4) —
 *    asserted below. It implements no `canonicalizeIndexKey`, so it is
 *    outside the divergence class regardless; `via/operator-claim-coverage.
 *    test.ts` is what pins that.
 *
 * Keep that list in step with `SUBJECTS` in the coverage test — that file's
 * property 1 is what fails when a new Via feature appears.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { createNoydb } from '../../src/kernel/noydb.js'
import { withIndexing } from '../../src/with-lookup/indexing/index.js'
import { withI18n } from '../../src/via/i18n/index.js'
import { via } from '../../src/kernel/via/compose.js'
import { geo } from '../../src/via/geo/descriptor.js'
import { money } from '../../src/via/money/descriptor.js'
import { enumOf } from '../../src/via/lookup/descriptor.js'
import { i18nText } from '../../src/via/i18n/core.js'
import { FieldNotQueryableError, ConflictError } from '../../src/kernel/errors.js'
import type { Operator } from '../../src/kernel/query/predicate.js'
import type { Noydb } from '../../src/kernel/noydb.js'
import type { Collection } from '../../src/kernel/collection.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../../src/kernel/types.js'
// #1458 — the query DSL ships in four groups; these side-effect imports
// attach the extension methods this file exercises. A consumer on the root
// barrel needs none of them (it imports all three); this file builds its
// Query from `kernel/query` directly, so it takes what it uses.
import '../../src/kernel/query/relate/index.js'

function toMemory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function gc(c: string, col: string): Map<string, EncryptedEnvelope> {
    let comp = store.get(c); if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col); if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    name: 'memory',
    async get(c, col, id) { return store.get(c)?.get(col)?.get(id) ?? null },
    async put(c, col, id, env, ev) {
      const coll = gc(c, col); const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(c, col, id) { store.get(c)?.get(col)?.delete(id) },
    async list(c, col) { const coll = store.get(c)?.get(col); return coll ? [...coll.keys()] : [] },
    async loadAll(c) {
      const comp = store.get(c); const s: VaultSnapshot = {}
      if (comp) for (const [n, coll] of comp) {
        if (!n.startsWith('_')) {
          const r: Record<string, EncryptedEnvelope> = {}
          for (const [id, e] of coll) r[id] = e
          s[n] = r
        }
      }
      return s
    },
    async saveAll(c, data) {
      const comp = new Map<string, Map<string, EncryptedEnvelope>>()
      for (const [name, records] of Object.entries(data)) {
        const coll = new Map<string, EncryptedEnvelope>()
        for (const [id, env] of Object.entries(records)) coll.set(id, env)
        comp.set(name, coll)
      }
      const existing = store.get(c)
      if (existing) for (const [name, coll] of existing) if (name.startsWith('_')) comp.set(name, coll)
      store.set(c, comp)
    },
  }
}

/**
 * The whole `Operator` union as values — same `satisfies` trick as the
 * coverage test: a new operator that is not swept here fails TYPECHECK.
 */
const OPERATOR_TABLE = {
  '==': true, '!=': true, '<': true, '<=': true, '>': true, '>=': true,
  in: true, '!in': true, contains: true, startsWith: true, between: true,
  matches: true, near: true,
} satisfies Record<Operator, true>
const OPERATORS = Object.keys(OPERATOR_TABLE) as readonly Operator[]

/**
 * One Via feature under test: how to declare the field, the records, and
 * the operands to try for each operator.
 *
 * `operands` is deliberately generous and deliberately WRONG-TYPED in
 * places — a string operand against a `geo()` field is exactly the shape
 * that found the original bug, and an operand no sane caller would write is
 * still an operand the two paths must agree about.
 */
interface Feature {
  readonly name: string
  readonly field: string
  readonly declare: () => unknown
  readonly records: ReadonlyArray<Record<string, unknown>>
  readonly operands: ReadonlyArray<unknown>
}

const FEATURES: readonly Feature[] = [
  {
    name: 'geo',
    field: 'at',
    declare: () => via(geo()),
    records: [
      { id: 'g1', at: { lat: 51.5007, lng: -0.1246 } },
      { id: 'g2', at: { lat: 51.5011, lng: -0.1251 } },
      { id: 'g3', at: { lat: -33.8568, lng: 151.2153 } },
      { id: 'g4', at: { lat: 0, lng: 0 } },
      { id: 'g5' }, // no point at all
    ],
    operands: [
      'gc', 'gcpv', 'u', '', 's0', // geohash-prefix shapes — the #1402 operand class
      { lat: 51.5007, lng: -0.1246 },
      { lat: 51.5007, lng: -0.1246, radiusKm: 1 },
      { lat: 0, lng: 0, radiusKm: 20000 },
      ['gc', 'u'],
      [{ lat: 0, lng: 0 }, { lat: 1, lng: 1 }],
      null, undefined, 0,
    ],
  },
  {
    name: 'money',
    field: 'total',
    declare: () => via(money({ currency: 'EUR' })),
    records: [
      { id: 'm1', total: 100 },
      { id: 'm2', total: 250.5 },
      { id: 'm3', total: 0 },
      { id: 'm4', total: 100 },
      { id: 'm5' },
    ],
    operands: ['100', '10000', 100, 0, 250.5, [100, 250.5], [0, 200], null, undefined],
  },
  {
    name: 'lookup',
    field: 'status',
    declare: () => via(enumOf(['draft', 'paid', 'void'])),
    records: [
      { id: 'l1', status: 'draft' },
      { id: 'l2', status: 'paid' },
      { id: 'l3', status: 'paid' },
      { id: 'l4', status: 'void' },
      { id: 'l5' },
    ],
    operands: ['draft', 'paid', 'p', 'x', ['draft', 'void'], ['draft', 'paid'], null, undefined, 1],
  },
  {
    name: 'i18n',
    field: 'title',
    declare: () => via(i18nText({ languages: ['en', 'th'], required: 'all' })),
    records: [
      { id: 'i1', title: { en: 'alpha', th: 'อัลฟา' } },
      { id: 'i2', title: { en: 'beta', th: 'เบต้า' } },
      { id: 'i3', title: { en: 'alpha', th: 'อัลฟา' } },
    ],
    operands: ['alpha', 'al', { en: 'alpha', th: 'อัลฟา' }, ['alpha', 'beta'], null, undefined],
  },
]

/** The two collections one feature is measured across. */
interface Pair { readonly indexed: Collection<Record<string, unknown>>; readonly plain: Collection<Record<string, unknown>> }

async function db(): Promise<Noydb> {
  return createNoydb({
    store: toMemory(),
    user: 'owner',
    secret: 'via-index-scan-equivalence-1402',
    indexingStrategy: withIndexing(),
    i18nStrategy: withI18n(),
  })
}

async function setup(f: Feature): Promise<Pair> {
  const vault = await (await db()).openVault('TEST')
  const spec = f.declare()
  const indexed = vault.collection<Record<string, unknown>>(`${f.name}_indexed`, {
    viaFields: { [f.field]: spec } as never,
    indexes: [{ fields: [f.field], kind: 'sorted' }],
  })
  const plain = vault.collection<Record<string, unknown>>(`${f.name}_plain`, {
    viaFields: { [f.field]: spec } as never,
  })
  for (const r of f.records) {
    await indexed.put(r.id as string, r)
    await plain.put(r.id as string, r)
  }
  return { indexed, plain }
}

/** Run one clause, returning either the sorted ids or the thrown error's name. */
function answer(coll: Collection<Record<string, unknown>>, field: string, op: Operator, value: unknown): string[] | string {
  try {
    return coll.query().where(field as never, op, value).toArray().map(r => r.id as string).sort()
  } catch (e) {
    return `THREW:${(e as Error).constructor.name}`
  }
}

describe.each(FEATURES.map(f => [f.name, f] as const))(
  '#1402 > %s — the index and the scan answer every operator identically',
  (_name, f) => {
    let pair: Pair
    beforeAll(async () => { pair = await setup(f) })

    for (const op of OPERATORS) {
      it(`${op}`, () => {
        for (const value of f.operands) {
          const hot = answer(pair.indexed, f.field, op, value)
          const cold = answer(pair.plain, f.field, op, value)
          expect(
            hot,
            `via/${f.name}: where("${f.field}", '${op}', ${JSON.stringify(value) ?? String(value)}) ` +
            `answered ${JSON.stringify(hot)} from the INDEXED collection and ${JSON.stringify(cold)} ` +
            `from the identical unindexed one. That is #1402: the secondary index served a clause ` +
            `whose stored key space differs from its stored value space, because the binding left ` +
            `clause.via unset for this operator. The index is only ever allowed to NARROW — it must ` +
            `never change the answer. See via/operator-claim-coverage.test.ts for the structural half.`,
          ).toEqual(cold)
        }
      })
    }

    it('at least one operand actually took the index (the parity is not vacuous)', () => {
      // A parity assertion over an index that never fires proves nothing.
      // `explain()` names the access path the planner chose.
      const plans = f.operands.flatMap(value =>
        OPERATORS.map(op => {
          try { return JSON.stringify(pair.indexed.query().where(f.field as never, op, value).explain()) } catch { return '' }
        }),
      )
      expect(plans.some(p => p.includes('index') || p.includes('prefix'))).toBe(true)
    })
  },
)

describe('#1402 > the bindings that never reach this path, asserted rather than assumed', () => {
  it('blob and computed refuse where() at the call site (queryable: none)', async () => {
    const vault = await (await db()).openVault('TEST')
    const blobColl = vault.collection<Record<string, unknown>>('blobs', { blobFields: { receipt: {} } })
    expect(() => blobColl.query().where('receipt' as never, '==', 1)).toThrow(FieldNotQueryableError)
    const computedColl = vault.collection<Record<string, unknown>>('computeds', {
      computed: { double: { fn: (r: Record<string, unknown>) => (r.n as number) * 2, deps: ['n'], mode: 'virtual' } },
    } as never)
    expect(() => computedColl.query().where('double' as never, '==', 1)).toThrow(FieldNotQueryableError)
  })

  it('a digest-only classified field cannot be indexed at all (guards.ts R4)', async () => {
    const vault = await (await db()).openVault('TEST')
    expect(() => vault.collection<Record<string, unknown>>('cards', {
      classifiedFields: { pan: { storage: 'digest-only', sensitivity: 'pci' } },
      indexes: [{ fields: ['pan'], kind: 'sorted' }],
    } as never)).toThrow()
  })
})
