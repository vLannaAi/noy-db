/**
 * altKeys ingest normalization for the `'lookup'` via binding (#650 Task 3,
 * phase D of the Via port, spec §3). `materializeBackingTable` builds the
 * altKey→canonical-key index from a dimension's backing rows and enforces
 * declare/warm-time uniqueness across `key ∪ altKeys` values (the CHE/SWZ
 * drift class — collision is a `ValidationError`, not a per-put failure).
 * `ingest` is the sync, no-store-read consumer of that index.
 *
 * RED (pre-Task-3): `registry.ts` had no `materializeBackingTable`; the
 * lookup binding had no `ingest` — a candidate altKey value was stored
 * verbatim, never normalized to the canonical key, and no collision
 * detection existed at all.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../../src/kernel/noydb.js'
import { withI18n } from '../../src/shape/via-i18n/index.js'
import { lookup } from '../../src/shape/via-lookup/descriptor.js'
import { materializeBackingTable } from '../../src/shape/via-lookup/registry.js'
import { ValidationError, ConflictError } from '../../src/kernel/errors.js'
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
    async saveAll(c, data) {
      const comp = new Map<string, Map<string, EncryptedEnvelope>>()
      for (const [name, records] of Object.entries(data)) {
        const coll = new Map<string, EncryptedEnvelope>()
        for (const [id, env] of Object.entries(records)) coll.set(id, env)
        comp.set(name, coll)
      }
      const existing = store.get(c)
      if (existing) for (const [name, coll] of existing) if (name.startsWith('_')) comp.set(name, coll)
      store.set(c, comp)
    },
  }
}

async function freshDb(): Promise<Noydb> {
  return createNoydb({ store: memory(), user: 'a', secret: 'lookup-altkeys-pass-2026', i18nStrategy: withI18n() })
}

describe('materializeBackingTable (#650 Task 3) — pure registry function', () => {
  it('builds keys + altIndex when no collision', () => {
    const desc = lookup('countries', { key: 'iso2', altKeys: ['iso3', 'callPrefix'] })
    const rows = new Map<string, Record<string, unknown>>([
      ['US', { iso2: 'US', iso3: 'USA', callPrefix: '+1' }],
    ])
    const result = materializeBackingTable(desc, rows)
    expect(result.keys.has('US')).toBe(true)
    expect(result.altIndex.get('USA')).toBe('US')
    expect(result.altIndex.get('+1')).toBe('US')
  })

  it('throws ValidationError when two rows claim the same altKey value (the CHE/SWZ drift class)', () => {
    const desc = lookup('countries', { key: 'iso2', altKeys: ['iso3', 'callPrefix'] })
    const rows = new Map<string, Record<string, unknown>>([
      ['CH', { iso2: 'CH', iso3: 'CHE', callPrefix: '+41' }],
      // A second row's callPrefix accidentally collides with row CH's iso3 value.
      ['XX', { iso2: 'XX', iso3: 'XXX', callPrefix: 'CHE' }],
    ])
    expect(() => materializeBackingTable(desc, rows)).toThrow(ValidationError)
  })

  it('is idempotent: a canonical key is not in the altIndex as a distinct entry that rewrites to something else', () => {
    const desc = lookup('countries', { key: 'iso2', altKeys: ['iso3'] })
    const rows = new Map<string, Record<string, unknown>>([
      ['US', { iso2: 'US', iso3: 'USA' }],
    ])
    const result = materializeBackingTable(desc, rows)
    // The canonical key itself never appears as an altIndex source (only 'USA' does).
    expect(result.altIndex.has('US')).toBe(false)
  })

  it('accepts a numeric altKey value, normalizing it via coerceLookupKey (#651 Task 3 delta 3 — numeric widening)', () => {
    const desc = lookup('countries', { key: 'iso2', altKeys: ['callingCode'] })
    const rows = new Map<string, Record<string, unknown>>([
      ['US', { iso2: 'US', callingCode: 1 }],
    ])
    const result = materializeBackingTable(desc, rows)
    expect(result.altIndex.get('1')).toBe('US')
  })

  it('throws ValidationError when a numeric altKey value coerces to the same string as another row\'s string altKey (ownership-uniqueness holds across numeric/string)', () => {
    const desc = lookup('countries', { key: 'iso2', altKeys: ['callingCode'] })
    const rows = new Map<string, Record<string, unknown>>([
      ['US', { iso2: 'US', callingCode: 1 }],
      // XX's callingCode is the STRING '1' — coerces to the same candidate as US's numeric 1.
      ['XX', { iso2: 'XX', callingCode: '1' }],
    ])
    expect(() => materializeBackingTable(desc, rows)).toThrow(ValidationError)
  })
})

describe('lookup() altKeys ingest normalization — matrix (collection) tier end-to-end', () => {
  it('normalizes an altKey candidate value to the canonical key on put()', async () => {
    const db = await freshDb()
    const vault = await db.openVault('v')
    interface Country extends Record<string, unknown> { id: string; iso2: string; iso3: string; callPrefix: string }
    interface Order extends Record<string, unknown> { id: string; country: string }

    const countries = vault.collection<Country>('countries', {})
    await countries.put('US', { id: 'US', iso2: 'US', iso3: 'USA', callPrefix: '+1' })

    const orders = vault.collection<Order>('orders', {
      lookupFields: { country: lookup('countries', { key: 'iso2', altKeys: ['iso3', 'callPrefix'] }) },
    })

    await orders.put('o1', { id: 'o1', country: 'USA' })
    const stored1 = await orders._getStoredRecord('o1')
    expect(stored1?.country).toBe('US')

    await orders.put('o2', { id: 'o2', country: '+1' })
    const stored2 = await orders._getStoredRecord('o2')
    expect(stored2?.country).toBe('US')

    // Idempotent: a value that's already the canonical key passes through unchanged.
    await orders.put('o3', { id: 'o3', country: 'US' })
    const stored3 = await orders._getStoredRecord('o3')
    expect(stored3?.country).toBe('US')
  })

  it('lazy-mode backing collection + altKeys: put() throws a clear, lookup-branded error, not the join-branded one (review fix, Important 2)', async () => {
    const db = await freshDb()
    const vault = await db.openVault('v')
    interface Country extends Record<string, unknown> { id: string; iso2: string; iso3: string }
    interface Order extends Record<string, unknown> { id: string; country: string }

    // countries is opened LAZILY (prefetch: false) — buildLookupAltIndex's
    // matrix branch reads the backing collection via querySourceForJoin(),
    // which refuses lazy-mode collections.
    vault.collection<Country>('countries', { prefetch: false, cache: { maxRecords: 10 } })

    const orders = vault.collection<Order>('lazy-orders', {
      lookupFields: { country: lookup('countries', { key: 'iso2', altKeys: ['iso3'] }) },
    })

    await expect(orders.put('o1', { id: 'o1', country: 'USA' })).rejects.toThrow(ValidationError)
    await expect(orders.put('o2', { id: 'o2', country: 'USA' })).rejects.toThrow(
      /altKeys on "country" require the backing collection "countries" to be prefetch-enabled/,
    )
  })

  it('a candidate value with no altIndex match passes through unnormalized', async () => {
    const db = await freshDb()
    const vault = await db.openVault('v')
    interface Country extends Record<string, unknown> { id: string; iso2: string; iso3: string }
    interface Order extends Record<string, unknown> { id: string; country: string }

    const countries = vault.collection<Country>('countries', {})
    await countries.put('US', { id: 'US', iso2: 'US', iso3: 'USA' })

    const orders = vault.collection<Order>('orders2', {
      lookupFields: { country: lookup('countries', { key: 'iso2', altKeys: ['iso3'] }) },
    })

    await orders.put('o1', { id: 'o1', country: 'ZZZ' })
    const stored = await orders._getStoredRecord('o1')
    expect(stored?.country).toBe('ZZZ')
  })
})
