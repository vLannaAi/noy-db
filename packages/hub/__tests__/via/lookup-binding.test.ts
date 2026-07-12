/**
 * The `'lookup'` via binding — `lookup()`/`enumOf()`/`dict()` (#650 Task 2,
 * phase D of the Via port).
 *
 * RED (pre-Task-2): `via(lookup(...))`/`via(dict(...))`/`via(enumOf(...))`
 * threw in `mergeViaFields` (unrecognized `_viaBrand`) and no `descriptor.ts`/
 * `binding.ts` existed. GREEN: the three descriptor factories compile onto
 * the `'lookup'` binding; the reserved tier's present-time label dressing
 * matches a `dictKey()` field byte-for-byte; the enum tier stores codes
 * verbatim and describe()s as `type:'enum'`/`widget:'select'`.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../../src/kernel/noydb.js'
import { withI18n } from '../../src/shape/via-i18n/index.js'
import { dictKey } from '../../src/shape/via-i18n/dictionary.js'
import { via } from '../../src/kernel/via-compose.js'
import { lookup, enumOf, dict } from '../../src/shape/via-lookup/descriptor.js'
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
  return createNoydb({ store: memory(), user: 'a', secret: 'lookup-binding-pass-2026', i18nStrategy: withI18n() })
}

describe('the lookup binding (#650 Task 2)', () => {
  it('via(lookup(...))/via(dict(...))/via(enumOf(...)) no longer throw in mergeViaFields', async () => {
    const db = await freshDb()
    const vault = await db.openVault('v')
    expect(() =>
      vault.collection<{ id: string; status: string; state: string; country: string }>('orders', {
        viaFields: {
          status: via(dict('status')),
          state: via(enumOf(['draft', 'sent', 'paid'] as const)),
          country: via(lookup('countries')),
        },
      }),
    ).not.toThrow()
  })

  it('dict(): put+get at a locale dresses statusLabel identically to a dictKey field', async () => {
    const db = await freshDb()
    const vault = await db.openVault('v')
    await vault.dictionary('status').putAll({
      draft: { en: 'Draft', th: 'ฉบับร่าง' },
      paid: { en: 'Paid', th: 'ชำระแล้ว' },
    })

    interface Order extends Record<string, unknown> { id: string; status: string }
    const dictKeyOrders = vault.collection<Order>('dictkey-orders', {
      dictKeyFields: { status: dictKey('status', ['draft', 'paid'] as const) },
    })
    const lookupOrders = vault.collection<Order>('lookup-orders', {
      viaFields: { status: via(dict('status')) },
    })

    await dictKeyOrders.put('o1', { id: 'o1', status: 'paid' })
    await lookupOrders.put('o1', { id: 'o1', status: 'paid' })

    const viaDictKey = await dictKeyOrders.get('o1', { locale: 'th' }) as Order & { statusLabel?: string }
    const viaLookup = await lookupOrders.get('o1', { locale: 'th' }) as Order & { statusLabel?: string }

    expect(viaLookup.status).toBe('paid')
    expect(viaLookup.statusLabel).toBe('ชำระแล้ว')
    expect(viaLookup.statusLabel).toBe(viaDictKey.statusLabel)
  })

  it('lookupFields sugar key (no viaFields) compiles the lookup binding, same as via()', async () => {
    const db = await freshDb()
    const vault = await db.openVault('v')
    await vault.dictionary('status').putAll({ paid: { en: 'Paid', th: 'ชำระแล้ว' } })

    interface Order extends Record<string, unknown> { id: string; status: string }
    const orders = vault.collection<Order>('sugar-orders', {
      lookupFields: { status: dict('status') },
    })
    await orders.put('o1', { id: 'o1', status: 'paid' })
    const got = await orders.get('o1', { locale: 'th' }) as Order & { statusLabel?: string }
    expect(got.statusLabel).toBe('ชำระแล้ว')
  })

  it('mergeViaFields: dictKeyFields + lookupFields naming the same field throws ValidationError', async () => {
    const db = await freshDb()
    const vault = await db.openVault('v')
    expect(() =>
      vault.collection<{ id: string; status: string }>('double-sugar', {
        dictKeyFields: { status: dictKey('status', ['draft', 'paid'] as const) },
        lookupFields: { status: dict('status') },
      }),
    ).toThrow(/status.*both/i)
  })

  it('enumOf(): stores the code verbatim and describe() reports type:enum + widget:select', async () => {
    const db = await freshDb()
    const vault = await db.openVault('v')
    interface Task extends Record<string, unknown> { id: string; state: string }
    const tasks = vault.collection<Task>('tasks', {
      viaFields: { state: via(enumOf(['draft', 'sent', 'paid'] as const)) },
    })

    await tasks.put('t1', { id: 't1', state: 'sent' })
    const raw = await tasks._getStoredRecord('t1')
    expect(raw?.state).toBe('sent')
    const got = await tasks.get('t1')
    expect(got?.state).toBe('sent')

    const described = tasks.describe()
    const field = described.fields.find((f) => f.key === 'state')
    expect(field?.type).toBe('enum')
    expect(field?.widget).toBe('select')
  })
})
