/**
 * The #651 repro — matrix (collection) tier, DIRECT-read (non-join) `<field>Label`
 * dressing for a `key !== 'id'` descriptor — plus the dm12 poisoned-`"undefined"`-key
 * pin (Task 3, spec §2 / seam-map-consolidation.md Part 2, surprises 5/6).
 *
 * RED (pre-Task-3): `getLookupBacking`'s closure (`kernel/vault.ts:1134`) resolved the
 * backing row by the backing collection's own PUT-id (`.get(key)`), never by
 * `descriptor.key` — for a `key: 'iso2'` descriptor whose PUT-id differs from `iso2`,
 * `fetchLookupLabel`'s matrix branch silently omitted `<field>Label` on a direct
 * `get()`. Separately, `buildLookupAltIndex`/`buildLookupSnapshotRows`'s matrix
 * branches bare-`String()`-keyed a row missing its `descriptor.key` field as the
 * literal key `"undefined"`, which a closed vocabulary's membership check then
 * wrongly ACCEPTED. GREEN (post-Task-3): both close via the ONE canonical
 * `coerceLookupKey`/`resolveBackingRowKey` core in `shape/via-lookup/registry.ts`.
 *
 * Reuses the countries-matrix inline harness (`countries-matrix.test.ts`).
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../../src/kernel/noydb.js'
import { withI18n } from '../../src/shape/via-i18n/index.js'
import { lookup } from '../../src/shape/via-lookup/descriptor.js'
import { coerceLookupKey, resolveBackingRowKey } from '../../src/shape/via-lookup/registry.js'
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
  return createNoydb({ store: memory(), user: 'a', secret: 'lookup-direct-read-pass-2026', i18nStrategy: withI18n() })
}

interface CountryRow extends Record<string, unknown> {
  id: string
  iso2?: string
  iso3?: string
  name: Record<string, string>
}
interface OrderRow extends Record<string, unknown> { id: string; country: string }

describe('matrix direct-read dressing: key !== \'id\' works (#651 repro flip)', () => {
  it('a direct (non-join) get() at a locale resolves <field>Label via descriptor.key, not the backing row\'s PUT-id', async () => {
    const db = await freshDb()
    const vault = await db.openVault('v')
    const countries = vault.collection<CountryRow>('countries', {})
    // PUT-id 'row-US' is deliberately NOT the iso2 value 'US' — the exact #651 shape.
    await countries.put('row-US', { id: 'row-US', iso2: 'US', iso3: 'USA', name: { en: 'United States', th: 'สหรัฐอเมริกา' } })

    const orders = vault.collection<OrderRow>('orders', {
      lookupFields: {
        country: lookup('countries', { key: 'iso2', altKeys: ['iso3'], present: { label: 'name', by: 'locale' }, backing: 'collection' }),
      },
    })
    await orders.put('o1', { id: 'o1', country: 'US' })

    const en = await orders.get('o1', { locale: 'en' }) as OrderRow & { countryLabel?: string }
    expect(en?.countryLabel).toBe('United States')

    const th = await orders.get('o1', { locale: 'th' }) as OrderRow & { countryLabel?: string }
    expect(th?.countryLabel).toBe('สหรัฐอเมริกา')
  })
})

describe('poisoned "undefined" key pin (#651, dm12 — bare String() vs guarded coercion)', () => {
  it('a countries row missing its descriptor.key field does not enter the snapshot/altIndex as "undefined"', async () => {
    const db = await freshDb()
    const vault = await db.openVault('v')
    const countries = vault.collection<CountryRow>('countries', {})
    await countries.put('row-US', { id: 'row-US', iso2: 'US', name: { en: 'United States' } })
    // No `iso2` field at all — `row[descriptor.key]` is `undefined` on this row.
    await countries.put('row-broken', { id: 'row-broken', name: { en: 'Nowhere' } })

    const orders = vault.collection<OrderRow>('orders', {
      lookupFields: { country: lookup('countries', { key: 'iso2', vocabulary: 'closed', backing: 'collection' }) },
    })

    // A genuinely valid key is accepted.
    await expect(orders.put('o1', { id: 'o1', country: 'US' })).resolves.not.toThrow()
    // The literal string "undefined" must be REFUSED — pre-fix, the broken row's
    // bare-String()-keyed snapshot entry ("undefined" -> row-broken) wrongly
    // validated it as a known vocabulary member.
    await expect(orders.put('o2', { id: 'o2', country: 'undefined' })).rejects.toThrow(UnknownLookupKeyError)

    // No order record ever ends up holding the poisoned literal value.
    expect(orders.query().where('country', '==', 'undefined').toArray().length).toBe(0)
  })
})

describe('coerceLookupKey / resolveBackingRowKey — the pure core (unit)', () => {
  it('coerceLookupKey: string/number coerce to String; null/undefined/other coerce to undefined', () => {
    expect(coerceLookupKey(5)).toBe('5')
    expect(coerceLookupKey('US')).toBe('US')
    expect(coerceLookupKey(null)).toBeUndefined()
    expect(coerceLookupKey(undefined)).toBeUndefined()
    expect(coerceLookupKey({})).toBeUndefined()
  })

  it('resolveBackingRowKey: reads row[descriptor.key] through coerceLookupKey', () => {
    const desc = lookup('countries', { key: 'iso2' })
    expect(resolveBackingRowKey(desc, { iso2: 'US' })).toBe('US')
    expect(resolveBackingRowKey(desc, {})).toBeUndefined()
  })
})
