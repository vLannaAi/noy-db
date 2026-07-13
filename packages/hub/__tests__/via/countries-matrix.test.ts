/**
 * The canonical countries matrix — end-to-end (#650 Task 7, phase D of the
 * Via port, final task). This is the SHIPPED-TESTS-ONLY source of truth for
 * `docs/subsystems/via-lookup.md`'s countries-matrix example: ISO2 canonical
 * key, ISO3/callPrefix altKeys, localized names, sparse dimensions
 * (populate only what's used), extend-on-demand.
 *
 * Covers the brief's Step-1 RED list PLUS the binding-carry-1 "both halves"
 * of matrix-tier sort that Task 6 explicitly deferred (task-6-report.md's
 * Concern #1 — refuted by this task's dispatch: no new vault-resident
 * registry needed, `snapshotFor`/`buildOrderLabelMaps` just needed to accept
 * the descriptor the callers already hold):
 *
 *   (a) `compareForOrder` — a `sortBy`-declared matrix field sorts by its
 *       resolved label even on a PLAIN `orderBy()` (no `{by:'label'}`),
 *       when a `displayLocale` is declared (`registry.ts`'s
 *       `buildLookupSnapshotRows` now routes the matrix tier through
 *       `getCollection(dimension).querySourceForJoin().snapshot()`, keyed
 *       by `descriptor.key` — the SAME mechanism `buildLookupAltIndex`'s
 *       matrix branch already used).
 *   (b) `orderBy(..., {by:'label'})` — the PER-CALL-locale channel
 *       `compareForOrder` structurally cannot serve (no locale param).
 *       `kernel/query/builder.ts`'s `buildOrderLabelMaps` now falls back to
 *       `ViaPipeline.resolveOrderLabel` (new `via.ts`/`via-pipeline.ts`
 *       hook, #650 Task 7) for fields the legacy dict-registry bridge
 *       doesn't cover — proven here by sorting the SAME two countries at
 *       TWO DIFFERENT locales and getting two DIFFERENT orders.
 *   (c) `presentForJoin`'s lookup-label half now dresses a MATRIX-tier
 *       field too (Task 6 only wired reserved tier) — proven via a
 *       three-collection join (shipments -> orders -> countries), with a
 *       non-default `descriptor.key` (`'iso2'`, distinct from the
 *       countries collection's own PUT-id) to prove the new snapshot
 *       machinery keys by `row[descriptor.key]`, not the PUT-id.
 *
 * Also the first-ever `ViaBinding.describeFragment` consumer proof:
 * `describe()`'s `lookup` block is sourced from the binding's fragment
 * (`with-shape/introspection/describe.ts`), not from raw config — see that
 * test's own comment for why its passing IS the wiring proof.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../../src/kernel/noydb.js'
import { withI18n } from '../../src/via/i18n/index.js'
import { lookup, enumOf } from '../../src/via/lookup/descriptor.js'
import { ref } from '../../src/kernel/refs.js'
import { UnknownLookupKeyError, ConflictError } from '../../src/kernel/errors.js'
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
  return createNoydb({ store: memory(), user: 'a', secret: 'countries-matrix-pass-2026', i18nStrategy: withI18n() })
}

interface CountryRow extends Record<string, unknown> {
  id: string
  iso2: string
  iso3: string
  callPrefix: string
  /** locale -> localized country name */
  name: Record<string, string>
}
interface OrderRow extends Record<string, unknown> { id: string; country: string }
interface ShipmentRow extends Record<string, unknown> { id: string; orderId: string }

/**
 * The canonical descriptor — ISO2 canonical key (deliberately NOT the
 * backing collection's own PUT-id, see `putCountry` below), ISO3/callPrefix
 * altKeys, localized `name` dressing, closed vocabulary. No `displayLocale`
 * — this variant is used by the ingest/vocabulary/sparse/describe/
 * presentForJoin tests, none of which need a locale-less plain `orderBy()`.
 * (Declaring it DOES fire the #650 Task 7 declare-time
 * `warnIfSortByNeedsDisplayLocale` console.warn once per call — expected,
 * not asserted against; see `descriptor.ts`'s doc comment.)
 */
function countryField(opts?: { vocabulary?: 'open' | 'closed' }) {
  return lookup('countries', {
    key: 'iso2',
    altKeys: ['iso3', 'callPrefix'],
    present: { label: 'name', by: 'locale' },
    sortBy: 'name',
    backing: 'collection',
    vocabulary: opts?.vocabulary ?? 'closed',
  })
}

/** Puts one country row — PUT-id is `row-<iso2>`, deliberately distinct from the canonical `iso2` key. */
async function putCountry(
  countries: { put(id: string, r: CountryRow): Promise<unknown> },
  iso2: string,
  iso3: string,
  callPrefix: string,
  name: Record<string, string>,
): Promise<void> {
  await countries.put(`row-${iso2}`, { id: `row-${iso2}`, iso2, iso3, callPrefix, name })
}

describe('countries matrix — canonical recipe: altKeys, closed vocabulary, sparse dimension (#650 Task 7)', () => {
  async function seed() {
    const db = await freshDb()
    const vault = await db.openVault('v')
    const countries = vault.collection<CountryRow>('countries', {})
    // Sparse — only the two countries these tests actually use are populated.
    await putCountry(countries, 'US', 'USA', '+1', { en: 'United States', th: 'สหรัฐอเมริกา' })
    await putCountry(countries, 'TH', 'THA', '+66', { en: 'Thailand', th: 'ประเทศไทย' })
    const orders = vault.collection<OrderRow>('orders', { lookupFields: { country: countryField() } })
    return { countries, orders }
  }

  it('normalizes an ISO3 altKey candidate to the canonical ISO2 key on ingest', async () => {
    const { orders } = await seed()
    await orders.put('o1', { id: 'o1', country: 'USA' })
    expect((await orders.get('o1'))?.country).toBe('US')
  })

  it('normalizes a callPrefix altKey candidate to the canonical ISO2 key on ingest', async () => {
    const { orders } = await seed()
    await orders.put('o2', { id: 'o2', country: '+66' })
    expect((await orders.get('o2'))?.country).toBe('TH')
  })

  it('closed vocabulary refuses a code that is not a real ISO2 value at all', async () => {
    const { orders } = await seed()
    await expect(orders.put('o3', { id: 'o3', country: 'ZZ' })).rejects.toThrow(UnknownLookupKeyError)
  })

  it('sparse dimension: a REAL, valid-shaped ISO2 code is still refused when its row was never populated (populate-only-used)', async () => {
    const { countries, orders } = await seed()
    // 'ZA' (South Africa) is a legitimate ISO2 code, just not one of the two
    // sparse rows this vault populated — membership checks live data, not a
    // hardcoded universe of "real" codes.
    await expect(orders.put('o4', { id: 'o4', country: 'ZA' })).rejects.toThrow(UnknownLookupKeyError)
    expect((await countries.query().toArray()).length).toBe(2)
  })

  it('a valid, already-canonical ISO2 code is accepted unchanged', async () => {
    const { orders } = await seed()
    await orders.put('o5', { id: 'o5', country: 'TH' })
    expect((await orders.get('o5'))?.country).toBe('TH')
  })
})

describe('countries matrix — describe() consumes describeFragment (first-ever ViaBinding.describeFragment consumer, #650 Task 7)', () => {
  it('emits a normalized lookup block whose fields have NO other source in buildDescription — proof the fragment is genuinely consumed', async () => {
    const db = await freshDb()
    const vault = await db.openVault('v')
    const orders = vault.collection<OrderRow>('orders', { lookupFields: { country: countryField() } })

    const described = orders.describe()
    const field = described.fields.find((f) => f.key === 'country')
    expect(field).toBeDefined()

    // `backing`/`vocabulary`/`key`/`onDelete` are NOT derivable from the
    // pre-existing `dict` block (which only ever carries {name, static,
    // values}) — their presence here can only come from the 'lookup'
    // binding's describeFragment(), routed through Collection.describe() ->
    // ViaPipeline.describeFragments() -> buildDescription's viaFragments
    // input. Were the wiring missing, `field.lookup` would be `undefined`.
    expect(field?.lookup).toEqual({
      dimension: 'countries',
      backing: 'collection',
      vocabulary: 'closed',
      key: 'iso2',
      altKeys: ['iso3', 'callPrefix'],
      present: { label: 'name', by: 'locale' },
      sortBy: 'name',
      onDelete: 'restrict',
      // no `keys` — matrix-tier closed-vocabulary membership lives in the
      // backing collection's actual rows, not a statically declared list.
    })
    expect(field?.widget).toBe('select')
  })
})

// Docs-audit fix wave, finding 6: the `describe() consumes describeFragment` test above only
// covers the matrix tier's `dimension`-PRESENT case; a bare `enumOf()` field (no backing store, no
// dimension name — the `dimension: ''` internal sentinel, `descriptor.ts`) was never asserted
// against `describe()`. `buildLookupDescribeFragment` (`binding.ts`) omits the `dimension` key
// entirely for it (not an empty string); pin that shape here.
describe('enumOf() — describe() lookup block omits `dimension` for the bare enum tier (#650 Task 7, docs-audit finding 6)', () => {
  interface StatusRow extends Record<string, unknown> { id: string; status: string }

  it('emits backing/vocabulary/key/onDelete/keys with NO `dimension` property at all', async () => {
    const db = await freshDb()
    const vault = await db.openVault('v')
    const items = vault.collection<StatusRow>('items', {
      lookupFields: { status: enumOf(['draft', 'paid'] as const) },
    })

    const described = items.describe()
    const field = described.fields.find((f) => f.key === 'status')
    expect(field?.lookup).toEqual({
      backing: 'static',
      vocabulary: 'closed',
      key: 'id',
      onDelete: 'restrict',
      keys: ['draft', 'paid'],
    })
    expect(field?.lookup).not.toHaveProperty('dimension')
    expect(field?.widget).toBe('select')
  })
})

describe('countries matrix — compareForOrder: plain orderBy on a sortBy-declared matrix field (#650 Task 7, binding carry 1a)', () => {
  it('sorts by the resolved localized name via the sync snapshot, even without {by:"label"}, when displayLocale is declared', async () => {
    const db = await freshDb()
    const vault = await db.openVault('v')
    const countries = vault.collection<CountryRow>('countries', {})
    await putCountry(countries, 'US', 'USA', '+1', { en: 'United States', th: 'สหรัฐอเมริกา' })
    await putCountry(countries, 'ZA', 'ZAF', '+27', { en: 'South Africa', th: 'แอฟริกาใต้' })

    const orders = vault.collection<OrderRow>('orders-display-locale', {
      lookupFields: {
        country: lookup('countries', {
          key: 'iso2',
          present: { label: 'name', by: 'locale' },
          sortBy: 'name',
          backing: 'collection',
          vocabulary: 'open',
          displayLocale: 'en', // closes the sortBy/present.by coupling for the locale-less path
        }),
      },
    })
    await orders.put('o-us', { id: 'o-us', country: 'US' })
    await orders.put('o-za', { id: 'o-za', country: 'ZA' })

    // No locale, no {by:'label'} — compareForOrder closes over displayLocale
    // ('en'). "South Africa" < "United States" (S < U) — OPPOSITE of the
    // raw ISO2 code order (US < ZA), proving this genuinely sorts by name.
    const rows = orders.query().orderBy('country', 'asc').toArray()
    expect(rows.map((r) => r.id)).toEqual(['o-za', 'o-us'])
  })
})

describe('countries matrix — orderBy({by:"label"}) at a PER-CALL locale (#650 Task 7, binding carry 1b)', () => {
  it('the SAME two countries sort in TWO DIFFERENT orders depending on the per-call locale', async () => {
    const db = await freshDb()
    const vault = await db.openVault('v')
    const countries = vault.collection<CountryRow>('countries', {})
    await putCountry(countries, 'US', 'USA', '+1', { en: 'United States', th: 'สหรัฐอเมริกา' })
    await putCountry(countries, 'ZA', 'ZAF', '+27', { en: 'South Africa', th: 'แอฟริกาใต้' })

    // No displayLocale declared — this field can ONLY sort by label via a
    // per-call locale (buildOrderLabelMaps -> ViaPipeline.resolveOrderLabel
    // -> the 'lookup' binding's resolveOrderLabel, #650 Task 7); a plain
    // orderBy() on it degrades to raw-key order (proven by the previous
    // describe block using a displayLocale-bearing sibling instead).
    const orders = vault.collection<OrderRow>('orders-by-label', { lookupFields: { country: countryField() } })
    await orders.put('o-us', { id: 'o-us', country: 'US' })
    await orders.put('o-za', { id: 'o-za', country: 'ZA' })

    // English: "South Africa" < "United States" -> ZA, US.
    const enRows = orders.query().orderBy('country', 'asc', { by: 'label' }).toArray({ locale: 'en' })
    expect(enRows.map((r) => r.id)).toEqual(['o-za', 'o-us'])

    // Thai: 'สหรัฐอเมริกา' (US, starts U+0E2A) < 'แอฟริกาใต้' (ZA, starts
    // U+0E41) by UTF-16 code-point order -> US, ZA. A GENUINELY DIFFERENT
    // order from the English case — proves this is a real per-call-locale
    // resolution, not a cached/fixed comparator.
    const thRows = orders.query().orderBy('country', 'asc', { by: 'label' }).toArray({ locale: 'th' })
    expect(thRows.map((r) => r.id)).toEqual(['o-us', 'o-za'])
  })
})

describe('countries matrix — presentForJoin dresses a matrix-tier field on a REFERENCING collection (#650 Task 7, binding carry 1a)', () => {
  it('a joined collection\'s OWN matrix lookup field resolves <field>Label through the join, keyed by descriptor.key (not the backing row\'s PUT-id)', async () => {
    const db = await freshDb()
    const vault = await db.openVault('v')
    const countries = vault.collection<CountryRow>('countries', {})
    // PUT-id 'row-US' is deliberately NOT the iso2 value 'US' — proves the
    // new snapshot machinery keys by row[descriptor.key], not the PUT-id
    // (the exact distinction the #650 Task 3 review fix already applies to
    // checkLookupMembership's matrix branch — this test proves
    // presentForJoin's lookup half now applies it too).
    await putCountry(countries, 'US', 'USA', '+1', { en: 'United States', th: 'สหรัฐอเมริกา' })

    const orders = vault.collection<OrderRow>('orders-joined', { lookupFields: { country: countryField() } })
    await orders.put('o1', { id: 'o1', country: 'US' })

    const shipments = vault.collection<ShipmentRow>('shipments', { refs: { orderId: ref('orders-joined') } })
    await shipments.put('sh1', { id: 'sh1', orderId: 'o1' })

    const rowsTh = shipments.query().join('orderId', { as: 'order' }).toArray({ locale: 'th' }) as Array<ShipmentRow & { order: OrderRow & { countryLabel?: string } }>
    expect(rowsTh[0]!.order.countryLabel).toBe('สหรัฐอเมริกา')

    const rowsEn = shipments.query().join('orderId', { as: 'order' }).toArray({ locale: 'en' }) as Array<ShipmentRow & { order: OrderRow & { countryLabel?: string } }>
    expect(rowsEn[0]!.order.countryLabel).toBe('United States')
  })
})
