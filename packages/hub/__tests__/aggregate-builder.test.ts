/**
 * Runtime coverage for the aggregate() builder form (`aggregate(b => spec)`).
 *
 * Verifies that:
 *   1. The builder form produces the same result as the bare-spec form.
 *   2. Money-typed builder methods (`b.moneySum`) return a decimal string.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, sum, count, moneySum } from '../src/index.js'
import { withAggregate } from '../src/with-lookup/aggregate/index.js'
import { money } from '../src/with-shape/money/descriptor.js'
import type { NoydbStore, EncryptedEnvelope } from '../src/types.js'

function memory(): NoydbStore {
  const data = new Map<string, EncryptedEnvelope>()
  const k = (v: string, c: string, i: string) => `${v}/${c}/${i}`
  return {
    capabilities: { casAtomic: true, auth: { kind: 'none', required: false, flow: 'static' } },
    async get(v, c, i) { return data.get(k(v, c, i)) ?? null },
    async put(v, c, i, env) { data.set(k(v, c, i), env) },
    async delete(v, c, i) { data.delete(k(v, c, i)) },
    async list(v, c) {
      const prefix = `${v}/${c}/`
      return [...data.keys()].filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length))
    },
    async loadAll(v) {
      const out: Record<string, Record<string, EncryptedEnvelope>> = {}
      for (const [key, env] of data) {
        const [vname, cname, id] = key.split('/')
        if (vname === v) { out[cname!] = out[cname!] ?? {}; out[cname!]![id!] = env }
      }
      return out
    },
    async saveAll(v, payload) {
      for (const c of Object.keys(payload)) {
        for (const i of Object.keys(payload[c]!)) { data.set(k(v, c, i), payload[c]![i]!) }
      }
    },
  }
}

interface Order extends Record<string, unknown> { id: string; amount: number; total: number | string }

async function ordersWith3() {
  const db = await createNoydb({
    store: memory(),
    user: 'alice',
    secret: 'aggregate-builder-passphrase-2026-test-x1',
    aggregateStrategy: withAggregate(),
  })
  const vault = await db.openVault('shop')
  const orders = vault.collection<Order>('orders', {
    moneyFields: { total: money({ currency: 'USD', scale: 2 }) },
  })
  await orders.put('a', { id: 'a', amount: 10, total: '10.00' })
  await orders.put('b', { id: 'b', amount: 20, total: '20.00' })
  await orders.put('c', { id: 'c', amount: 30, total: '30.00' })
  return orders
}

describe('aggregate() builder form — runtime', () => {
  it('builder form produces same result as bare-spec form', async () => {
    const orders = await ordersWith3()
    const q = orders.query()

    const bareResult = await q.aggregate({ total: sum('amount'), n: count() }).run()
    const builderResult = await q.aggregate(b => ({ total: b.sum('amount'), n: b.count() })).run()

    expect(builderResult.total).toBe(bareResult.total)
    expect(builderResult.n).toBe(bareResult.n)
    expect(builderResult.total).toBe(60)
    expect(builderResult.n).toBe(3)
  })

  it('b.moneySum returns a decimal string (exact)', async () => {
    const orders = await ordersWith3()
    const r = await orders.query().aggregate(b => ({ total: b.moneySum('total') })).run()
    expect(r.total).toBe('60.00')
  })

  it('bare-spec aggregate still works (non-breaking)', async () => {
    const orders = await ordersWith3()
    const r = await orders.query().aggregate({ total: moneySum('total') }).run()
    expect(r.total).toBe('60.00')
  })
})
