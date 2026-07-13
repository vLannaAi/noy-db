/**
 * #671 items 1-3 — three construction-frozen `Collection` read-side residuals a late-attach (a
 * SECOND-OR-LATER `vault.collection()` call on an already-open collection) used to leave stale:
 *
 *  1. `getDictionary` (private, captured once at construction) — `describe({resolveDictLabels:
 *     true})` and the search-index label pre-computation can't resolve a late-attached
 *     dict-backed field's labels, since the callback stays `undefined` forever once the
 *     collection was first opened bare.
 *  2. `describe()`'s legacy top-level `dictKeyFields`/`i18nFields`/`lookupFields` KEY LISTS
 *     (`this.dictKeyFields`/`this.i18nFields`/`this.lookupFields`, set only at construction) feed
 *     `buildDescription`'s field-list/widget derivation — a late-attached field's PER-FIELD
 *     `describeFragment` is already correct (reads live off `_via.bindings`), but it stays absent
 *     from these separately-frozen legacy lists.
 *  3. `presentForJoin` (built once at construction over construction-time i18n/lookup fields,
 *     `undefined` when neither family was present yet) — a late-attached i18n/lookup field on a
 *     join TARGET collection never dresses through `querySourceForJoin()`'s join path.
 *
 * `Collection._reconcileReadState` (the ONE writer seam, mirroring `_setVia`) + the
 * `_viaFieldsSnapshot` reader close all three; see `kernel/via/reconcile.ts`'s
 * `reconcileCollectionReadState`.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../../src/index.js'
import { withI18n } from '../../src/via/i18n/index.js'
import { i18nText } from '../../src/via/i18n/core.js'
import { dictKey } from '../../src/via/i18n/dictionary.js'
import { enumOf } from '../../src/via/lookup/descriptor.js'
import { ref } from '../../src/kernel/refs.js'
import { inlineMemory } from '../classified/harness.js'

interface Worker extends Record<string, unknown> { id: string; priority?: string }
interface Ticket extends Record<string, unknown> { id: string; status?: string }
interface Category extends Record<string, unknown> { id: string; name?: Record<string, string> }
interface Product extends Record<string, unknown> { id: string; categoryId: string }

const NAME = i18nText({ languages: ['en', 'th'], required: 'all' })

describe('#671 items 1-3 — late-attach reconcile refreshes construction-frozen read-state', () => {
  it('item 1: getDictionary — a late-attached dynamic dictKey field resolves labels via describe({resolveDictLabels:true})', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'alice', secret: 'pw-reconcile-readstate-1', i18nStrategy: withI18n() })
    const vault = await db.openVault('rs1')

    const first = vault.collection<Worker>('workers', {})
    await vault.dictionary('priority').putAll({ hi: { en: 'High' }, lo: { en: 'Low' } })

    // Late-attach on a SECOND vault.collection() call — same instance, reconciled.
    const second = vault.collection<Worker>('workers', {
      dictKeyFields: { priority: dictKey('priority') },
    })
    expect(second).toBe(first)

    const d = await second.describe({ resolveDictLabels: true })
    const p = d.fields.find((f) => f.key === 'priority')!
    expect(p.dict?.values).toEqual(expect.arrayContaining([
      { value: 'hi', label: 'High' },
      { value: 'lo', label: 'Low' },
    ]))
  })

  it('item 2: describe() legacy lists — a late-attached lookup field is included, deep-equal to the same declaration made fresh', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'alice', secret: 'pw-reconcile-readstate-2', i18nStrategy: withI18n() })
    const vault = await db.openVault('rs2')

    const bare = vault.collection<Ticket>('tickets_late', {})
    const late = vault.collection<Ticket>('tickets_late', {
      lookupFields: { status: enumOf(['open', 'closed']) },
    })
    expect(late).toBe(bare)

    const fresh = vault.collection<Ticket>('tickets_fresh', {
      lookupFields: { status: enumOf(['open', 'closed']) },
    })

    expect(late.describe().fields).toEqual(fresh.describe().fields)
  })

  it('item 3: presentForJoin — a late-attached i18n field on a join TARGET dresses through the join path exactly like a fresh declaration', async () => {
    const db = await createNoydb({ store: inlineMemory(), user: 'alice', secret: 'pw-reconcile-readstate-3', i18nStrategy: withI18n() })
    const vault = await db.openVault('rs3')

    // Join target opened bare FIRST — the products ref is declared before categories gets its
    // i18nFields, mirroring the MV-auto-create-then-declare ordering #671 targets.
    const categories = vault.collection<Category>('categories3', {})
    const products = vault.collection<Product>('products3', { refs: { categoryId: ref('categories3') } })

    const categoriesLate = vault.collection<Category>('categories3', {
      i18nFields: { name: NAME },
    })
    expect(categoriesLate).toBe(categories)

    await categories.put('c1', { id: 'c1', name: { en: 'Food', th: 'อาหาร' } })
    await products.put('p1', { id: 'p1', categoryId: 'c1' })

    const rows = products.query().join('categoryId', { as: 'category' }).toArray({ locale: 'th' }) as Array<Product & { category: Category }>
    expect(rows[0]!.category.name).toBe('อาหาร')
  })
})
