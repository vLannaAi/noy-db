/**
 * #1289 — right/full outer joins, the symmetric-alias self cross-join, and
 * Via dressing under an alias.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, money, ref } from '../src/index.js'
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


/** A vault with `invoices.clientId -> clients`, plus a money field on invoices. */
async function fixture() {
  const db = await createNoydb({ store: toMemory(), user: 'u', secret: 'pw-1289' })
  const v = await db.openVault('v')
  const clients = await v.collection<{ name: string }>('clients')
  await clients.put('c1', { name: 'Ann' })
  await clients.put('c2', { name: 'Bo' })
  await clients.put('c3', { name: 'Cy' }) // never referenced — the right-only row
  const invoices = await v.collection<{ clientId: string | null; amount: string }>('invoices', {
    refs: { clientId: ref('clients') },
    moneyFields: { amount: money({ currency: 'USD' }) },
  })
  await invoices.put('i1', { clientId: 'c1', amount: '10.00' })
  await invoices.put('i2', { clientId: 'c1', amount: '20.00' })
  await invoices.put('i3', { clientId: 'c2', amount: '30.00' })
  await invoices.put('i4', { clientId: null, amount: '40.00' }) // left-only row
  return { db, v, clients, invoices }
}

describe('#1289 > .rightJoin()', () => {
  it('emits every right-side record, including one nothing points at', async () => {
    const { invoices } = await fixture()
    const rows = invoices.query().rightJoin<'client', { id: string; name: string }>('clientId', { as: 'client' }).toArray()
    const names = rows.map(r => r.client.name).sort()
    expect(names).toEqual(['Ann', 'Ann', 'Bo', 'Cy'])
  })

  it('the unmatched right row carries no left fields', async () => {
    const { invoices } = await fixture()
    const rows = invoices.query().rightJoin<'client', { id: string; name: string }>('clientId', { as: 'client' }).toArray()
    const orphan = rows.find(r => r.client.name === 'Cy')!
    expect(orphan.amount).toBeUndefined()
    expect(Object.keys(orphan)).toEqual(['client'])
  })

  it('drops the left row whose FK is null — that is what makes it a RIGHT join', async () => {
    const { invoices } = await fixture()
    const rows = invoices.query().rightJoin<'client', { id: string; name: string }>('clientId', { as: 'client' }).toArray()
    expect(rows.some(r => r.amount === '40.00')).toBe(false)
  })

  it('count() reports the right-join cardinality, not the left one', async () => {
    const { invoices } = await fixture()
    expect(invoices.query().rightJoin('clientId', { as: 'client' }).count()).toBe(4)
    expect(invoices.query().count()).toBe(4) // left cardinality happens to also be 4 — assert the shape below
    expect(invoices.query().rightJoin('clientId', { as: 'client' }).toArray().length).toBe(4)
  })
})

describe('#1289 > .fullOuterJoin()', () => {
  it('emits matched rows, the unmatched right row, and the unmatched left row', async () => {
    const { invoices } = await fixture()
    const rows = invoices.query().fullOuterJoin<'client', { id: string; name: string }>('clientId', { as: 'client' }).toArray()
    expect(rows.length).toBe(5)
    // the right-only row
    expect(rows.filter(r => r.client !== null && r.client.name === 'Cy' && r.amount === undefined).length).toBe(1)
    // the left-only row
    expect(rows.filter(r => r.client === null && r.amount === '40.00').length).toBe(1)
    // the three matched rows
    expect(rows.filter(r => r.client !== null && r.amount !== undefined).length).toBe(3)
  })

  it('count() reports the full-outer cardinality', async () => {
    const { invoices } = await fixture()
    expect(invoices.query().fullOuterJoin('clientId', { as: 'client' }).count()).toBe(5)
  })
})

describe('#1289 > .crossJoinWith({ leftAs, rightAs })', () => {
  it('aliases BOTH sides of a self cross-join', async () => {
    const { invoices } = await fixture()
    const rows = invoices.query()
      .where('clientId', '==', 'c1')
      .crossJoinWith({ leftAs: 'a', rightAs: 'b', on: (l) => [l] })
      .toArray()
    expect(rows.length).toBe(2)
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual(['a', 'b'])
      expect(r.a.amount).toBeDefined()
      expect(r.b.amount).toBeDefined()
    }
  })

  it('full self product without on:', async () => {
    const { invoices } = await fixture()
    const rows = invoices.query().crossJoinWith({ leftAs: 'a', rightAs: 'b' }).toArray()
    expect(rows.length).toBe(16)
  })
})

describe('#1289 > Via dressing survives aliasing — the centre of this work', () => {
  it('money is dressed on BOTH sides of crossJoinWith', async () => {
    const { invoices } = await fixture()
    const rows = invoices.query().crossJoinWith({ leftAs: 'a', rightAs: 'b' }).toArray()
    for (const r of rows) {
      expect(r.a.amount).toMatch(/^\d+\.\d\d$/)
      expect(r.b.amount).toMatch(/^\d+\.\d\d$/)
    }
    const amounts = new Set(rows.map(r => r.a.amount))
    expect(amounts).toEqual(new Set(['10.00', '20.00', '30.00', '40.00']))
    expect(new Set(rows.map(r => r.b.amount))).toEqual(amounts)
  })

  it('#1335 — a plain self crossJoin dresses the RIGHT alias too', async () => {
    const { invoices } = await fixture()
    const rows = invoices.query().crossJoin<{ amount: string }, 'other'>('invoices', { as: 'other' }).toArray()
    for (const r of rows) {
      expect((r as { amount: string }).amount).toMatch(/^\d+\.\d\d$/)
      expect(r.other.amount).toMatch(/^\d+\.\d\d$/)
    }
  })

  it('money is dressed under a rightJoin alias when the right side declares it', async () => {
    const db = await createNoydb({ store: toMemory(), user: 'u', secret: 'pw-1289b' })
    const v = await db.openVault('v')
    const plans = await v.collection<{ fee: string }>('plans', { moneyFields: { fee: money({ currency: 'USD' }) } })
    await plans.put('p1', { fee: '99.00' })
    await plans.put('p2', { fee: '55.00' })
    const subs = await v.collection<{ planId: string }>('subs', { refs: { planId: ref('plans') } })
    await subs.put('s1', { planId: 'p1' })
    const rows = subs.query().rightJoin<'plan', { fee: string }>('planId', { as: 'plan' }).toArray()
    expect(rows.map(r => r.plan.fee).sort()).toEqual(['55.00', '99.00'])
  })
})

describe('#1289 > explain() names the new strategies', () => {
  it('a rightJoin leg is labelled as such', async () => {
    const { invoices } = await fixture()
    const ex = invoices.query().rightJoin('clientId', { as: 'client' }).explain()
    expect(ex.text).toMatch(/right outer/)
  })

  it('a crossJoinWith clause names both aliases', async () => {
    const { invoices } = await fixture()
    const ex = invoices.query().crossJoinWith({ leftAs: 'a', rightAs: 'b' }).explain()
    expect(ex.text).toMatch(/a x b/)
  })
})
