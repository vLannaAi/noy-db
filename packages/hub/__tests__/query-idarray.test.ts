/**
 * Query._idArray() — id projection via reference identity (#308 L3).
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, money } from '../src/index.js'
import { Query } from '../src/query/builder.js'
import type { QuerySource, JoinContext, JoinableSource } from '../src/query/index.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { ConflictError } from '../src/kernel/errors.js'

function staticSourceWithEntries<T extends object>(
  records: T[],
): QuerySource<T> & { snapshotEntries(): readonly { id: string; record: T }[] } {
  const entries = records.map((r, i) => ({ id: `id${i}`, record: r }))
  return {
    snapshot: () => records,
    snapshotEntries: () => entries,
  }
}

function mockJoinContext(sources: Record<string, unknown[]>): JoinContext {
  return {
    leftCollection: 'left',
    resolveRef: () => null,
    resolveSource: (name: string): JoinableSource | null => {
      const snap = sources[name]
      return snap !== undefined ? { snapshot: () => snap } : null
    },
  }
}

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

describe('Query._idArray()', () => {
  it('returns the ids of records matching the plan', async () => {
    const db = await createNoydb({ store: memory(), user: 'u', secret: 'pw-idarray-1' })
    const v = await db.openVault('v')
    const c = await v.collection<{ status: string; amount: number }>('orders')
    await c.put('o1', { status: 'open', amount: 10 })
    await c.put('o2', { status: 'closed', amount: 20 })
    await c.put('o3', { status: 'open', amount: 30 })
    const q = c.query().where('status', '==', 'open')
    expect(new Set((q as unknown as { _idArray(): string[] })._idArray())).toEqual(new Set(['o1', 'o3']))
  })

  it('recovers ids even when a money field forces decoded copies in toArray', async () => {
    const db = await createNoydb({ store: memory(), user: 'u', secret: 'pw-idarray-1' })
    const v = await db.openVault('v')
    const c = await v.collection<{ status: string; price: string }>('inv', {
      moneyFields: { price: money({ currency: 'USD' }) },
    })
    await c.put('a', { status: 'open', price: '10.00' })
    await c.put('b', { status: 'open', price: '20.00' })
    await c.put('z', { status: 'closed', price: '5.00' })
    const q = c.query().where('status', '==', 'open')
    expect(new Set((q as unknown as { _idArray(): string[] })._idArray())).toEqual(new Set(['a', 'b']))
  })

  it('throws on a source without snapshotEntries', async () => {
    const { Query } = await import('../src/query/builder.js')
    const raw = new Query<{ x: number }>({ snapshot: () => [{ x: 1 }] })
    expect(() => (raw as unknown as { _idArray(): string[] })._idArray()).toThrow(/snapshotEntries/)
  })
})

describe('Query._idArray() > crossJoin guard', () => {
  it('throws with a crossJoin message when the plan contains a crossJoin clause', () => {
    const RIGHT = [{ name: 'Alice' }, { name: 'Bob' }]
    const jc = mockJoinContext({ workers: RIGHT })
    const source = staticSourceWithEntries([{ id: 'p1' }, { id: 'p2' }])
    const q = new Query(source, { clauses: [], orderBy: [], limit: undefined, offset: 0, joins: [] }, jc)
      .crossJoin('workers', { as: 'worker' })
    expect(() => (q as unknown as { _idArray(): string[] })._idArray()).toThrow(/crossJoin/)
  })

  it('does NOT throw for a where-only query (no false-trip on existing within tests)', () => {
    const source = staticSourceWithEntries([{ status: 'open' }, { status: 'closed' }])
    const q = new Query(source).where('status', '==', 'open')
    expect(() => (q as unknown as { _idArray(): string[] })._idArray()).not.toThrow()
  })
})
