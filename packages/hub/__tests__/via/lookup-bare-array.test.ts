/**
 * #661 — bare-array lookup fields gain element-wise visibility in BOTH
 * `ingest` and `enforceWrite`, together (element-wise SUPPORT ratified;
 * declare-time refusal rejected).
 *
 * A plain top-level field whose OWN value is an array (e.g. `tags: ['a',
 * 'b']` on `tags: lookup('tags', {...})`) is a DIFFERENT shape from the
 * `[].`-wildcard multi-value path (#652, `lookup-altkeys.test.ts`'s last
 * describe block): `getAtPath` resolves a bare array to ONE opaque value
 * (`[['a','b']]`, length 1) rather than splitting it, so it fell through
 * BOTH hooks unchanged — `runLookupIngest`'s `typeof value !== 'string'`
 * guard bailed on the whole array, and `runLookupEnforceWrite`'s identical
 * guard skipped it too, so `membership()` was never called: a closed-
 * vocabulary field's bare array had ZERO enforcement, any value (known
 * altKey, canonical key, or genuinely unknown) silently passed `put()`.
 *
 * RED (pre-fix, the issue's exact end-to-end probe): a closed-vocabulary
 * bare array of unknown values (`['ZZZ','totally-bogus']`) resolved
 * `put()` without throwing and stored the raw unknown values unchanged —
 * see the first test in the "closed vocabulary" describe block below.
 *
 * Fix: both hooks learn a `Array.isArray(value)` branch for a NON-wildcard
 * field path, reusing the SAME canonical core the scalar and `[].`-wildcard
 * paths already use — `backing.altIndex` (ingest) / `cfg.membership`
 * (enforceWrite) — element-wise, mirroring #652's copy-on-write discipline
 * (new array only when changed; record clone only when needed).
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../../src/kernel/noydb.js'
import { withI18n } from '../../src/via/i18n/index.js'
import { lookup } from '../../src/via/lookup/descriptor.js'
import { UnknownLookupKeyError, ConflictError } from '../../src/kernel/errors.js'
import type { Noydb } from '../../src/kernel/noydb.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../../src/kernel/types.js'

function toMemory(): NoydbStore {
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
  return createNoydb({ store: toMemory(), user: 'a', secret: 'lookup-bare-array-pass-2026', i18nStrategy: withI18n() })
}

interface Country extends Record<string, unknown> { id: string; iso2: string; iso3: string; callPrefix: string }
interface Order extends Record<string, unknown> { id: string; tags: unknown[] }
interface OrderWithMeta extends Record<string, unknown> { id: string; meta: { tags: unknown[] } }

async function seed() {
  const db = await freshDb()
  const vault = await db.openVault('v')
  const countries = vault.collection<Country>('countries', {})
  await countries.put('US', { id: 'US', iso2: 'US', iso3: 'USA', callPrefix: '+1' })
  await countries.put('TH', { id: 'TH', iso2: 'TH', iso3: 'THA', callPrefix: '+66' })
  return { countries, vault }
}

describe('lookup() bare-array field — ingest altKey normalization, element-wise (#661)', () => {
  it('normalizes every element\'s altKey candidate to the canonical key on ingest', async () => {
    const { vault } = await seed()
    const orders = vault.collection<Order>('orders-bare', {
      lookupFields: { tags: lookup('countries', { key: 'iso2', altKeys: ['iso3', 'callPrefix'] }) },
    })

    await orders.put('o1', { id: 'o1', tags: ['USA', '+66'] })
    const stored = await orders._getStoredRecord('o1')
    expect(stored?.tags).toEqual(['US', 'TH'])
  })

  it('mixed array — an altKey, an already-canonical key, and (open vocabulary) an unknown value pass through untouched', async () => {
    const { vault } = await seed()
    const orders = vault.collection<Order>('orders-bare-mixed', {
      lookupFields: { tags: lookup('countries', { key: 'iso2', altKeys: ['iso3', 'callPrefix'] }) },
    })

    await orders.put('o1', { id: 'o1', tags: ['USA', 'TH', 'ZZZ'] })
    const stored = await orders._getStoredRecord('o1')
    // 'USA' -> 'US' (altKey), 'TH' -> 'TH' (already canonical), 'ZZZ' has no
    // altIndex match and is an open vocabulary — passes through unchanged.
    expect(stored?.tags).toEqual(['US', 'TH', 'ZZZ'])
  })

  it('empty array is a no-op', async () => {
    const { vault } = await seed()
    const orders = vault.collection<Order>('orders-bare-empty', {
      lookupFields: { tags: lookup('countries', { key: 'iso2', altKeys: ['iso3'] }) },
    })

    await orders.put('o1', { id: 'o1', tags: [] })
    const stored = await orders._getStoredRecord('o1')
    expect(stored?.tags).toEqual([])
  })

  it('duplicate elements after normalization are kept as-is (pass-through — consistent with #652\'s pinned decision, not deduped)', async () => {
    const { vault } = await seed()
    const orders = vault.collection<Order>('orders-bare-dupes', {
      lookupFields: { tags: lookup('countries', { key: 'iso2', altKeys: ['iso3', 'callPrefix'] }) },
    })

    // 'USA' and '+1' both normalize to 'US' — the normalized array keeps
    // both resulting entries rather than deduping them, mirroring #652's
    // `[].`-wildcard decision for the exact same shape.
    await orders.put('o1', { id: 'o1', tags: ['USA', '+1'] })
    const stored = await orders._getStoredRecord('o1')
    expect(stored?.tags).toEqual(['US', 'US'])
  })

  it('idempotent: an already-all-canonical array passes through unchanged', async () => {
    const { vault } = await seed()
    const orders = vault.collection<Order>('orders-bare-canonical', {
      lookupFields: { tags: lookup('countries', { key: 'iso2', altKeys: ['iso3', 'callPrefix'] }) },
    })

    await orders.put('o1', { id: 'o1', tags: ['US', 'TH'] })
    const stored = await orders._getStoredRecord('o1')
    expect(stored?.tags).toEqual(['US', 'TH'])
  })

  it('non-string elements (numbers, objects, null) are left untouched — mirrors the scalar branch\'s skip-non-string behavior; no parallel coercion invented', async () => {
    const { vault } = await seed()
    const orders = vault.collection<Order>('orders-bare-nonstring', {
      lookupFields: { tags: lookup('countries', { key: 'iso2', altKeys: ['iso3'] }) },
    })

    await orders.put('o1', { id: 'o1', tags: ['USA', 42, { foo: 'bar' }, null] })
    const stored = await orders._getStoredRecord('o1')
    expect(stored?.tags).toEqual(['US', 42, { foo: 'bar' }, null])
  })
})

describe('lookup() bare-array field — enforceWrite closed-vocabulary membership, element-wise (#661)', () => {
  it('THE ISSUE\'S EXACT PROBE: closed vocabulary refuses a bare array of unknown values (was silently accepted — the filed hole)', async () => {
    const { vault } = await seed()
    const orders = vault.collection<Order>('orders-bare-closed-probe', {
      lookupFields: { tags: lookup('countries', { key: 'iso2', vocabulary: 'closed' }) },
    })

    await expect(orders.put('o1', { id: 'o1', tags: ['ZZZ', 'totally-bogus'] })).rejects.toThrow(UnknownLookupKeyError)
  })

  it('closed vocabulary: every known element (including altKeys, normalized by ingest first) is accepted', async () => {
    const { vault } = await seed()
    const orders = vault.collection<Order>('orders-bare-closed-ok', {
      lookupFields: { tags: lookup('countries', { key: 'iso2', altKeys: ['iso3', 'callPrefix'], vocabulary: 'closed' }) },
    })

    await expect(orders.put('o1', { id: 'o1', tags: ['USA', 'TH'] })).resolves.not.toThrow()
    const stored = await orders._getStoredRecord('o1')
    expect(stored?.tags).toEqual(['US', 'TH'])
  })

  it('closed vocabulary: refuses on the FIRST unknown element, naming the field and the offending element', async () => {
    const { vault } = await seed()
    const orders = vault.collection<Order>('orders-bare-closed-mixed', {
      lookupFields: { tags: lookup('countries', { key: 'iso2', vocabulary: 'closed' }) },
    })

    await expect(orders.put('o1', { id: 'o1', tags: ['US', 'ZZZ'] })).rejects.toThrow(UnknownLookupKeyError)
    await expect(orders.put('o2', { id: 'o2', tags: ['US', 'ZZZ'] })).rejects.toThrow(/tags/)
    await expect(orders.put('o3', { id: 'o3', tags: ['US', 'ZZZ'] })).rejects.toThrow(/ZZZ/)
  })

  it('open vocabulary: a mixed array with an unknown element passes through (no membership refusal)', async () => {
    const { vault } = await seed()
    const orders = vault.collection<Order>('orders-bare-open', {
      lookupFields: { tags: lookup('countries', { key: 'iso2', altKeys: ['iso3'], vocabulary: 'open' }) },
    })

    await expect(orders.put('o1', { id: 'o1', tags: ['USA', 'not-a-country'] })).resolves.not.toThrow()
    const stored = await orders._getStoredRecord('o1')
    expect(stored?.tags).toEqual(['US', 'not-a-country'])
  })

  it('empty array: no membership calls, resolves cleanly even closed-vocabulary', async () => {
    const { vault } = await seed()
    const orders = vault.collection<Order>('orders-bare-closed-empty', {
      lookupFields: { tags: lookup('countries', { key: 'iso2', vocabulary: 'closed' }) },
    })

    await expect(orders.put('o1', { id: 'o1', tags: [] })).resolves.not.toThrow()
  })

  it('non-string elements inside a closed-vocabulary array are skipped (not membership-checked, not refused) — mirrors scalar skip', async () => {
    const { vault } = await seed()
    const orders = vault.collection<Order>('orders-bare-closed-nonstring', {
      lookupFields: { tags: lookup('countries', { key: 'iso2', vocabulary: 'closed' }) },
    })

    await expect(orders.put('o1', { id: 'o1', tags: ['US', 42, null] })).resolves.not.toThrow()
    const stored = await orders._getStoredRecord('o1')
    expect(stored?.tags).toEqual(['US', 42, null])
  })
})

describe('lookup() bare-array field at a DOTTED (non-wildcard) path — same element-wise support (t8d4)', () => {
  // 'meta.tags' is a bare array at a NESTED path, distinct from BOTH the top-level bare-array
  // shape above and the 'lines[].country' wildcard shape — `getAtPath`/`setAtPathInPlace`
  // (kernel/paths.ts) resolve dotted paths generically, so the same Array.isArray branches in
  // `runLookupIngest`/`runLookupEnforceWrite` cover this shape with no dedicated code.
  it('normalizes every element\'s altKey candidate to the canonical key on ingest, at a dotted path', async () => {
    const { vault } = await seed()
    const orders = vault.collection<OrderWithMeta>('orders-bare-dotted', {
      lookupFields: { 'meta.tags': lookup('countries', { key: 'iso2', altKeys: ['iso3', 'callPrefix'] }) },
    })

    await orders.put('o1', { id: 'o1', meta: { tags: ['USA', '+66'] } })
    const stored = await orders._getStoredRecord('o1')
    expect(stored?.meta).toEqual({ tags: ['US', 'TH'] })
  })

  it('closed vocabulary refuses an unknown element at a dotted path', async () => {
    const { vault } = await seed()
    const orders = vault.collection<OrderWithMeta>('orders-bare-dotted-closed', {
      lookupFields: { 'meta.tags': lookup('countries', { key: 'iso2', vocabulary: 'closed' }) },
    })

    await expect(orders.put('o1', { id: 'o1', meta: { tags: ['US', 'ZZZ'] } })).rejects.toThrow(UnknownLookupKeyError)
    await expect(orders.put('o2', { id: 'o2', meta: { tags: ['US', 'TH'] } })).resolves.not.toThrow()
  })
})

describe('lookup() — scalar and [].-wildcard byte-parity (#661 must not perturb either)', () => {
  it('scalar field: unchanged behavior — altKey normalizes, closed vocab refuses an unknown value', async () => {
    const { vault } = await seed()
    interface ScalarOrder extends Record<string, unknown> { id: string; country: string }
    const orders = vault.collection<ScalarOrder>('orders-scalar', {
      lookupFields: { country: lookup('countries', { key: 'iso2', altKeys: ['iso3'], vocabulary: 'closed' }) },
    })

    await orders.put('o1', { id: 'o1', country: 'USA' })
    const stored = await orders._getStoredRecord('o1')
    expect(stored?.country).toBe('US')

    await expect(orders.put('o2', { id: 'o2', country: 'ZZZ' })).rejects.toThrow(UnknownLookupKeyError)
  })

  it('[].-wildcard field: unchanged behavior — element-wise normalize + refuse (#652 lock)', async () => {
    const { vault } = await seed()
    interface Line { country: string }
    interface LineOrder extends Record<string, unknown> { id: string; lines: Line[] }
    const orders = vault.collection<LineOrder>('orders-wildcard', {
      lookupFields: { 'lines[].country': lookup('countries', { key: 'iso2', altKeys: ['iso3'], vocabulary: 'closed' }) },
    })

    await orders.put('o1', { id: 'o1', lines: [{ country: 'USA' }, { country: 'TH' }] })
    const stored = await orders._getStoredRecord('o1')
    expect(stored?.lines).toEqual([{ country: 'US' }, { country: 'TH' }])

    await expect(
      orders.put('o2', { id: 'o2', lines: [{ country: 'USA' }, { country: 'ZZ' }] }),
    ).rejects.toThrow(UnknownLookupKeyError)
  })
})
