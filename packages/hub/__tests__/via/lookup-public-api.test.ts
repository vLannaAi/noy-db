/**
 * Public-surface regression pin (#650 whole-branch fix wave, Critical
 * finding) — `lookup()`/`enumOf()`/`enum`/`dict()`/`UnknownLookupKeyError`
 * and the `LookupDescriptor`/`Vocabulary`/`OnDelete` types are re-exported
 * from the root `@noy-db/hub` barrel (`src/index.ts`).
 *
 * Every import below goes THROUGH the barrel (`../../src/index.js`), not a
 * relative `via/lookup/*` path — this file fails to even compile if
 * any of these exports vanish from `src/index.ts` again. Before this wave,
 * a consumer following `docs/subsystems/via-lookup.md`'s own
 * `import { lookup, enum as enumOf, dict } from '@noy-db/hub'` line had no
 * way to construct a lookup field at all: hand-written descriptor literals
 * never call `linkLookupVia()`, so the `'lookup'` via-binding is never
 * installed and every declared lookup field is silently inert.
 */
import { describe, it, expect } from 'vitest'
import {
  createNoydb,
  via,
  lookup,
  dict,
  enumOf,
  enum as enumAlias,
  UnknownLookupKeyError,
} from '../../src/index.js'
import type { LookupDescriptor, Vocabulary, OnDelete } from '../../src/index.js'
import { withI18n } from '../../src/via/i18n/index.js'
import { ConflictError } from '../../src/kernel/errors.js'
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
  return createNoydb({ store: toMemory(), user: 'a', secret: 'lookup-public-api-pass-2026', i18nStrategy: withI18n() })
}

describe('via-lookup public API — root barrel export (#650 whole-branch fix wave)', () => {
  it('`enum` is the exact same binding as `enumOf` — a pure reserved-word export alias', () => {
    expect(enumAlias).toBe(enumOf)
  })

  it('enum tier: a barrel-imported closed-vocabulary field works end-to-end (put valid succeeds, unknown key throws UnknownLookupKeyError)', async () => {
    const db = await freshDb()
    const vault = await db.openVault('v1')
    interface Task extends Record<string, unknown> { id: string; state: string }
    const tasks = vault.collection<Task>('tasks', {
      viaFields: { state: via(enumAlias(['draft', 'sent', 'paid'] as const)) },
    })

    await expect(tasks.put('t1', { id: 't1', state: 'sent' })).resolves.not.toThrow()
    await expect(tasks.put('t2', { id: 't2', state: 'archived' })).rejects.toThrow(UnknownLookupKeyError)
  })

  it('matrix tier (lookup()) and dict tier (dict()) both construct usable closed-vocabulary fields through the barrel', async () => {
    const db = await freshDb()
    const vault = await db.openVault('v2')
    interface Country extends Record<string, unknown> { id: string }
    interface Order extends Record<string, unknown> { id: string; country: string; status: string }

    const countries = vault.collection<Country>('countries', {})
    const orders = vault.collection<Order>('orders', {
      lookupFields: {
        country: lookup('countries', { vocabulary: 'closed' }),
        status: dict('status', { keys: ['draft', 'sent'] as const, vocabulary: 'closed' }),
      },
    })

    await expect(orders.put('o1', { id: 'o1', country: 'US', status: 'draft' })).rejects.toThrow(UnknownLookupKeyError)
    await countries.put('US', { id: 'US' })
    await expect(orders.put('o2', { id: 'o2', country: 'US', status: 'draft' })).resolves.not.toThrow()
    await expect(orders.put('o3', { id: 'o3', country: 'US', status: 'paid' })).rejects.toThrow(UnknownLookupKeyError)
  })

  it('the public LookupDescriptor/Vocabulary/OnDelete types are usable at the barrel (type-only smoke)', () => {
    const desc: LookupDescriptor = enumAlias(['a', 'b'] as const)
    const vocab: Vocabulary = desc.vocabulary
    const onDelete: OnDelete = desc.onDelete
    expect(vocab).toBe('closed')
    expect(onDelete).toBe('restrict')
  })
})
