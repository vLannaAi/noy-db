/**
 * Golden snapshot of the `collection.describe()` OUTPUT contract (Phase 3).
 *
 * `describe()` → `CollectionDescription` is the producer-side seam `@noy-db/ui`
 * (and `@noy-db/ui-nuxt`) consume to render schema-driven forms/lists. It has
 * grown organically (money / dict / ref / computed / i18n / sensitivity / widget
 * / editable blocks added incrementally). This test pins the full output shape
 * for a representative collection — money + staticDict + ref + computed + i18n +
 * a sensitive field + a plain field — against an inline expected structure, so
 * the contract `@noy-db/ui` binds via `@noy-db/hub/describe` cannot drift silently.
 *
 * The fixture mirrors the existing `__tests__/introspection/describe.test.ts`
 * fixtures; the inline expectation is the exact `describe()` output (sorted-key,
 * config-only sync path — zero store I/O).
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/noydb.js'
import { money } from '../src/with-shape/money/descriptor.js'
import { staticDict } from '../src/with-shape/i18n/dictionary.js'
import { i18nText } from '../src/with-shape/i18n/core.js'
import { ref } from '../src/refs.js'
import { withI18n } from '../src/with-shape/i18n/active.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/types.js'
import type { CollectionDescription } from '@noy-db/hub/describe'
import { ConflictError } from '../src/errors.js'

function inlineMemory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function gc(c: string, col: string) {
    let comp = store.get(c); if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col); if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    async get(c, col, id) { return store.get(c)?.get(col)?.get(id) ?? null },
    async put(c, col, id, env, ev) { const coll = gc(c, col); const ex = coll.get(id); if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v); coll.set(id, env) },
    async delete(c, col, id) { store.get(c)?.get(col)?.delete(id) },
    async list(c, col) { const coll = store.get(c)?.get(col); return coll ? [...coll.keys()] : [] },
    async loadAll(c) { const comp = store.get(c); const s: VaultSnapshot = {}; if (comp) for (const [n, coll] of comp) if (!n.startsWith('_')) { const r: Record<string, EncryptedEnvelope> = {}; for (const [id, e] of coll) r[id] = e; s[n] = r } return s },
    async saveAll(c, data) { for (const [n, recs] of Object.entries(data)) { const coll = gc(c, n); for (const [id, e] of Object.entries(recs)) coll.set(id, e) } },
  }
}

describe('collection.describe() — output contract snapshot', () => {
  it('pins the CollectionDescription shape for a representative schema', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'alice', secret: 'pw-contract', i18nStrategy: withI18n() })
    const v = await db.openVault('v')

    const invoiceStatus = staticDict('invoiceStatus', {
      draft: { en: 'Draft' }, sent: { en: 'Sent' }, paid: { en: 'Paid' },
    }, { displayLocale: 'en' })

    const invoices = v.collection('invoices', {
      moneyFields: { amount: money({ currency: 'EUR' }) },
      dictKeyFields: { status: invoiceStatus },
      refs: { customerId: ref('customers') },
      computed: { tax: () => 0 },
      i18nFields: { title: i18nText({ languages: ['en', 'th'], required: 'all', densifyOnWrite: false }) },
      fieldMeta: {
        note: { label: 'Note' },
        ssn: { label: 'SSN', sensitivity: 'secret' },
      },
    })

    const expected: CollectionDescription = {
      collection: 'invoices',
      fields: [
        {
          key: 'amount', type: 'number', optional: false, label: 'Amount',
          semanticType: 'currency', aggregate: 'sum',
          money: { mode: 'fixed', currency: 'EUR', scale: 2 },
          widget: 'money', editable: true,
        },
        {
          key: 'customerId', type: 'string', optional: false, label: 'Customer Id',
          semanticType: 'entity', ref: { target: 'customers', mode: 'strict' },
          widget: 'ref-select', editable: true,
        },
        {
          key: 'note', type: 'unknown', optional: false, label: 'Note',
          widget: 'text', editable: true,
        },
        {
          key: 'ssn', type: 'unknown', optional: false, label: 'SSN',
          sensitivity: 'secret', widget: 'text', editable: true,
        },
        {
          key: 'status', type: 'enum', optional: false, label: 'Status',
          dict: {
            name: 'invoiceStatus', static: true,
            values: [
              { value: 'draft', label: 'Draft' },
              { value: 'sent', label: 'Sent' },
              { value: 'paid', label: 'Paid' },
            ],
          },
          widget: 'select', editable: true,
        },
        {
          key: 'tax', type: 'unknown', optional: false, label: 'Tax',
          computed: true, widget: 'text', editable: false,
        },
        {
          key: 'title', type: 'string', optional: false, label: 'Title',
          i18n: { locales: ['en', 'th'], densify: false },
          widget: 'text', editable: true,
        },
      ],
      meta: { label: 'Invoices' },
    }

    expect(invoices.describe()).toEqual(expected)
  })
})
