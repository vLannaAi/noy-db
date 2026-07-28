// #640 — sync-applied deletes reach the rollup dispatch wave (three coherent layers): the pull
// loop classifies tombstone/delete-marker applies, the `cacheInvalidator` seam carries the
// action kind, `GraphBatch` entries gain a delete-kind (resolved rollup-parent intents, ids/
// names only), and the wave routes them to rollup-on-delete recompute — mirroring the LOCAL
// delete path's `dispatchRollupsOnDelete` trio (never `dispatchDerivations` —
// mutation-choke-point.test.ts:85-99's pin). Riders: #644 items 1+3 (stale-open batch
// clear-on-error; the structured 'derivation:wave-error' event) + #646's db2-only-registration
// fixture discipline (the rollup is declared on the PULLING side only).

import { describe, it, expect, vi } from 'vitest'
import { createNoydb, withRollup } from '../../src/index.js'
import { withSync } from '../../src/with-party/sync/index.js'
import { isDeleteMarker, isTombstoneShape } from '../../src/kernel/enclave/index.js'
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
interface Order extends Record<string, unknown> { id: string; customerId: string }

const orderCountRollup = () =>
  withRollup<Order, Customer>({ from: 'orders', key: 'customerId', into: 'customers', field: 'orderCount', compute: (orders) => orders.length })

describe('sync-applied deletes reach the rollup dispatch wave (#640)', () => {
  it('db2-only registration (#646): pulled deletes recompute the parent — dedup, ordering, freshness', async () => {
    const remote = toMemory()
    // db1 is a plain writer — it never registers the rollup, so any `orderCount` db2 ends up
    // with can only have come from db2's OWN wave-driven recompute (#646 mandate).
    const db1 = await createNoydb({ store: toMemory(), sync: remote, user: 'user-1', syncStrategy: withSync(), encrypt: false })
    const db2 = await createNoydb({
      store: toMemory(), sync: remote, user: 'user-2', syncStrategy: withSync(), encrypt: false,
      derivationStrategies: [orderCountRollup()],
    })

    const v1 = await db1.openVault('shop')
    await v1.collection<Customer>('customers').put('c1', { id: 'c1' })
    await v1.collection<Order>('orders').put('o1', { id: 'o1', customerId: 'c1' })
    await v1.collection<Order>('orders').put('o2', { id: 'o2', customerId: 'c1' })
    await v1.collection<Order>('orders').put('o3', { id: 'o3', customerId: 'c1' })
    await db1.push('shop')

    const v2 = await db2.openVault('shop')
    const customers = v2.collection<Customer>('customers')
    const orders = v2.collection<Order>('orders')
    await db2.pull('shop')
    expect((await customers.get('c1'))?.orderCount).toBe(3)

    // #640 repro: db1 deletes TWO of the three orders (a delete-marker each) + pushes; db2 pulls
    // once. Wave dedup must collapse both child-deletes into exactly ONE parent recompute write.
    const putSpy = vi.spyOn(customers, 'put')
    await v1.collection<Order>('orders').delete('o1')
    await v1.collection<Order>('orders').delete('o2')
    await db1.push('shop')
    await db2.pull('shop')
    expect((await customers.get('c1'))?.orderCount).toBe(1) // 3 - 2, gap-free
    expect(putSpy).toHaveBeenCalledTimes(1) // deduped: 2 deleted children → ONE recompute write

    // Freshness-not-forget pin: the pulled delete leaves an ORDINARY delete-marker (freshness
    // only) — never a crypto-shred tombstone (that's `forget()`'s job, never sync's).
    const rawEnv = await remote.get('shop', 'orders', 'o1')
    expect(rawEnv).not.toBeNull()
    expect(isDeleteMarker(rawEnv!)).toBe(true)
    expect(isTombstoneShape(rawEnv!)).toBe(false)

    // Ordering pin: a delete of the last remaining original child + a put of a NEW sibling, in
    // the SAME pull, must reflect the FINAL store state (both applied before the wave flushes).
    putSpy.mockClear()
    await v1.collection<Order>('orders').delete('o3')
    await v1.collection<Order>('orders').put('o4', { id: 'o4', customerId: 'c1' })
    await db1.push('shop')
    await db2.pull('shop')
    expect((await customers.get('c1'))?.orderCount).toBe(1) // o3 gone, o4 arrived — net 1
    expect(await orders.get('o1')).toBeNull() // deleted children stay gone (sanity)

    db1.close(); db2.close()
  })

  it('#644 item 3: a wave recompute error on the DELETE path emits derivation:wave-error additively to console.warn', async () => {
    const remote = toMemory()
    const boom = new Error('rollup compute exploded')
    const throwingRollup = () =>
      withRollup<Order, Customer>({
        from: 'orders', key: 'customerId', into: 'customers', field: 'orderCount',
        compute: () => { throw boom },
      })
    const db1 = await createNoydb({ store: toMemory(), sync: remote, user: 'user-1', syncStrategy: withSync(), encrypt: false })
    const db2 = await createNoydb({
      store: toMemory(), sync: remote, user: 'user-2', syncStrategy: withSync(), encrypt: false,
      derivationStrategies: [throwingRollup()],
    })

    const v1 = await db1.openVault('shop')
    await v1.collection<Customer>('customers').put('c1', { id: 'c1' })
    await v1.collection<Order>('orders').put('o1', { id: 'o1', customerId: 'c1' })
    await db1.push('shop')

    const v2 = await db2.openVault('shop')
    v2.collection<Customer>('customers'); v2.collection<Order>('orders')
    await db2.pull('shop') // baseline pull — the initial put-driven recompute also throws+recovers (unobserved below)

    const events: unknown[] = []
    db2.on('derivation:wave-error', (e) => events.push(e))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await v1.collection<Order>('orders').delete('o1')
    await db1.push('shop')
    const pullResult = await db2.pull('shop') // must not throw/abort despite the recompute error

    expect(pullResult.errors).toHaveLength(0) // isolated to the one failed target, per #638 Task 5
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ collection: 'orders', id: 'o1', error: boom })
    expect(warnSpy).toHaveBeenCalled() // additive — console.warn still fires (not replaced)

    warnSpy.mockRestore()
    db1.close(); db2.close()
  })
})
