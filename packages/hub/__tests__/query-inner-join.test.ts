/**
 * #1361 — `.join(field, { mode: 'inner' })`.
 *
 * The alias-null idiom (`.join(f, { as }).where(as, '!=', null)`) already
 * expresses an inner join and must keep working byte-for-byte. What it cannot
 * do is keep the ordering on the PRE-join side: the predicate addresses the
 * alias, so #1030 moves the whole sort/page behind the legs. `mode: 'inner'`
 * exists to buy the same rows on the pre-join ordering path.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, ref } from '../src/index.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { ConflictError } from '../src/kernel/errors.js'

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

interface Client { name: string }
interface Invoice { clientId: string | null; total: number }

/**
 * Four invoices, two of which have NO match on the right:
 *   i4 — a null FK ("no reference at all")
 *   i5 — a dangling FK under ref mode 'cascade' (silent null)
 * Both are exactly the rows an inner join must drop, and both sit INSIDE the
 * top-3 window by `total`, so a placement bug shows up as wrong rows rather
 * than as a lucky pass.
 */
async function fixture() {
  const db = await createNoydb({ store: toMemory(), user: 'u', secret: 'pw-1361' })
  const v = await db.openVault('v')
  const clients = await v.collection<Client>('clients')
  await clients.put('c1', { name: 'Ann' })
  await clients.put('c2', { name: 'Bo' })
  const invoices = await v.collection<Invoice>('invoices', {
    refs: { clientId: ref('clients', 'cascade') },
  })
  await invoices.put('i1', { clientId: 'c1', total: 10 })
  await invoices.put('i2', { clientId: 'c1', total: 20 })
  await invoices.put('i3', { clientId: 'c2', total: 30 })
  await invoices.put('i4', { clientId: null, total: 40 })
  await invoices.put('i5', { clientId: 'gone', total: 50 })
  return { invoices }
}

describe('#1361 > mode: inner', () => {
  it('drops every left row the alias could not resolve', async () => {
    const { invoices } = await fixture()
    const rows = invoices
      .query()
      .join<'client', Client & { id: string }>('clientId', { as: 'client', mode: 'inner' })
      .toArray()
    expect(rows.map(r => r.total).sort((a, b) => a - b)).toEqual([10, 20, 30])
    // The alias is non-nullable — this line does not compile if the type is `| null`.
    const names: string[] = rows.map(r => r.client.name)
    expect(names.sort()).toEqual(['Ann', 'Ann', 'Bo'])
  })

  it('returns exactly the rows the alias-null idiom returns, under orderBy + limit', async () => {
    const { invoices } = await fixture()
    const idiom = invoices
      .query()
      .join<'client', Client & { id: string }>('clientId', { as: 'client' })
      .where('client' as never, '!=', null)
      .orderBy('total', 'desc')
      .limit(2)
      .toArray()
    const inner = invoices
      .query()
      .join<'client', Client & { id: string }>('clientId', { as: 'client', mode: 'inner' })
      .orderBy('total', 'desc')
      .limit(2)
      .toArray()
    expect(inner.map(r => r.total)).toEqual([30, 20])
    expect(inner).toEqual(idiom)
  })

  it('keeps the PRE-join ordering path the idiom loses', async () => {
    const { invoices } = await fixture()
    const idiom = invoices
      .query()
      .join<'client', Client & { id: string }>('clientId', { as: 'client' })
      .where('client' as never, '!=', null)
      .orderBy('total', 'desc')
      .limit(2)
      .explain()
    const inner = invoices
      .query()
      .join<'client', Client & { id: string }>('clientId', { as: 'client', mode: 'inner' })
      .orderBy('total', 'desc')
      .limit(2)
      .explain()

    expect(idiom.nodes.find(n => n.op === 'orderBy')!.notes).toContain('post-join')
    expect(inner.nodes.find(n => n.op === 'orderBy')!.notes).toContain('pre-join')
    // Pagination cannot precede the drop, so the PAGE is behind the legs even
    // though the SORT is not — explain() reports the split rather than one word
    // for both.
    expect(inner.nodes.find(n => n.op === 'page')!.notes).toContain('post-join')
    const nodes = inner.nodes
    expect(nodes.findIndex(n => n.op === 'join')).toBeGreaterThan(nodes.findIndex(n => n.op === 'orderBy'))
    expect(nodes.findIndex(n => n.op === 'join')).toBeLessThan(nodes.findIndex(n => n.op === 'page'))
    expect(nodes.find(n => n.op === 'join')!.notes.join(' ')).toContain('inner')
  })

  it('count() reflects the dropped rows', async () => {
    const { invoices } = await fixture()
    expect(invoices.query().join('clientId', { as: 'client', mode: 'inner' }).count()).toBe(3)
    expect(invoices.query().join('clientId', { as: 'client' }).count()).toBe(5)
  })

  it('exists() is false when every left row is unmatched', async () => {
    const { invoices } = await fixture()
    const none = invoices
      .query()
      .where('total', '>', 35)
      .join('clientId', { as: 'client', mode: 'inner' })
    expect(none.exists()).toBe(false)
    expect(none.count()).toBe(0)
  })

  it('the idiom still works, unchanged', async () => {
    const { invoices } = await fixture()
    const rows = invoices
      .query()
      .join<'client', Client & { id: string }>('clientId', { as: 'client' })
      .where('client' as never, '!=', null)
      .toArray()
    expect(rows.map(r => r.total).sort((a, b) => a - b)).toEqual([10, 20, 30])
  })

  it('a plain left join still keeps the unmatched rows with a null alias', async () => {
    const { invoices } = await fixture()
    const rows = invoices.query().join<'client', Client & { id: string }>('clientId', { as: 'client' }).toArray()
    expect(rows).toHaveLength(5)
    expect(rows.filter(r => r.client === null)).toHaveLength(2)
  })
})
