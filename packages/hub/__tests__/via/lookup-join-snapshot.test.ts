/**
 * The sync lookup snapshot + locale seam (#650 Task 6, spec §5) — the
 * combined seam that serves join dressing (`presentForJoin`), dimension
 * sort (`compareForOrder`), and #626's retirement (`join.ts` no longer
 * imports `shape/via-i18n/core.js`; see `via-guards-empty.test.ts` for
 * the guard-level proof).
 *
 * RED (pre-Task-6): `JoinableSource` had no `presentForJoin` hook — a
 * lookup field's `<field>Label` never dressed a joined right-side record,
 * and a plain (non-`{by:'label'}`) `orderBy()` on a `sortBy`-declared
 * lookup field always sorted by the raw stored code (`ViaBinding.
 * compareForOrder` was undeclared on the `'lookup'` binding). GREEN: both
 * now work, while every pre-existing dict/i18n join + label-sort path
 * (parity fixtures below) stays byte-identical.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../../src/kernel/noydb.js'
import { withI18n } from '../../src/shape/via-i18n/index.js'
import { i18nText } from '../../src/shape/via-i18n/core.js'
import { lookup, dict } from '../../src/shape/via-lookup/descriptor.js'
import { buildLookupSnapshot } from '../../src/shape/via-lookup/snapshot.js'
import { ref } from '../../src/kernel/refs.js'
import { ConflictError } from '../../src/kernel/errors.js'
import type { Noydb } from '../../src/kernel/noydb.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../../src/kernel/types.js'

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

async function freshDb(): Promise<Noydb> {
  return createNoydb({ store: memory(), user: 'a', secret: 'lookup-join-snapshot-pass-2026', i18nStrategy: withI18n() })
}

const NAME = i18nText({ languages: ['en', 'th'], required: 'all' })

interface Category extends Record<string, unknown> { id: string; name: Record<string, string>; tier: string }
interface Product extends Record<string, unknown> { id: string; categoryId: string }

describe('presentForJoin — combined i18n + lookup-label join dressing (#650 Task 6, #626 retirement)', () => {
  async function seed() {
    const db = await freshDb()
    const vault = await db.openVault('v')
    const categories = vault.collection<Category>('categories', {
      i18nFields: { name: NAME },
      lookupFields: { tier: lookup('tier-dim', { backing: 'reserved', present: { label: 'labels', by: 'locale' } }) },
    })
    const products = vault.collection<Product>('products', { refs: { categoryId: ref('categories') } })
    await vault.dictionary('tier-dim').putAll({
      std: { en: 'Standard', th: 'มาตรฐาน' },
      prem: { en: 'Premium', th: 'พรีเมียม' },
    })
    await categories.put('c1', { id: 'c1', name: { en: 'Food', th: 'อาหาร' }, tier: 'prem' })
    await products.put('p1', { id: 'p1', categoryId: 'c1' })
    return { products }
  }

  it('dresses the joined i18n field AND the joined lookup <field>Label at the query locale (nested-loop)', async () => {
    const { products } = await seed()
    const rows = products.query().join('categoryId', { as: 'category' }).toArray({ locale: 'th' }) as Array<Product & { category: Category & { tierLabel?: string } }>
    expect(rows[0]!.category.name).toBe('อาหาร')
    expect(rows[0]!.category.tierLabel).toBe('พรีเมียม')
  })

  it('same dressing via the hash-join strategy', async () => {
    const { products } = await seed()
    const rows = products.query().join('categoryId', { as: 'category', strategy: 'hash' }).toArray({ locale: 'en' }) as Array<Product & { category: Category & { tierLabel?: string } }>
    expect(rows[0]!.category.name).toBe('Food')
    expect(rows[0]!.category.tierLabel).toBe('Premium')
  })

  it('leaves both the i18n field AND the lookup label RAW/absent when the query is locale-less', async () => {
    const { products } = await seed()
    const rows = products.query().join('categoryId', { as: 'category' }).toArray() as Array<Product & { category: Category & { tierLabel?: string } }>
    expect(rows[0]!.category.name).toEqual({ en: 'Food', th: 'อาหาร' })
    expect(rows[0]!.category.tierLabel).toBeUndefined()
  })
})

describe('dict-join leg parity — unaffected by the presentForJoin wiring (#650 Task 6)', () => {
  interface Invoice extends Record<string, unknown> { id: string; status: string }

  it('joining a reserved dict()-sugar field still attaches the full multi-locale labels object (byte-identical to the dictKey() dict-join leg)', async () => {
    const db = await freshDb()
    const vault = await db.openVault('v')
    const invoices = vault.collection<Invoice>('invoices', { lookupFields: { status: dict('status') } })
    await vault.dictionary('status').putAll({
      draft: { en: 'Draft', th: 'ฉบับร่าง' },
      paid: { en: 'Paid', th: 'ชำระแล้ว' },
    })
    await invoices.put('inv-1', { id: 'inv-1', status: 'paid' })

    const rows = invoices.query().where('status', '==', 'paid').join('status', { as: 'statusInfo' }).toArray() as Array<{ statusInfo: Record<string, unknown> | null }>
    expect(rows[0]!.statusInfo).not.toBeNull()
    expect((rows[0]!.statusInfo as Record<string, unknown>)['key']).toBe('paid')
    expect((rows[0]!.statusInfo as Record<string, unknown>)['en']).toBe('Paid')
    expect((rows[0]!.statusInfo as Record<string, unknown>)['th']).toBe('ชำระแล้ว')
  })
})

describe('orderBy({by:"label"}) parity — reserved-tier lookup fields (byte-identical ordering to query-dictkey-label-sort.test.ts)', () => {
  interface Row extends Record<string, unknown> { id: string; cat: string }

  it('sorts by the resolved label at the query locale, not the stored code', async () => {
    const db = await freshDb()
    const vault = await db.openVault('v')
    const rows = vault.collection<Row>('rows', { lookupFields: { cat: dict('cat2') } })
    // Codes 'a1'/'z1' deliberately sort OPPOSITE to their en labels — same
    // fixture shape as query-dictkey-label-sort.test.ts's staticDict pin.
    await vault.dictionary('cat2').putAll({
      a1: { en: 'Zebra', th: 'ม้าลาย' },
      z1: { en: 'Apple', th: 'แอปเปิล' },
    })
    await rows.put('r-a', { id: 'r-a', cat: 'a1' })
    await rows.put('r-z', { id: 'r-z', cat: 'z1' })

    const byCode = rows.query().orderBy('cat', 'asc').toArray()
    expect(byCode.map((r) => r.id)).toEqual(['r-a', 'r-z']) // a1 < z1

    const byLabel = rows.query().orderBy('cat', 'asc', { by: 'label' }).toArray({ locale: 'en' })
    expect(byLabel.map((r) => r.id)).toEqual(['r-z', 'r-a']) // Apple(z1) < Zebra(a1)
  })
})

describe('compareForOrder — plain orderBy on a sortBy-declared reserved lookup field (#650 Task 6, NEW capability)', () => {
  interface Row extends Record<string, unknown> { id: string; rank: string }

  it('a sortBy-declared field sorts by its resolved label even WITHOUT {by:"label"}, via the binding closure over the sync snapshot', async () => {
    const db = await freshDb()
    const vault = await db.openVault('v')
    const rows = vault.collection<Row>('rows3', {
      lookupFields: {
        rank: lookup('rank-dim', {
          backing: 'reserved',
          sortBy: 'labels',
          present: { label: 'labels', by: 'locale' },
          displayLocale: 'en',
        }),
      },
    })
    // Codes 'zzz'/'aaa' deliberately sort OPPOSITE to their en labels.
    await vault.dictionary('rank-dim').putAll({ zzz: { en: 'Alpha' }, aaa: { en: 'Zulu' } })
    await rows.put('r1', { id: 'r1', rank: 'zzz' })
    await rows.put('r2', { id: 'r2', rank: 'aaa' })

    // No {by:'label'}, no per-call locale — compareForOrder closes over
    // the descriptor's own displayLocale ('en'), NOT builder.ts's labelMaps.
    const out = rows.query().orderBy('rank', 'asc').toArray()
    expect(out.map((r) => r.id)).toEqual(['r1', 'r2']) // Alpha(zzz) < Zulu(aaa)
  })

  it('a lookup field with NO declared sortBy keeps sorting by the raw code (opt-in, no behavior change)', async () => {
    const db = await freshDb()
    const vault = await db.openVault('v')
    const rows = vault.collection<Row>('rows4', {
      lookupFields: { rank: dict('rank-dim2') },
    })
    await vault.dictionary('rank-dim2').putAll({ zzz: { en: 'Alpha' }, aaa: { en: 'Zulu' } })
    await rows.put('r1', { id: 'r1', rank: 'zzz' })
    await rows.put('r2', { id: 'r2', rank: 'aaa' })

    const out = rows.query().orderBy('rank', 'asc').toArray()
    expect(out.map((r) => r.id)).toEqual(['r2', 'r1']) // aaa < zzz — raw code order, unaffected
  })

  // Was 'matrix-tier sortBy gracefully falls back to code-order' — pinned Task 6's deferred gap
  // (compareForOrder had no matrix-tier route yet, so a plain orderBy() always fell back to raw
  // code order). #650 Task 7 closed that gap (registry.ts's buildLookupSnapshotRows now routes
  // the matrix tier too), but this test kept passing anyway: its old fixture ('United States'/
  // 'Thailand') happens to alphabetize the SAME way its codes do ('TH' < 'US' either by code or by
  // name), so the assertion below never actually observed the new behavior — coincidentally green
  // for the wrong reason. Docs-audit fix wave: re-pin the CURRENT (now-functional) behavior with a
  // fixture whose names deliberately sort OPPOSITE to their codes, so a code-order regression
  // would fail this test again.
  it('matrix-tier sortBy now resolves via the sync snapshot — sorts by label, not raw code (#650 Task 7)', async () => {
    const db = await freshDb()
    const vault = await db.openVault('v')
    const countries = vault.collection<{ id: string; name: string } & Record<string, unknown>>('countries', {})
    // Raw code order is 'TH' < 'US'; names are chosen so label order is the OPPOSITE ('Argentina'
    // < 'Zimbabwe' puts US first) — proves a genuine label sort, not a coincidental code match.
    await countries.put('US', { id: 'US', name: 'Argentina' })
    await countries.put('TH', { id: 'TH', name: 'Zimbabwe' })
    const orders = vault.collection<{ id: string; country: string } & Record<string, unknown>>('orders-matrix', {
      lookupFields: { country: lookup('countries', { present: { label: 'name' }, sortBy: 'name' }) },
    })
    await orders.put('o1', { id: 'o1', country: 'US' })
    await orders.put('o2', { id: 'o2', country: 'TH' })

    const out = orders.query().orderBy('country', 'asc').toArray()
    expect(out.map((r) => r.id)).toEqual(['o1', 'o2']) // Argentina(US) < Zimbabwe(TH) — label order, opposite of raw code order (TH<US)
  })
})

describe('buildLookupSnapshot (pure, #650 Task 6)', () => {
  it('row()/label()/compareKeys() resolve against already-materialized rows', () => {
    const desc = lookup('countries', { key: 'iso2', present: { label: 'name', by: 'locale' }, sortBy: 'name' })
    const rows = new Map<string, Record<string, unknown>>([
      ['US', { iso2: 'US', name: { en: 'United States', th: 'สหรัฐอเมริกา' } }],
      ['TH', { iso2: 'TH', name: { en: 'Thailand', th: 'ประเทศไทย' } }],
    ])
    const snap = buildLookupSnapshot('countries', rows, desc)

    expect(snap.row('US')?.['iso2']).toBe('US')
    expect(snap.row('ZZ')).toBeUndefined()
    expect(snap.label('US', 'en')).toBe('United States')
    expect(snap.label('TH', 'th')).toBe('ประเทศไทย')
    expect(snap.label('ZZ', 'en')).toBeUndefined()
    // 'Thailand' < 'United States' (English alpha order) — opposite of the
    // iso2 codes' own order ('TH' > 'US') — proves compareKeys sorts by the
    // resolved label, not the raw key.
    expect(snap.compareKeys('US', 'TH', 'en')).toBeGreaterThan(0)
    expect(snap.compareKeys('TH', 'US', 'en')).toBeLessThan(0)
    // An unresolvable key never throws — degrades to comparing the raw keys.
    expect(() => snap.compareKeys('ZZ', 'US', 'en')).not.toThrow()
  })
})
