// #658 — sync-applied deletes reach the MV + array-derivation dispatch wave, on TOP of the
// #640 rollup leg: the LOCAL delete path (`Collection._doDelete`'s `!internal` block) already
// heals rollups + MV rows + array-shape derivation output rows for a deleted child. The
// sync-delete wave (runGraphDispatchWave's deletes loop) recomputed rollup parents only — a
// remotely-deleted child's MV mirror row and array-derivation output row stayed stale. This is
// a parity fix, not a new capability: it brings the wave up to the local boundary. Mirrors
// sync-delete-rollup.test.ts's db2-only-registration, memory-store, and CAS-mock fixture
// discipline; the rollup here is the CONTROL (already passes via #640) alongside the two new
// RED→GREEN assertions.

import { describe, it, expect } from 'vitest'
import { createNoydb, withRollup, withMaterializedView, withDerivation } from '../../src/index.js'
import { withSync } from '../../src/with-party/sync/index.js'
import type { NoydbStore, EncryptedEnvelope } from '../../src/kernel/types.js'

function toMemory(): NoydbStore {
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
        const [vname, cname, id] = key.split('/') as [string, string, string]
        if (vname === v) { out[cname] = out[cname] ?? {}; out[cname]![id] = env }
      }
      return out
    },
    async saveAll(v, payload) {
      for (const c of Object.keys(payload)) {
        for (const i of Object.keys(payload[c]!)) data.set(k(v, c, i), payload[c]![i]!)
      }
    },
  }
}

interface Customer extends Record<string, unknown> { id: string; orderCount?: number }
interface Order extends Record<string, unknown> { id: string; customerId: string; sku?: string }
interface OrderLine extends Record<string, unknown> { id: string; orderId: string; sku: string }

const orderCountRollup = () =>
  withRollup<Order, Customer>({ from: 'orders', key: 'customerId', into: 'customers', field: 'orderCount', compute: (orders) => orders.length })

const ordersMirrorMV = () =>
  withMaterializedView<Order>({
    name: 'orders-mirror',
    query: (db) => db.collection<Order>('orders').query(),
    rowKey: (r) => r.id,
    refresh: 'eager',
  })

const orderLineDerivation = () =>
  withDerivation<Order, { lines: OrderLine[] }>({
    source: 'orders',
    deterministic: true,
    outputs: {
      lines: { shape: 'array', collection: 'orderLines', key: (o) => o.id as string },
    },
    derive: (order) => ({
      lines: order.sku ? [{ id: `${order.id}|${order.sku}`, orderId: order.id, sku: order.sku }] : [],
    }),
    lifecycle: 'eager',
  })

describe('sync-applied deletes reach the MV + array-derivation dispatch wave (#658)', () => {
  it('db2-only registration: a pulled delete heals the MV mirror row and the array-derivation output row (parity with local delete), alongside the #640 rollup CONTROL', async () => {
    const remote = toMemory()
    // db1 is a plain writer — it never registers the MV/derivation/rollup strategies, so
    // whatever ends up in db2's `orders-mirror`/`orderLines`/`customers.orderCount` can only
    // have come from db2's OWN wave-driven recompute (#646 db2-only-registration mandate).
    const db1 = await createNoydb({ store: toMemory(), sync: remote, user: 'user-1', syncStrategy: withSync(), encrypt: false })
    const db2 = await createNoydb({
      store: toMemory(), sync: remote, user: 'user-2', syncStrategy: withSync(), encrypt: false,
      derivationStrategies: [orderCountRollup(), orderLineDerivation()],
      materializedViewStrategies: [ordersMirrorMV()],
    })

    const v1 = await db1.openVault('shop')
    await v1.collection<Customer>('customers').put('c1', { id: 'c1' })
    await v1.collection<Order>('orders').put('o1', { id: 'o1', customerId: 'c1', sku: 'sku-1' })
    await db1.push('shop')

    const v2 = await db2.openVault('shop')
    const customers = v2.collection<Customer>('customers')
    const orders = v2.collection<Order>('orders')
    const ordersMirror = v2.collection<Order>('orders-mirror')
    const orderLines = v2.collection<OrderLine>('orderLines')
    await db2.pull('shop')

    // Keep the child warm in db2's cache before the delete-pull (so the sync-apply delete case's
    // `_peekCached` FK-recovery hits — the rollup control's PUT-time recompute already reads
    // every order via `.get()`, which hydrates `orders` as a side effect, but do it explicitly
    // too so this test isn't accidentally relying on that side effect). Not testing #640's
    // documented cold-child gate here.
    await orders.get('o1')

    // Baseline: all three artifacts exist/are correct after the initial pull.
    expect((await customers.get('c1'))?.orderCount).toBe(1)
    expect(await ordersMirror.get('o1')).not.toBeNull()
    expect(await orderLines.get('o1|sku-1')).not.toBeNull()

    await v1.collection<Order>('orders').delete('o1')
    await db1.push('shop')
    await db2.pull('shop')

    // CONTROL (#640) — passes today: the rollup parent recomputed without the deleted child.
    expect((await customers.get('c1'))?.orderCount).toBe(0)

    // RED (pre-#658) → GREEN (post-#658): the MV mirror row and the array-derivation output
    // row are healed too, matching local delete's boundary — no longer stale.
    expect(await ordersMirror.get('o1')).toBeNull()
    expect(await orderLines.get('o1|sku-1')).toBeNull()

    db1.close(); db2.close()
  })
})
