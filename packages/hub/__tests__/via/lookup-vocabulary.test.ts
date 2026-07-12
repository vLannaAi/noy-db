/**
 * Open/closed vocabulary governance for the `'lookup'` via binding (#650
 * Task 3, phase D of the Via port). Closes #649 (dictKey validation
 * documented-but-nonexistent) for the native `lookup()`/`enumOf()`/
 * `dict()` spellings — `dictKey()`/`staticDict()` themselves are untouched
 * (constraint 3: the alias STAYS open by default).
 *
 * RED (pre-Task-3): `LookupViaConfig` had no `enforceWrite`/`ingest`; a
 * closed-vocabulary lookup field never refused an unknown key at put()
 * time — every assertion below that expects a throw failed (no error at
 * all). GREEN: the lookup binding's `enforceWrite` consults the vault-built
 * `membership` closure per tier.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb } from '../../src/kernel/noydb.js'
import { withI18n } from '../../src/shape/via-i18n/index.js'
import { dictKey } from '../../src/shape/via-i18n/dictionary.js'
import { via } from '../../src/kernel/via-compose.js'
import { lookup, enumOf, dict } from '../../src/shape/via-lookup/descriptor.js'
import { UnknownLookupKeyError, ConflictError } from '../../src/kernel/errors.js'
import type { ViaWriteCtx } from '../../src/kernel/via.js'
import type { Noydb } from '../../src/kernel/noydb.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../../src/kernel/types.js'

// Compile-time proof (per the task's Constraint 1): ViaWriteCtx was not
// widened with a cross-collection door — the membership closure rides
// cfg, not ctx. Fails to typecheck if a new key is ever added to ViaWriteCtx.
type _ViaWriteCtxKeys = keyof ViaWriteCtx
type _AssertNarrow = _ViaWriteCtxKeys extends 'id' | 'vault' | 'prior' | 'emit' ? true : ['ViaWriteCtx grew a new member', _ViaWriteCtxKeys]
const _viaWriteCtxUnchanged: _AssertNarrow = true
void _viaWriteCtxUnchanged

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
  return createNoydb({ store: memory(), user: 'a', secret: 'lookup-vocab-pass-2026', i18nStrategy: withI18n() })
}

describe('lookup vocabulary governance (#650 Task 3, closes #649)', () => {
  it('static tier (enumOf): closed refuses an undeclared key, permits a declared one', async () => {
    const db = await freshDb()
    const vault = await db.openVault('v')
    interface Task extends Record<string, unknown> { id: string; state: string }
    const tasks = vault.collection<Task>('tasks', {
      viaFields: { state: via(enumOf(['draft', 'sent', 'paid'] as const)) },
    })

    await expect(tasks.put('t1', { id: 't1', state: 'sent' })).resolves.not.toThrow()
    await expect(tasks.put('t2', { id: 't2', state: 'archived' })).rejects.toThrow(UnknownLookupKeyError)
  })

  it('reserved tier (dict): closed refuses an unknown key, permits a declared one; open permits either', async () => {
    const db = await freshDb()
    const vault = await db.openVault('v')
    interface Order extends Record<string, unknown> { id: string; status: string }

    const closedOrders = vault.collection<Order>('closed-orders', {
      lookupFields: { status: dict('status', { keys: ['draft', 'sent'] as const, vocabulary: 'closed' }) },
    })
    await expect(closedOrders.put('o1', { id: 'o1', status: 'draft' })).resolves.not.toThrow()
    await expect(closedOrders.put('o2', { id: 'o2', status: 'paid' })).rejects.toThrow(UnknownLookupKeyError)

    // The SAME dimension name ('status2'), declared open on a sibling collection: unknown keys pass.
    const openOrders = vault.collection<Order>('open-orders', {
      lookupFields: { status: dict('status2', { keys: ['draft', 'sent'] as const, vocabulary: 'open' }) },
    })
    await expect(openOrders.put('o3', { id: 'o3', status: 'paid' })).resolves.not.toThrow()
  })

  it('reserved tier (dict): closed with NO declared keys validates against the live dict handle snapshot', async () => {
    const db = await freshDb()
    const vault = await db.openVault('v')
    interface Order extends Record<string, unknown> { id: string; status: string }
    const orders = vault.collection<Order>('snapshot-orders', {
      lookupFields: { status: dict('status3', { vocabulary: 'closed' }) },
    })

    await expect(orders.put('o1', { id: 'o1', status: 'draft' })).rejects.toThrow(UnknownLookupKeyError)
    await vault.dictionary('status3').put('draft', { en: 'Draft' })
    await expect(orders.put('o2', { id: 'o2', status: 'draft' })).resolves.not.toThrow()
  })

  it('matrix (collection) tier: closed refuses an unknown key while the backing collection is empty, permits once the row exists', async () => {
    const db = await freshDb()
    const vault = await db.openVault('v')
    interface Country extends Record<string, unknown> { id: string; name: string }
    interface Order extends Record<string, unknown> { id: string; country: string }

    const countries = vault.collection<Country>('countries', {})
    const orders = vault.collection<Order>('country-orders', {
      lookupFields: { country: lookup('countries', { vocabulary: 'closed' }) },
    })

    await expect(orders.put('o1', { id: 'o1', country: 'US' })).rejects.toThrow(UnknownLookupKeyError)
    await countries.put('US', { id: 'US', name: 'United States' })
    await expect(orders.put('o2', { id: 'o2', country: 'US' })).resolves.not.toThrow()
  })

  it('alias unchanged: dictKey() stays open by default — an undeclared code does not throw', async () => {
    const db = await freshDb()
    const vault = await db.openVault('v')
    interface Order extends Record<string, unknown> { id: string; status: string }
    const orders = vault.collection<Order>('dictkey-open-orders', {
      dictKeyFields: { status: dictKey('status4', ['draft', 'sent'] as const) },
    })
    // #649: the OLD dictKey doc comment falsely claimed declared keys are
    // validated on put(). That claim stays false for the alias — only the
    // native dict()/lookup() spellings gain enforcement, and only when the
    // user opts into { vocabulary: 'closed' }.
    await expect(orders.put('o1', { id: 'o1', status: 'unknown-code' })).resolves.not.toThrow()
  })
})
