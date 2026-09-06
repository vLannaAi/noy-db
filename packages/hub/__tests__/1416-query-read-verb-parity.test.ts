/**
 * #1416 — `query().toArray()` must not return a different SHAPE of the same
 * record than `get()`/`list()` do.
 *
 * `decodeVia` ran the Via pipeline's `decodeResults` hook, which is money's
 * stored→canonical decode and nothing else. So a `computed({ mode:'virtual' })`
 * field read `undefined` on a query row while `get()` returned it — reported as
 * `receiptAmount get=84715.00 query=undefined`. A caller summing that field
 * over a query result got `NaN` with no error, which is the exact failure the
 * field was introduced to remove.
 *
 * Two halves, and only one of them was ever a bug:
 *
 *   VALUES (virtual computed fields, money's canonical decode) — missing, and
 *     nothing about them depends on a locale. Now always present.
 *   LOCALE FORMATTING (`<field>Formatted` / `<field>Number`) — omitted
 *     DELIBERATELY, because fabricating a guessed-locale string here would make
 *     it-IT via `get()` disagree with en-US here. That reasoning stands; what
 *     had gone stale is the premise that "the query layer carries no locale",
 *     since `toArray({ locale })` exists. Now honoured when explicitly given.
 *
 * ⛔ THE OBVIOUS IMPLEMENTATION IS MEASURABLY WRONG, and one test below pins
 * it: presenting twice (raw for the plan, then at the locale for output)
 * silently yields the RAW row, because the second pass sees an already-decoded
 * value and re-emits no siblings. Presentation happens exactly once, after the
 * plan has finished.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/kernel/noydb.js'
import { memoryStore } from '../src/kernel/memory-store.js'
import { money } from '../src/via/money/index.js'
import { ViaPipeline } from '../src/kernel/via/pipeline.js'
import { moneyVia } from '../src/via/money/binding.js'

interface Row { id: string; amount: number; tag: string }

const SECRET = 'issue-1416-read-verb-parity-secret'

async function open() {
  const db = await createNoydb({ store: memoryStore(), user: 'o', secret: SECRET })
  const vault = await db.openVault('V')
  const col = vault.collection<Row>('rows', {
    moneyFields: { amount: money({ currency: 'THB', scale: 2 }) },
    computed: { doubled: { fn: (r: Record<string, unknown>) => Number(r['amount']) * 2, mode: 'virtual' } },
  } as never)
  await col.put('r1', { id: 'r1', amount: 84715, tag: 'x' })
  await col.put('r2', { id: 'r2', amount: 10, tag: 'y' })
  return { vault, col }
}

const keys = (o: unknown): string[] => Object.keys(o as object).sort()

describe('#1416 — values are not optional', () => {
  it('a virtual computed field is on the query row, as it is on get()', async () => {
    const { col } = await open()
    const got = await col.get('r1')
    const q = col.query().where('id', '==', 'r1').toArray()[0]

    // The reported defect: this key was absent, so summing it gave NaN.
    expect((q as unknown as Record<string, unknown>)['doubled']).toBe(169430)
    expect((q as unknown as Record<string, unknown>)['doubled']).toBe((got as unknown as Record<string, unknown>)['doubled'])
  })

  it('money still decodes to canonical decimal, unchanged', async () => {
    const { col } = await open()
    const q = col.query().where('id', '==', 'r1').toArray()[0]
    expect((q as unknown as Record<string, unknown>)['amount']).toBe('84715.00')
  })

  it('does NOT fabricate locale-formatted siblings without a locale', async () => {
    // The boundary the original doc comment drew, and it still holds: guessing
    // a locale here would make get() and query() disagree on the virtual.
    const { col } = await open()
    const q = col.query().where('id', '==', 'r1').toArray()[0]
    expect(keys(q)).toEqual(['amount', 'doubled', 'id', 'tag'])
  })
})

describe('#1416 — toArray({ locale }) is honoured instead of ignored', () => {
  it('reaches full parity with get()', async () => {
    const { col } = await open()
    const got = await col.get('r1')
    const q = col.query().where('id', '==', 'r1').toArray({ locale: 'en-US' })[0]

    expect(keys(q)).toEqual(keys(got))
    expect((q as unknown as Record<string, unknown>)['amountNumber']).toBe(84715)
    // NBSP: Intl separates the currency code with U+00A0, which prints
    // identically to a space in a failure message.
    expect(String((q as unknown as Record<string, unknown>)['amountFormatted']).replace(/ /g, ' '))
      .toBe('THB 84,715.00')
  })

  it('was previously accepted and silently ignored', async () => {
    // Pinning the fix direction: the option existed and did nothing, which is
    // the same trap as a no-op config key.
    const { col } = await open()
    const withLocale = col.query().where('id', '==', 'r1').toArray({ locale: 'en-US' })[0]
    const without = col.query().where('id', '==', 'r1').toArray()[0]
    expect(keys(withLocale)).not.toEqual(keys(without))
  })
})

describe('#1416 — presenting twice is not a valid implementation', () => {
  it('a second pass over an already-presented row silently loses the formatting', () => {
    // ⛔ This is why formatting happens ONCE, after the plan finishes, rather
    // than "raw for the plan, locale for output". The two-pass version returns
    // the raw row with no error at all.
    const via = ViaPipeline.build([moneyVia({ amount: money({ currency: 'THB', scale: 2 }) })])
    expect(via).not.toBeNull()
    const ctxRaw = { locale: 'raw', layer: 'read' as const }
    const ctxLoc = { locale: 'en-US', layer: 'read' as const }

    const stored = { id: 'r1', amount: 8471500 }
    const once = via!.presentSync(stored, ctxLoc).record
    const twice = via!.presentSync(via!.presentSync(stored, ctxRaw).record, ctxLoc).record

    expect(once['amountFormatted']).toBeDefined()
    expect(twice['amountFormatted']).toBeUndefined()
    expect(twice['amount']).toBe(once['amount'])
  })
})

describe('#1416 — predicates and ordering still see RAW stored values', () => {
  it('a money predicate on the ordinary path is unaffected', async () => {
    const { col } = await open()
    expect(col.query().where('amount', '>', 1000).toArray().map(r => r.id)).toEqual(['r1'])
    expect(col.query().where('amount', '<', 1000).toArray().map(r => r.id)).toEqual(['r2'])
  })

  it('a money predicate is unaffected WITH a locale, which is the hazard the reorder removes', async () => {
    // Presenting before the filter would hand `evaluateClause` a formatted
    // string ("THB 84,715.00") where it expects the raw stored value.
    const { col } = await open()
    expect(col.query().where('amount', '>', 1000).toArray({ locale: 'en-US' }).map(r => r.id)).toEqual(['r1'])
  })

  it('ordering on a money field is unaffected', async () => {
    const { col } = await open()
    expect(col.query().orderBy('amount').toArray().map(r => r.id)).toEqual(['r2', 'r1'])
    expect(col.query().orderBy('amount', 'desc').toArray({ locale: 'en-US' }).map(r => r.id)).toEqual(['r1', 'r2'])
  })

  it('a callback filter still sees a decoded view', async () => {
    // `fnViewDecoder` builds that separately and always did — moving the
    // present later must not disturb it.
    const { col } = await open()
    const hits = col.query().filter(r => (r as unknown as Record<string, unknown>)['amount'] === '84715.00').toArray()
    expect(hits.map(r => r.id)).toEqual(['r1'])
  })
})

describe('#1416 — presentSync reports what it could not run', () => {
  it('folds a sync binding and names an async one instead of dropping it silently', () => {
    const sync = { brand: 'syncy', presentIsSync: true, covers: () => false, present: (r: Record<string, unknown>) => ({ ...r, s: 1 }) }
    const async_ = { brand: 'asyncy', covers: () => false, present: (r: Record<string, unknown>) => Promise.resolve({ ...r, a: 1 }) }
    // Built through the real constructor so the contract is tested, not a
    // hand-assembled object that could drift from it.
    const pipeline = ViaPipeline.build([sync as never, async_ as never])!
    expect(pipeline).not.toBeNull()

    const out = pipeline.presentSync({ id: 'x' }, { locale: 'raw', layer: 'read' })
    expect(out.record['s']).toBe(1)
    // The async binding did not run, and says so rather than leaving a hole.
    expect(out.record['a']).toBeUndefined()
    expect(out.skipped).toEqual(['asyncy'])
    expect(pipeline.hasAsyncPresent).toBe(true)
  })
})
