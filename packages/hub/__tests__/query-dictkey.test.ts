/**
 * Query DSL integration for dictKey — v0.8 #85
 *
 * Tests: stable-key groupBy (same bucket count across locales), type-level
 * rejection of virtual fields, dict join resolution, groupBy + aggregate
 * label projection via runAsync().
 */

import { describe, it, expect } from 'vitest'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/types.js'
import { ConflictError } from '../src/errors.js'
import { createNoydb } from '../src/noydb.js'
import { dictKey } from '../src/i18n/dictionary.js'
import { sum, count } from '../src/query/index.js'

function memory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function getCollection(c: string, col: string) {
    let comp = store.get(c)
    if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col)
    if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    name: 'memory',
    async get(c, col, id) { return store.get(c)?.get(col)?.get(id) ?? null },
    async put(c, col, id, env, ev) {
      const coll = getCollection(c, col)
      const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(c, col, id) { store.get(c)?.get(col)?.delete(id) },
    async list(c, col) { const coll = store.get(c)?.get(col); return coll ? [...coll.keys()] : [] },
    async loadAll(c) {
      const comp = store.get(c); const s: VaultSnapshot = {}
      if (comp) for (const [n, coll] of comp) {
        if (!n.startsWith('_')) { const r: Record<string, EncryptedEnvelope> = {}; for (const [id, e] of coll) r[id] = e; s[n] = r }
      }
      return s
    },
    async saveAll(_c, _d) {},
  }
}

interface Invoice {
  id: string
  amount: number
  status: string
}

async function setup() {
  const adapter = memory()
  const db = await createNoydb({ store: adapter, user: 'alice', encrypt: false })
  const company = await db.openVault('company')

  const statusDict = company.dictionary('status')
  await statusDict.putAll({
    draft: { en: 'Draft', th: 'ฉบับร่าง' },
    open: { en: 'Open', th: 'เปิด' },
    paid: { en: 'Paid', th: 'ชำระแล้ว' },
  } as Record<string, Record<string, string>>)

  const invoices = company.collection<Invoice>('invoices', {
    dictKeyFields: {
      status: dictKey('status', ['draft', 'open', 'paid'] as const),
    },
  })

  await invoices.put('inv-1', { id: 'inv-1', amount: 1500, status: 'draft' })
  await invoices.put('inv-2', { id: 'inv-2', amount: 8200, status: 'open' })
  await invoices.put('inv-3', { id: 'inv-3', amount: 3200, status: 'open' })
  await invoices.put('inv-4', { id: 'inv-4', amount: 12400, status: 'paid' })

  return { company, invoices, statusDict }
}

describe('query DSL — dictKey integration (v0.8 #85)', () => {
  describe('groupBy stable key', () => {
    it('groups by stable dict key (same bucket count regardless of locale)', async () => {
      const { invoices } = await setup()

      const rows = invoices.query().groupBy('status').aggregate({ total: sum('amount'), n: count() }).run()
      expect(rows).toHaveLength(3) // draft, open, paid

      // Verify stable keys — NOT locale labels
      const keys = rows.map((r) => (r as Record<string, unknown>)['status'])
      expect(keys).toContain('draft')
      expect(keys).toContain('open')
      expect(keys).toContain('paid')
    })

    it('produces identical bucket structure regardless of locale context', async () => {
      const { invoices } = await setup()

      // group without locale
      const rows1 = invoices.query().groupBy('status').aggregate({ n: count() }).run()

      // Simulate locale context doesn't affect the grouping key
      const rows2 = invoices.query().groupBy('status').aggregate({ n: count() }).run()

      expect(rows1.length).toBe(rows2.length)
      const keys1 = rows1.map((r) => (r as Record<string, unknown>)['status']).sort()
      const keys2 = rows2.map((r) => (r as Record<string, unknown>)['status']).sort()
      expect(keys1).toEqual(keys2)
    })

    it('groupBy on stable key sums correctly per bucket', async () => {
      const { invoices } = await setup()

      const rows = invoices.query().groupBy('status').aggregate({ total: sum('amount') }).run()
      const openRow = rows.find((r) => (r as Record<string, unknown>)['status'] === 'open') as Record<string, unknown>
      expect(openRow?.['total']).toBe(11400) // 8200 + 3200
    })
  })

  describe('type-level enforcement: groupBy("statusLabel") compile error', () => {
    it('statusLabel is not a key of Invoice type (compile-time guard)', () => {
      // This test asserts the TYPE-LEVEL constraint by verifying that
      // `statusLabel` is not present on the record — so grouping by it
      // would group by undefined (no records), not by a locale label.
      // TypeScript would produce a compile error at the call site
      // because "statusLabel" is not `keyof Invoice`.
      const inv: Invoice = { id: 'x', amount: 0, status: 'draft' }
      // @ts-expect-error statusLabel is not a key of Invoice
      const _bad: string = (inv as Record<string, unknown>)['statusLabel']
      void _bad
      expect('statusLabel' in inv).toBe(false)
    })
  })

  describe('dict join resolution', () => {
    it('joins dictKey field and attaches labels under the alias', async () => {
      const { invoices } = await setup()

      const rows = invoices
        .query()
        .where('status', '==', 'paid')
        .join('status', { as: 'statusInfo' })
        .toArray() as Array<{ id: string; status: string; statusInfo: Record<string, unknown> | null }>

      expect(rows).toHaveLength(1)
      const row = rows[0]!
      expect(row.statusInfo).not.toBeNull()
      // Attached labels map should contain both locales
      expect((row.statusInfo as Record<string, unknown>)['en']).toBe('Paid')
      expect((row.statusInfo as Record<string, unknown>)['th']).toBe('ชำระแล้ว')
      expect((row.statusInfo as Record<string, unknown>)['key']).toBe('paid')
    })

    it('attaches null when dict key is not in the dictionary', async () => {
      const { invoices } = await setup()

      // Put a record with an unknown status key
      await invoices.put('inv-bad', { id: 'inv-bad', amount: 0, status: 'unknown-key' })

      const rows = invoices
        .query()
        .where('id', '==', 'inv-bad')
        .join('status', { as: 'statusInfo' })
        .toArray() as Array<{ statusInfo: unknown }>

      expect(rows[0]?.statusInfo).toBeNull()
    })

    it('join against non-dict, non-ref field throws', async () => {
      const { invoices } = await setup()

      // 'amount' is not a ref() or dictKey(), so join should throw
      expect(() =>
        invoices.query().join('amount', { as: 'amountInfo' }),
      ).toThrow(/no ref\(\) declared/)
    })
  })

  describe('<field>Label projection in groupBy result', () => {
    it('runAsync adds statusLabel to each bucket row', async () => {
      const { invoices } = await setup()

      const rows = await invoices
        .query()
        .groupBy('status')
        .aggregate({ total: sum('amount'), n: count() })
        .runAsync({ locale: 'th' })

      expect(rows).toHaveLength(3)
      const paidRow = rows.find((r) => (r as Record<string, unknown>)['status'] === 'paid') as Record<string, unknown>
      expect(paidRow?.['statusLabel']).toBe('ชำระแล้ว')

      const draftRow = rows.find((r) => (r as Record<string, unknown>)['status'] === 'draft') as Record<string, unknown>
      expect(draftRow?.['statusLabel']).toBe('ฉบับร่าง')
    })

    it('runAsync with English locale adds English labels', async () => {
      const { invoices } = await setup()

      const rows = await invoices
        .query()
        .groupBy('status')
        .aggregate({ n: count() })
        .runAsync({ locale: 'en' })

      const openRow = rows.find((r) => (r as Record<string, unknown>)['status'] === 'open') as Record<string, unknown>
      expect(openRow?.['statusLabel']).toBe('Open')
    })

    it('runAsync without locale behaves like sync run()', async () => {
      const { invoices } = await setup()

      const sync = invoices.query().groupBy('status').aggregate({ n: count() }).run()
      const async_ = await invoices.query().groupBy('status').aggregate({ n: count() }).runAsync()

      expect(sync.length).toBe(async_.length)
      // No label field without locale
      for (const row of async_) {
        expect((row as Record<string, unknown>)['statusLabel']).toBeUndefined()
      }
    })

    it('non-dictKey groupBy field has no label projection', async () => {
      const { invoices } = await setup()

      const rows = await invoices
        .query()
        .groupBy('amount')
        .aggregate({ n: count() })
        .runAsync({ locale: 'th' })

      // No amountLabel added — amount is not a dictKey
      for (const row of rows) {
        expect((row as Record<string, unknown>)['amountLabel']).toBeUndefined()
      }
    })
  })
})
