/**
 * #1416 — READ-VERB PARITY.
 *
 * The same record read through `get()`, `list()` and `query().toArray()` must
 * carry the SAME KEYS with the SAME VALUES. Before the fix, `query()` rows
 * carried only the Via `decodeResults` pass (money's stored scaled-int →
 * canonical decimal) and skipped `present()` entirely, so a `mode: 'virtual'`
 * computed field — and every money `<field>Formatted` / `<field>Number`
 * sibling, every i18n resolution and every lookup `<field>Label` — was simply
 * ABSENT from a query row. Summing such a field over `query()` silently
 * yielded `NaN`; over `list()` it was right.
 *
 * ⭐ The assertions here are deliberately SET EQUALITY over `Object.keys`, not
 * a hand-listed field list. A list goes stale the moment a new decoration is
 * added — which is exactly how a decoration would silently drop out of one
 * path again. Do not "simplify" these into named-key checks.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/index.js'
import { via } from '../src/kernel/via/compose.js'
import { computed } from '../src/via/computed/descriptor.js'
import { money } from '../src/via/money/descriptor.js'
import { i18nText } from '../src/via/i18n/core.js'
import { withI18n } from '../src/via/i18n/index.js'
import { dict } from '../src/via/lookup/descriptor.js'
import { inlineMemory } from './classified/harness.js'

interface Receipt extends Record<string, unknown> {
  id: string
  unit: number
  qty: number
  wht: number | string
  status: string
  title?: unknown
  receiptAmount?: unknown
}

/**
 * A collection that stacks every decoration family the read pipeline knows:
 * a plain money field, a `via(computed(virtual), money())` field (the pilot's
 * `receiptAmount` shape), an i18n text field and a reserved-tier lookup.
 */
async function receiptsVault(defaultLocale?: string) {
  const store = inlineMemory()
  const db = await createNoydb({ store, user: 'op', secret: 'read-verb-parity-1416-secret', i18nStrategy: withI18n() })
  const v = await db.openVault('books')
  const c = v.collection<Receipt>('receipts', {
    ...(defaultLocale !== undefined ? { defaultLocale } : {}),
    moneyFields: { wht: money({ currency: 'THB', scale: 2 }) },
    i18nFields: { title: i18nText({ languages: ['en', 'th'], required: 'any' }) },
    lookupFields: { status: dict('status') },
    viaFields: {
      receiptAmount: via(
        computed((r) => (r.unit as number) * (r.qty as number), { deps: ['unit', 'qty'], mode: 'virtual' }),
        money({ currency: 'THB', scale: 2 }),
      ),
    },
  })
  await v.dictionary('status').put('paid', { en: 'Paid', th: 'ชำระแล้ว' })
  await c.put('r1', { id: 'r1', unit: 8471.5, qty: 10, wht: 254.14, status: 'paid', title: { en: 'March invoice', th: 'ใบแจ้งหนี้' } })
  await c.put('r2', { id: 'r2', unit: 100, qty: 3, wht: 9, status: 'paid', title: { en: 'April invoice', th: 'ใบแจ้งหนี้' } })
  return { v, c }
}

/** The property under test, as one reusable assertion. */
function expectSameShape(actual: unknown, expected: unknown, what: string): void {
  const a = actual as Record<string, unknown>
  const e = expected as Record<string, unknown>
  expect(new Set(Object.keys(a)), `${what}: key SET must match get()`).toEqual(new Set(Object.keys(e)))
  expect(a, `${what}: values must match get()`).toEqual(e)
}

describe('read-verb parity — get() / list() / query() return the same record (#1416)', () => {
  it('query().toArray() carries every key get() carries, with the same values', async () => {
    const { c } = await receiptsVault()
    const g = await c.get('r1')
    const l = (await c.list()).find((r) => r.id === 'r1')
    const q = c.query().where('id', '==', 'r1').toArray()[0]

    // The defect that motivated #1416, pinned by value as well as by shape.
    expect((g as Record<string, unknown>).receiptAmount).toBe('84715.00')
    expectSameShape(l, g, 'list()')
    expectSameShape(q, g, 'query().toArray()')
  })

  it('the collection defaultLocale reaches the query path, exactly as it reaches get()', async () => {
    const { c } = await receiptsVault('th')
    const g = await c.get('r1')
    const q = c.query().where('id', '==', 'r1').toArray()[0]
    expectSameShape(q, g, 'query().toArray() @ defaultLocale th')
  })

  it('a per-call locale on toArray() matches the same per-call locale on get()', async () => {
    const { c } = await receiptsVault('en')
    await c.list()
    const g = await c.get('r1', { locale: 'th' })
    const q = c.query().where('id', '==', 'r1').toArray({ locale: 'th' })[0]
    expectSameShape(q, g, "query().toArray({ locale: 'th' })")
  })

  it('every row-returning query terminal agrees with get(): first(), page(), live(), traverse-free toArray()', async () => {
    const { c } = await receiptsVault()
    const g = await c.get('r1')

    expectSameShape(c.query().where('id', '==', 'r1').first(), g, 'first()')
    expectSameShape(c.query().where('id', '==', 'r1').page().rows[0], g, 'page()')

    const live = c.query().where('id', '==', 'r1').live()
    expectSameShape(live.value[0], g, 'live().value')
    live.stop()
  })

  it('ids() is unaffected — it returns identifiers, not rows', async () => {
    const { c } = await receiptsVault()
    expect(c.query().where('id', '==', 'r1').ids()).toEqual(['r1'])
  })

  it('scan() streams the same record shape as get()', async () => {
    const { c } = await receiptsVault()
    const g = await c.get('r1')
    const seen: Record<string, unknown>[] = []
    for await (const rec of c.scan({ pageSize: 10 })) seen.push(rec as Record<string, unknown>)
    const r1 = seen.find((r) => r.id === 'r1')
    expectSameShape(r1, g, 'scan()')
  })
})
