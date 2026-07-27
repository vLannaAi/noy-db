import { describe, it, expect } from 'vitest'
import { createNoydb, withGuard, InvariantError } from '../../src/index.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../../src/kernel/types.js'
import { ConflictError } from '../../src/kernel/errors.js'
import { ReadOnlyVaultFacade } from '../../src/with-audit/guards/read-only-facade.js'
import { sum } from '../../src/with-lookup/aggregate/reducers.js'
import { withAggregate } from '../../src/with-lookup/aggregate/index.js'

function memory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function getCollection(c: string, col: string) {
    let comp = store.get(c)
    if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col)
    if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    name: 'memory',
    async get(c, col, id) { return store.get(c)?.get(col)?.get(id) ?? null },
    async put(c, col, id, env, ev) {
      const coll = getCollection(c, col)
      const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(c, col, id) { store.get(c)?.get(col)?.delete(id) },
    async list(c, col) { const coll = store.get(c)?.get(col); return coll ? [...coll.keys()] : [] },
    async loadAll(c) {
      const comp = store.get(c); const s: VaultSnapshot = {}
      if (comp) for (const [n, coll] of comp) {
        if (!n.startsWith('_')) {
          const r: Record<string, EncryptedEnvelope> = {}
          for (const [id, e] of coll) r[id] = e
          s[n] = r
        }
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
      if (existing) {
        for (const [name, coll] of existing) {
          if (name.startsWith('_') && !comp.has(name)) comp.set(name, coll)
        }
      }
      store.set(c, comp)
    },
  }
}

describe('ReadOnlyVaultFacade', () => {
  it('exposes get and list, denies writes', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'guards-readonly-facade-secret-2026',
    })
    const vault = await db.openVault('demo')
    await vault.collection('widgets').put('w1', { name: 'red' })

    const facade = new ReadOnlyVaultFacade(vault)
    const got = await facade.collection('widgets').get('w1')
    expect(got).toEqual({ name: 'red' })

    const list = await facade.collection('widgets').list()
    expect(list).toHaveLength(1)

    // No put/delete methods exposed
    expect((facade.collection('widgets') as object).hasOwnProperty('put')).toBe(false)
    expect((facade.collection('widgets') as object).hasOwnProperty('delete')).toBe(false)
  })

  it('exposes query() returning a chainable Query builder', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'guards-readonly-facade-query-secret-2026',
      aggregateStrategy: withAggregate(),
    })
    const vault = await db.openVault('demo')
    const widgets = vault.collection<{ name: string; price: number }>('widgets')
    await widgets.put('w1', { name: 'red', price: 100 })
    await widgets.put('w2', { name: 'blue', price: 200 })
    await widgets.put('w3', { name: 'red', price: 150 })

    const facade = new ReadOnlyVaultFacade(vault)
    const q = facade.collection<{ name: string; price: number }>('widgets').query()

    const reds = await q.where('name', '==', 'red').toArray()
    expect(reds).toHaveLength(2)

    const total = await facade
      .collection<{ name: string; price: number }>('widgets')
      .query()
      .where('name', '==', 'red')
      .aggregate({ total: sum('price') })
      .run()
    expect(total.total).toBe(250)
  })

  it('lets a guard enforce a Σ-over-siblings invariant via query().aggregate()', async () => {
    interface Payment { id: string; amount: number }
    interface Allocation extends Record<string, unknown> { id: string; paymentId: string; appliedAmount: number }

    const allocationGuard = withGuard<Allocation>({
      collection: 'allocations',
      check: async (incoming, { vault, existing }) => {
        const payment = await vault.collection<Payment>('payments').get(incoming.paymentId)
        if (!payment) throw new InvariantError(`unknown paymentId for allocation ${incoming.id}`)
        const { total } = await vault
          .collection<Allocation>('allocations')
          .query()
          .where('paymentId', '==', incoming.paymentId)
          .aggregate({ total: sum('appliedAmount') })
          .run()
        const otherTotal = total - (existing?.appliedAmount ?? 0)
        if (otherTotal + incoming.appliedAmount > payment.amount) {
          throw new InvariantError(
            `Σ allocations (${otherTotal + incoming.appliedAmount}) exceeds payment.amount (${payment.amount})`,
          )
        }
      },
    })

    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'guards-readonly-facade-aggregate-secret-2026',
      guardStrategies: [allocationGuard],
      aggregateStrategy: withAggregate(),
    })
    const vault = await db.openVault('demo')
    const payments = vault.collection<Payment>('payments')
    const allocations = vault.collection<Allocation>('allocations')

    await payments.put('p1', { id: 'p1', amount: 1000 })
    await allocations.put('a1', { id: 'a1', paymentId: 'p1', appliedAmount: 400 })
    await allocations.put('a2', { id: 'a2', paymentId: 'p1', appliedAmount: 500 })

    // Over-allocation fails with InvariantError carrying the aggregated sum.
    await expect(
      allocations.put('a3', { id: 'a3', paymentId: 'p1', appliedAmount: 200 }),
    ).rejects.toBeInstanceOf(InvariantError)

    // Topping up to exactly payment.amount is accepted.
    await expect(
      allocations.put('a3', { id: 'a3', paymentId: 'p1', appliedAmount: 100 }),
    ).resolves.not.toThrow()

    // Existing allocation can be amended downward (subtracts its own contribution from the sum).
    await expect(
      allocations.put('a1', { id: 'a1', paymentId: 'p1', appliedAmount: 300 }),
    ).resolves.not.toThrow()
  })
})
