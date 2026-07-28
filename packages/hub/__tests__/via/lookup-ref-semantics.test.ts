/**
 * Ref semantics for the `'lookup'` via binding (#650 Task 5, phase D of the
 * Via port; fixes #648). `dictionary.delete(key, {mode:'strict'})`'s
 * reference check was an empty comment block (#648) — this suite is the
 * first-ever coverage AND the first-ever throw site for `DictKeyInUseError`
 * (seam map surprise 3). `restrict` is the default `onDelete` policy
 * (spec §4 decision 3); `cascade`/`nullify` are opt-in per declaration.
 *
 * RED (pre-Task-5): no `'ref'` `EdgeKind`, no declare-path edge
 * registration, `LookupHandle.delete()`'s strict branch was a no-op comment
 * block, `VaultLinks.enforceRefsOnDelete` never consulted lookup edges —
 * every restrict/cascade/nullify assertion below failed (restrict deleted
 * unconditionally with no throw; cascade/nullify never propagated).
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../../src/kernel/noydb.js'
import { withI18n } from '../../src/via/i18n/index.js'
import { lookup, dict } from '../../src/via/lookup/descriptor.js'
import { DictKeyInUseError, ConflictError } from '../../src/kernel/errors.js'
import type { Noydb } from '../../src/kernel/noydb.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../../src/kernel/types.js'

// Same in-memory store shape as lookup-vocabulary.test.ts / lookup-altkeys.test.ts.
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
  return createNoydb({ store: toMemory(), user: 'a', secret: 'lookup-ref-semantics-pass-2026', i18nStrategy: withI18n() })
}

interface Order extends Record<string, unknown> { id: string; status: string }

describe('lookup ref semantics (#650 Task 5, fixes #648)', () => {
  it('reserved tier, restrict (default): delete of an in-use key throws DictKeyInUseError naming the referencer; succeeds once the reference is gone', async () => {
    const db = await freshDb()
    const vault = await db.openVault('v')
    await vault.dictionary('status').put('paid', { en: 'Paid' })
    const orders = vault.collection<Order>('orders', {
      lookupFields: { status: dict('status', { onDelete: 'restrict' }) },
    })
    await orders.put('o1', { id: 'o1', status: 'paid' })

    let caught: unknown
    try {
      await vault.dictionary('status').delete('paid')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(DictKeyInUseError)
    const err = caught as DictKeyInUseError
    expect(err.dictionaryName).toBe('status')
    expect(err.key).toBe('paid')
    expect(err.usedBy).toBe('orders')
    expect(err.count).toBe(1)
    // No marker written — the key is still fully live.
    expect(await vault.dictionary('status').get('paid')).toEqual({ en: 'Paid' })

    await orders.delete('o1')
    await expect(vault.dictionary('status').delete('paid')).resolves.not.toThrow()
    expect(await vault.dictionary('status').get('paid')).toBeNull()
  })

  it('reserved tier, cascade: deleting the row tombstones the referencing order (fanout-visible)', async () => {
    const db = await freshDb()
    const vault = await db.openVault('v')
    await vault.dictionary('status-c').put('paid', { en: 'Paid' })
    const orders = vault.collection<Order>('orders-c', {
      lookupFields: { status: dict('status-c', { onDelete: 'cascade' }) },
    })
    await orders.put('o1', { id: 'o1', status: 'paid' })

    await vault.dictionary('status-c').delete('paid')

    expect(await orders.get('o1')).toBeNull()
    expect(await vault.dictionary('status-c').get('paid')).toBeNull()
  })

  it('reserved tier, nullify: deleting the row sets orders.status = null via an ordinary put', async () => {
    const db = await freshDb()
    const vault = await db.openVault('v')
    await vault.dictionary('status-n').put('paid', { en: 'Paid' })
    const orders = vault.collection<Order>('orders-n', {
      lookupFields: { status: dict('status-n', { onDelete: 'nullify' }) },
    })
    await orders.put('o1', { id: 'o1', status: 'paid' })

    await vault.dictionary('status-n').delete('paid')

    expect((await orders.get('o1'))?.status).toBeNull()
    expect(await vault.dictionary('status-n').get('paid')).toBeNull()
  })

  it('matrix (collection) tier: restrict behaves identically against a first-class countries collection', async () => {
    const db = await freshDb()
    const vault = await db.openVault('v')
    interface Country extends Record<string, unknown> { id: string; name: string }
    interface Traveler extends Record<string, unknown> { id: string; country: string }
    const countries = vault.collection<Country>('countries', {})
    const travelers = vault.collection<Traveler>('travelers', {
      lookupFields: { country: lookup('countries', { onDelete: 'restrict' }) },
    })
    await countries.put('US', { id: 'US', name: 'United States' })
    await travelers.put('t1', { id: 't1', country: 'US' })

    let caught: unknown
    try {
      await countries.delete('US')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(DictKeyInUseError)
    const err = caught as DictKeyInUseError
    expect(err.dictionaryName).toBe('countries')
    expect(err.usedBy).toBe('travelers')
    expect(err.count).toBe(1)
    expect(await countries.get('US')).not.toBeNull()

    await travelers.delete('t1')
    await expect(countries.delete('US')).resolves.not.toThrow()
    expect(await countries.get('US')).toBeNull()
  })

  it('matrix tier with a non-default descriptor.key: restrict matches against row[key], not the PUT-id (mirrors Task 3\'s membership review fix, Important 1)', async () => {
    const db = await freshDb()
    const vault = await db.openVault('v')
    interface Country extends Record<string, unknown> { id: string; iso2: string }
    interface Traveler extends Record<string, unknown> { id: string; country: string }
    const countries = vault.collection<Country>('countries', {})
    const travelers = vault.collection<Traveler>('travelers', {
      lookupFields: { country: lookup('countries', { key: 'iso2', onDelete: 'restrict' }) },
    })
    // The PUT-id ('US-internal') is deliberately NOT the iso2 value ('US') —
    // referencing records store the iso2 VALUE, never the PUT-id.
    await countries.put('US-internal', { id: 'US-internal', iso2: 'US' })
    await travelers.put('t1', { id: 't1', country: 'US' })

    let caught: unknown
    try {
      await countries.delete('US-internal')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(DictKeyInUseError)
    expect((caught as DictKeyInUseError).usedBy).toBe('travelers')
    expect(await countries.get('US-internal')).not.toBeNull()

    await travelers.delete('t1')
    await expect(countries.delete('US-internal')).resolves.not.toThrow()
  })

  it('a dimension with NO declared lookup-referencing edges keeps unconditional delete (no silent behavior change to plain dict users)', async () => {
    const db = await freshDb()
    const vault = await db.openVault('v')
    // No collection ever declares a lookupFields reference to 'untouched' —
    // referencingEdgesOf('_dict_untouched') is empty; the strict check is a no-op.
    await vault.dictionary('untouched').put('anything', { en: 'Anything' })
    await expect(vault.dictionary('untouched').delete('anything')).resolves.not.toThrow()
  })
})
