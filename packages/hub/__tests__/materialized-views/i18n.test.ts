/**
 * i18n per-layer resolution for materialized views (#285 MV slice).
 *  §1 display  — MVs preserve raw i18n maps; declare the field on the OUTPUT
 *                collection → resolves per-reader at read time (no engine change).
 *  §2 compute  — UNION MV `i18nLocale` + `i18nFields` resolve group-key i18n
 *                fields at the `mv` layer BEFORE bucketing → stable buckets.
 *  guard       — grouping by a raw i18n field without `i18nLocale` throws.
 *  registration— i18nLocale/i18nFields are UNION-only (query-form throws).
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, withMaterializedView } from '../../src/index.js'
import { withAggregate } from '../../src/with-lookup/aggregate/index.js'
import { sum, count } from '../../src/with-lookup/aggregate/reducers.js'
import { i18nText } from '../../src/with-shape/i18n/core.js'
import { withI18n } from '../../src/with-shape/i18n/index.js'
import { LocaleNotSpecifiedError, MaterializedViewConfigError } from '../../src/kernel/errors.js'
import type { NoydbStore, EncryptedEnvelope } from '../../src/kernel/types.js'

function memory(): NoydbStore {
  const data = new Map<string, EncryptedEnvelope>()
  const k = (v: string, c: string, i: string) => `${v}/${c}/${i}`
  return {
    capabilities: { casAtomic: true, auth: { kind: 'none', required: false, flow: 'static' } },
    async get(v, c, i) { return data.get(k(v, c, i)) ?? null },
    async put(v, c, i, env) { data.set(k(v, c, i), env) },
    async delete(v, c, i) { data.delete(k(v, c, i)) },
    async list(v, c) {
      const prefix = `${v}/${c}/`
      return [...data.keys()].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length))
    },
    async loadAll(v) {
      const out: Record<string, Record<string, EncryptedEnvelope>> = {}
      for (const [key, env] of data) {
        const [vn, cn, id] = key.split('/')
        if (vn === v) { out[cn!] = out[cn!] ?? {}; out[cn!]![id!] = env }
      }
      return out
    },
    async saveAll(v, payload) {
      for (const c of Object.keys(payload)) for (const i of Object.keys(payload[c]!)) data.set(k(v, c, i), payload[c]![i]!)
    },
  }
}

interface Product extends Record<string, unknown> { id: string; category: Record<string, string> }
interface CatCount extends Record<string, unknown> { category: unknown; n: number }
const CATEGORY = i18nText({ languages: ['en', 'th'], required: 'all' })
const SECRET = 'mv-i18n-layer-slice-passphrase-2026'

describe('MV i18n — §2 compute (i18nLocale resolves group keys at the mv layer)', () => {
  it('groups by the resolved i18n label when i18nLocale + i18nFields are declared', async () => {
    const mv = withMaterializedView<CatCount>({
      name: 'catCounts',
      unionSources: [{ collection: 'products', map: (r) => ({ category: r.category, n: 1 }) }],
      groupBy: 'category',
      aggregate: { n: sum('n') },
      i18nLocale: 'en',
      i18nFields: { category: CATEGORY },
      rowKey: (row) => String(row.category),
      refresh: 'manual',
    })
    const db = await createNoydb({ store: memory(), user: 'a', secret: SECRET, materializedViewStrategies: [mv], aggregateStrategy: withAggregate(), i18nStrategy: withI18n() })
    const vault = await db.openVault('v')
    const products = vault.collection<Product>('products', { i18nFields: { category: CATEGORY } })
    await products.put('p1', { id: 'p1', category: { en: 'Food', th: 'อาหาร' } })
    await products.put('p2', { id: 'p2', category: { en: 'Food', th: 'อาหาร' } })
    await products.put('p3', { id: 'p3', category: { en: 'Toys', th: 'ของเล่น' } })

    await vault.refreshView('catCounts')

    const out = vault.collection<CatCount>('catCounts')
    expect((await out.get('Food'))?.n).toBe(2)   // bucketed by the resolved 'en' label
    expect((await out.get('Toys'))?.n).toBe(1)
  })
})

describe('MV i18n — query-form grouping (#285)', () => {
  it('a query-form MV groups by the resolved i18n label when i18nLocale + i18nFields are set', async () => {
    const mv = withMaterializedView<CatCount>({
      name: 'qCatCounts',
      query: (db) => db.collection<Product>('products').query().groupBy('category').aggregate({ n: count() }) as never,
      sources: ['products'],
      i18nLocale: 'en',
      i18nFields: { category: CATEGORY },
      rowKey: (row) => String(row.category),
      refresh: 'manual',
    })
    const db = await createNoydb({ store: memory(), user: 'a', secret: SECRET, materializedViewStrategies: [mv], aggregateStrategy: withAggregate(), i18nStrategy: withI18n() })
    const vault = await db.openVault('v')
    const products = vault.collection<Product>('products', { i18nFields: { category: CATEGORY } })
    await products.put('p1', { id: 'p1', category: { en: 'Food', th: 'อาหาร' } })
    await products.put('p2', { id: 'p2', category: { en: 'Food', th: 'อาหาร' } })
    await products.put('p3', { id: 'p3', category: { en: 'Toys', th: 'ของเล่น' } })

    await vault.refreshView('qCatCounts')

    const out = vault.collection<CatCount>('qCatCounts')
    expect((await out.get('Food'))?.n).toBe(2)
    expect((await out.get('Toys'))?.n).toBe(1)
  })
})

describe('MV i18n — guard (grouping a raw i18n field without a locale)', () => {
  it('throws LocaleNotSpecifiedError rather than bucketing on a raw locale map', async () => {
    const mv = withMaterializedView<CatCount>({
      name: 'badCounts',
      unionSources: [{ collection: 'products', map: (r) => ({ category: r.category, n: 1 }) }],
      groupBy: 'category',
      aggregate: { n: sum('n') },
      rowKey: (row) => String(row.category),
      refresh: 'manual',
    })
    const db = await createNoydb({ store: memory(), user: 'a', secret: SECRET, materializedViewStrategies: [mv], aggregateStrategy: withAggregate(), i18nStrategy: withI18n() })
    const vault = await db.openVault('v')
    const products = vault.collection<Product>('products', { i18nFields: { category: CATEGORY } })
    await products.put('p1', { id: 'p1', category: { en: 'Food', th: 'อาหาร' } })

    await expect(vault.refreshView('badCounts')).rejects.toBeInstanceOf(LocaleNotSpecifiedError)
  })
})

describe('MV i18n — §1 display (resolve-at-output)', () => {
  it('preserves the raw i18n map through the MV; the OUTPUT collection resolves per-reader', async () => {
    interface Label extends Record<string, unknown> { id: string; label: Record<string, string> }
    const mv = withMaterializedView<Label>({
      name: 'productLabels',
      unionSources: [{ collection: 'products', map: (r) => ({ id: r.id as string, label: r.category as Record<string, string> }) }],
      rowKey: (row) => row.id,
      refresh: 'manual',
    })
    const db = await createNoydb({ store: memory(), user: 'a', secret: SECRET, materializedViewStrategies: [mv], aggregateStrategy: withAggregate(), i18nStrategy: withI18n() })
    const vault = await db.openVault('v')
    const products = vault.collection<Product>('products', { i18nFields: { category: CATEGORY } })
    // Declare the i18n field on the OUTPUT collection → read-time resolution.
    vault.collection<Label>('productLabels', { i18nFields: { label: CATEGORY } })
    await products.put('p1', { id: 'p1', category: { en: 'Food', th: 'อาหาร' } })

    await vault.refreshView('productLabels')

    const out = vault.collection<Label>('productLabels')
    expect((await out.get('p1', { locale: 'en' }))?.label).toBe('Food')
    expect((await out.get('p1', { locale: 'th' }))?.label).toBe('อาหาร')
    expect((await out.get('p1'))?.label).toEqual({ en: 'Food', th: 'อาหาร' }) // locale-less → raw map preserved
  })
})

describe('MV i18n — registration', () => {
  it('rejects i18nLocale without i18nFields (nothing to resolve)', () => {
    expect(() =>
      withMaterializedView<CatCount>({
        name: 'q',
        query: (db) => db.collection<CatCount>('products').query() as never,
        i18nLocale: 'en',
        rowKey: (row) => String(row.category),
        refresh: 'manual',
      }),
    ).toThrow(MaterializedViewConfigError)
  })

  it('allows i18nLocale + i18nFields on a query-form MV (#285 query-form grouping)', () => {
    expect(() =>
      withMaterializedView<CatCount>({
        name: 'q2',
        query: (db) => db.collection<CatCount>('products').query() as never,
        i18nLocale: 'en',
        i18nFields: { category: CATEGORY },
        rowKey: (row) => String(row.category),
        refresh: 'manual',
      }),
    ).not.toThrow()
  })
})
