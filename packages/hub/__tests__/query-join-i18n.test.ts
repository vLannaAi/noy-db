/**
 * #285 §3 — join-layer i18n resolution. A `.join()` to a collection with an
 * i18nText field resolves that field at the `join` layer to the query locale
 * (per-call `toArray({locale})` or the vault default); locale-less → raw map.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../src/noydb.js'
import { ConflictError } from '../src/errors.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/types.js'
import { ref } from '../src/refs.js'
import { i18nText } from '../src/with-shape/i18n/core.js'
import { withI18n } from '../src/with-shape/i18n/index.js'

function memory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function gc(c: string, col: string) {
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
      if (comp) for (const [n, coll] of comp) if (!n.startsWith('_')) {
        const r: Record<string, EncryptedEnvelope> = {}; for (const [id, e] of coll) r[id] = e; s[n] = r
      }
      return s
    },
    async saveAll(c, data) { for (const [n, recs] of Object.entries(data)) { const coll = gc(c, n); for (const [id, e] of Object.entries(recs)) coll.set(id, e) } },
  }
}

interface Category extends Record<string, unknown> { id: string; name: Record<string, string> }
interface Product extends Record<string, unknown> { id: string; categoryId: string }
const NAME = i18nText({ languages: ['en', 'th'], required: 'all' })
const SECRET = 'join-i18n-layer-passphrase-2026'

async function seed(vaultLocale?: string) {
  const db = await createNoydb({ store: memory(), user: 'a', secret: SECRET, i18nStrategy: withI18n() })
  const vault = await db.openVault('v', vaultLocale ? { locale: vaultLocale } : {})
  const categories = vault.collection<Category>('categories', { i18nFields: { name: NAME } })
  const products = vault.collection<Product>('products', { refs: { categoryId: ref('categories') } })
  await categories.put('c1', { id: 'c1', name: { en: 'Food', th: 'อาหาร' } })
  await products.put('p1', { id: 'p1', categoryId: 'c1' })
  return { products }
}

describe('#285 §3 — join-layer i18n resolution', () => {
  it('resolves a joined i18n field at the per-call locale (nested-loop)', async () => {
    const { products } = await seed()
    const rows = products.query().join('categoryId', { as: 'category' }).toArray({ locale: 'en' }) as Array<Product & { category: Category }>
    expect(rows[0]!.category.name).toBe('Food')
  })

  it('resolves at the per-call locale via the hash-join path too', async () => {
    const { products } = await seed()
    const rows = products.query().join('categoryId', { as: 'category', strategy: 'hash' }).toArray({ locale: 'th' }) as Array<Product & { category: Category }>
    expect(rows[0]!.category.name).toBe('อาหาร')
  })

  it('leaves the joined i18n field RAW when the query is locale-less', async () => {
    const { products } = await seed()
    const rows = products.query().join('categoryId', { as: 'category' }).toArray() as Array<Product & { category: Category }>
    expect(rows[0]!.category.name).toEqual({ en: 'Food', th: 'อาหาร' })
  })

  it('falls back to the vault default locale when no per-call locale is given', async () => {
    const { products } = await seed('th')
    const rows = products.query().join('categoryId', { as: 'category' }).toArray() as Array<Product & { category: Category }>
    expect(rows[0]!.category.name).toBe('อาหาร')
  })

  it('per-call locale overrides the vault default', async () => {
    const { products } = await seed('th')
    const rows = products.query().join('categoryId', { as: 'category' }).toArray({ locale: 'en' }) as Array<Product & { category: Category }>
    expect(rows[0]!.category.name).toBe('Food')
  })
})
