/**
 * Tests for the interaction between computed fields and the guard subsystem.
 * Covers the three required scenarios from the review:
 *   1. frozenFields × computed — no false-positive FieldFrozenError
 *   2. computed re-eval on update — stale values not persisted
 *   3. computed × immutableGuard combo — WORM semantics preserved
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, withGuard, FieldFrozenError, NoydbError, RecordLockedError } from '../../src/index.js'
import { immutableGuard } from '../../src/guards/immutable-guard.js'
import { withTransactions } from '../../src/tx/index.js'
import type { NoydbStore, EncryptedEnvelope } from '../../src/types.js'

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
        if (vname === v && cname !== undefined && id !== undefined) {
          out[cname] = out[cname] ?? {}
          out[cname]![id] = env
        }
      }
      return out
    },
    async saveAll(v, payload) {
      for (const c of Object.keys(payload)) {
        for (const i of Object.keys(payload[c]!)) {
          data.set(k(v, c, i), payload[c]![i]!)
        }
      }
    },
  }
}

interface Order extends Record<string, unknown> {
  id: string
  unitPrice: number
  qty: number
  status: string
  /** computed field */
  total?: number
  /** non-computed frozen field */
  orderRef?: string
}

// ─── Scenario 1: frozenFields × computed ──────────────────────────────────────

describe('frozenFields × computed — no false-positive FieldFrozenError', () => {
  it('does NOT throw FieldFrozenError when updating a non-frozen field beside a computed-frozen field', async () => {
    // The guard freezes `total` once status==='confirmed'. But `total` is also
    // a computed field (unitPrice * qty). On an update that changes qty (thus
    // re-computing a new total), the gate must not compare raw incoming.total
    // (undefined/stale) against existing.total (prior computed value).
    const guard = withGuard<Order>({
      collection: 'orders',
      frozenFields: {
        when: (r) => r.status === 'confirmed',
        fields: ['total', 'orderRef'],
      },
    })
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'computed-frozen-interplay-passphrase-2026',
      guardStrategies: [guard],
    })
    const vault = await db.openVault('shop')
    vault.collection<Order>('orders', {
      computed: {
        total: (r) => (r.unitPrice as number) * (r.qty as number),
      },
    })
    const orders = vault.collection<Order>('orders')

    // Insert — total is computed to 10*2=20
    await orders.put('o1', { id: 'o1', unitPrice: 10, qty: 2, status: 'confirmed', orderRef: 'REF-1' })
    expect((await orders.get('o1'))?.total).toBe(20)

    // Update qty (non-frozen, non-computed field) — must NOT throw FieldFrozenError
    // because `total` is a computed field and its new value is legitimately recomputed
    await expect(
      orders.put('o1', { id: 'o1', unitPrice: 10, qty: 3, status: 'confirmed', orderRef: 'REF-1' }),
    ).resolves.not.toThrow()

    // New total is 10*3=30
    expect((await orders.get('o1'))?.total).toBe(30)
  })

  it('still blocks mutation of a genuinely frozen NON-computed field', async () => {
    const guard = withGuard<Order>({
      collection: 'orders',
      frozenFields: {
        when: (r) => r.status === 'confirmed',
        fields: ['total', 'orderRef'],
      },
    })
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'computed-frozen-non-computed-passphrase-2026',
      guardStrategies: [guard],
    })
    const vault = await db.openVault('shop')
    vault.collection<Order>('orders', {
      computed: {
        total: (r) => (r.unitPrice as number) * (r.qty as number),
      },
    })
    const orders = vault.collection<Order>('orders')

    await orders.put('o1', { id: 'o1', unitPrice: 10, qty: 2, status: 'confirmed', orderRef: 'REF-1' })

    // Changing orderRef (NOT a computed field) must still throw FieldFrozenError
    await expect(
      orders.put('o1', { id: 'o1', unitPrice: 10, qty: 2, status: 'confirmed', orderRef: 'REF-CHANGED' }),
    ).rejects.toBeInstanceOf(FieldFrozenError)
  })

  it('confirms FieldFrozenError is instanceof NoydbError (Fix 1 regression)', async () => {
    const guard = withGuard<Order>({
      collection: 'orders',
      frozenFields: {
        when: (r) => r.status === 'confirmed',
        fields: ['orderRef'],
      },
    })
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'frozen-noydb-error-passphrase-2026',
      guardStrategies: [guard],
    })
    const vault = await db.openVault('shop')
    const orders = vault.collection<Order>('orders')
    await orders.put('o1', { id: 'o1', unitPrice: 5, qty: 1, status: 'confirmed', orderRef: 'REF-1' })
    try {
      await orders.put('o1', { id: 'o1', unitPrice: 5, qty: 1, status: 'confirmed', orderRef: 'REF-2' })
      expect.fail('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(FieldFrozenError)
      expect(e).toBeInstanceOf(NoydbError)
    }
  })
})

// ─── Scenario 2: computed re-eval on update ────────────────────────────────────

describe('computed re-eval on update — fields reflect NEW inputs', () => {
  it('puts twice with different raw inputs → computed fields reflect the new inputs', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'computed-reeval-passphrase-2026',
    })
    const vault = await db.openVault('shop')
    vault.collection<Order>('orders', {
      computed: {
        total: (r) => (r.unitPrice as number) * (r.qty as number),
      },
    })
    const orders = vault.collection<Order>('orders')

    await orders.put('o1', { id: 'o1', unitPrice: 10, qty: 2, status: 'draft' })
    expect((await orders.get('o1'))?.total).toBe(20)

    // Second put with different inputs — computed must reflect new values, not stale
    await orders.put('o1', { id: 'o1', unitPrice: 10, qty: 5, status: 'draft' })
    expect((await orders.get('o1'))?.total).toBe(50)
  })
})

// ─── Scenario 3: computed × immutableGuard combo ──────────────────────────────

describe('computed × immutableGuard — WORM semantics preserved', () => {
  it('create fires computed; WORM allows; transition to immutable; update attempt blocked', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'computed-immutable-guard-passphrase-2026',
      guardStrategies: [
        immutableGuard<Order>({
          collection: 'orders',
          after: (r) => r.status === 'confirmed',
        }),
      ],
      txStrategy: withTransactions(),
    })
    const vault = await db.openVault('shop')
    vault.collection<Order>('orders', {
      computed: {
        total: (r) => (r.unitPrice as number) * (r.qty as number),
      },
    })
    const orders = vault.collection<Order>('orders')

    // create — computed fires, WORM allows (record is draft)
    await orders.put('o1', { id: 'o1', unitPrice: 10, qty: 2, status: 'draft' })
    expect((await orders.get('o1'))?.total).toBe(20)

    // transition write to 'confirmed' — WORM still allows (checks existing=draft)
    await orders.put('o1', { id: 'o1', unitPrice: 10, qty: 2, status: 'confirmed' })
    expect((await orders.get('o1'))?.status).toBe('confirmed')
    expect((await orders.get('o1'))?.total).toBe(20)

    // update attempt blocked by WORM — existing is now 'confirmed'
    await expect(
      orders.put('o1', { id: 'o1', unitPrice: 10, qty: 3, status: 'confirmed' }),
    ).rejects.toBeInstanceOf(RecordLockedError)

    // total remains unchanged (WORM held)
    expect((await orders.get('o1'))?.total).toBe(20)
  })
})
