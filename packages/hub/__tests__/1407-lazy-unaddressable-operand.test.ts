/**
 * #1407 — lazy mode's persisted index has #1402's unaddressable-operand hole,
 * and no scan to fall back to.
 *
 * `stringifyKey` folds every non-Date object into one `\0OBJECT\0` bucket and
 * every nullish value into `\0NULL\0`. Probing either is not an address
 * lookup. #1402 fixed the eager half by returning `null` so `candidateRecords`
 * falls back to a scan; lazy has no scan, which is why that PR stopped here.
 *
 * ⭐ ONLY HALF OF IT IS A DEFECT, and the RED run is what established which:
 * deleting the guard entirely fails only the nullish cases.
 *
 *   object operand  — NOT broken. `\0OBJECT\0` holds every object-valued
 *                     record, only an object can `===` an object operand, and
 *                     `toArray()`'s post-filter applies the exact predicate.
 *                     The bucket is already a sound superset. The issue text
 *                     (mine) said lazy "answers an object operand from the
 *                     collision bucket" — true of the CANDIDATES, false of the
 *                     ANSWER, and a first draft of the fix duly routed it
 *                     through `orderedBy`: a looser superset, so a silent perf
 *                     regression dressed as a correctness fix.
 *   nullish operand — broken. `addToState` skips nullish values, so records
 *                     that MATCH are absent from the index and no candidate set
 *                     can contain them. `[]` reads as "no matches". Refused.
 *
 * The object cases below are kept as REGRESSION GUARDS: they would fail if
 * someone removed the post-filter that is doing the work.
 *
 * The parity assertions compare lazy against an EAGER SCAN over the same
 * records — the discipline #684 used for money — because "lazy agrees with
 * itself" would pass on a fixture where the collision cannot occur.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { memoryStore } from '../src/kernel/memory-store.js'
import { withIndexing } from '../src/with-lookup/indexing/index.js'
import { IndexRequiredError } from '../src/kernel/errors.js'

interface Row { id: string; obj: unknown; tag: unknown }

const SECRET = 'issue-1407-lazy-unaddressable-secret'

/** Two object-valued rows that share the `\0OBJECT\0` bucket, plus a nullish one. */
const ROWS: Row[] = [
  { id: 'a', obj: { k: 1 }, tag: 'x' },
  { id: 'b', obj: { k: 2 }, tag: 'y' },
  { id: 'c', obj: 'plain', tag: null },
  { id: 'd', obj: 42, tag: 'z' },
]

async function open() {
  const db = await createNoydb({
    store: memoryStore(), user: 'o', secret: SECRET, indexingStrategy: withIndexing(),
  })
  const vault = await db.openVault('V')
  const lazy = vault.collection<Row>('lazyRows', { prefetch: false, cache: { maxRecords: 100 }, indexes: ['obj', 'tag'] } as never)
  const eager = vault.collection<Row>('eagerRows')
  for (const r of ROWS) {
    await lazy.put(r.id, r)
    await eager.put(r.id, r)
  }
  await eager.list()
  return { lazy, eager }
}

const ids = (rows: readonly Row[]): string[] => rows.map((r) => r.id).sort()

describe('#1407 — an object operand was already correct (the post-filter does it)', () => {
  it('lazy agrees with the eager scan instead of returning every object-valued row', async () => {
    const { lazy, eager } = await open()
    const operand = { k: 1 }

    // Strict truth: `{k:1} === {k:1}` is false, so nothing matches.
    const scanned = ids(eager.query().where('obj', '==', operand).toArray())
    expect(scanned).toEqual([])

    expect(ids(await lazy.lazyQuery().where('obj', '==', operand).toArray())).toEqual(scanned)
  })

  it('the IDENTICAL object still matches', async () => {
    const { lazy, eager } = await open()
    // Re-fetch the stored object so identity can hold on the eager side.
    const stored = (await eager.get('a')) as Row
    const operand = stored.obj

    const scanned = ids(eager.query().where('obj', '==', operand).toArray())
    expect(scanned).toEqual(['a'])
    expect(ids(await lazy.lazyQuery().where('obj', '==', operand).toArray())).toEqual(scanned)
  })

  it('a non-object operand on the same field is unaffected', async () => {
    const { lazy, eager } = await open()
    for (const operand of ['plain', 42]) {
      const scanned = ids(eager.query().where('obj', '==', operand).toArray())
      expect(ids(await lazy.lazyQuery().where('obj', '==', operand).toArray())).toEqual(scanned)
    }
  })

  it('`in` carrying an object element agrees too', async () => {
    const { lazy, eager } = await open()
    const operand = [{ k: 1 }, 'plain']

    const scanned = ids(eager.query().where('obj', 'in', operand).toArray())
    expect(scanned).toEqual(['c'])
    expect(ids(await lazy.lazyQuery().where('obj', 'in', operand).toArray())).toEqual(scanned)
  })
})

describe('#1407 — a nullish operand is refused, not silently empty', () => {
  it('throws rather than reporting "no matches" for a row it cannot see', async () => {
    const { lazy, eager } = await open()

    // The eager scan finds it. Lazy structurally cannot.
    expect(ids(eager.query().where('tag', '==', null).toArray())).toEqual(['c'])

    // ⛔ The defect was returning [] here — indistinguishable from "no rows
    // match", while record 'c' matches and is simply not in the index.
    await expect(lazy.lazyQuery().where('tag', '==', null).toArray())
      .rejects.toThrow(IndexRequiredError)
  })

  it('the message does NOT tell the caller to declare an index that already exists', async () => {
    const { lazy } = await open()
    // `tag` IS indexed. The default IndexRequiredError text ("query references
    // unindexed fields … declare an index on each field") would send the
    // caller to fix something already correct — the #1430 defect class.
    const err = await lazy.lazyQuery().where('tag', '==', undefined).toArray().catch((e: unknown) => e)

    expect(err).toBeInstanceOf(IndexRequiredError)
    const message = (err as Error).message
    expect(message).toMatch(/never stores nullish values/)
    expect(message).toMatch(/not a missing index/)
    expect(message).not.toMatch(/Declare an index on each field/)
    expect((err as IndexRequiredError).reason).toBeDefined()
  })

  it('an `in` containing null is refused too — one bad element poisons the probe', async () => {
    const { lazy } = await open()
    // 'x' alone would be answerable; null makes the whole answer incomplete,
    // and a partial answer is the thing with no symptom.
    await expect(lazy.lazyQuery().where('tag', 'in', ['x', null]).toArray())
      .rejects.toThrow(IndexRequiredError)
  })

  it('an `in` with no nullish element is still answered', async () => {
    const { lazy, eager } = await open()
    const scanned = ids(eager.query().where('tag', 'in', ['x', 'z']).toArray())
    expect(scanned).toEqual(['a', 'd'])
    expect(ids(await lazy.lazyQuery().where('tag', 'in', ['x', 'z']).toArray())).toEqual(scanned)
  })
})

describe('#1407 — the default IndexRequiredError is unchanged', () => {
  it('an actually-unindexed field still gets the missing-fields message', async () => {
    const db = await createNoydb({
      store: memoryStore(), user: 'o', secret: SECRET, indexingStrategy: withIndexing(),
    })
    const vault = await db.openVault('W')
    const lazy = vault.collection<Row>('rows', { prefetch: false, cache: { maxRecords: 100 }, indexes: ['tag'] } as never)
    await lazy.put('a', { id: 'a', obj: 1, tag: 'x' })

    const err = await lazy.lazyQuery().where('obj', '==', 1).toArray().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(IndexRequiredError)
    expect((err as Error).message).toMatch(/Declare an index on each field/)
    expect((err as IndexRequiredError).reason).toBeUndefined()
  })
})
