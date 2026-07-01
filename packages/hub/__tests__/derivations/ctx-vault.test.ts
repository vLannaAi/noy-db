import { describe, it, expect } from 'vitest'
import { createNoydb, withDerivation } from '../../src/index.js'
import type { NoydbStore, EncryptedEnvelope } from '../../src/kernel/types.js'

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
        if (vname === v) {
          out[cname!] = out[cname!] ?? {}
          out[cname!]![id!] = env
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

interface Payment extends Record<string, unknown> { id: string; paymentDate: string; amount: number }
interface Bill extends Record<string, unknown> { id: string; clientId: string; netRemaining: number }
interface Allocation extends Record<string, unknown> { id: string; paymentId: string; billId: string; appliedAmount: number }
interface Receipt extends Record<string, unknown> {
  id: string
  paymentId: string
  billId: string
  clientId: string
  issuedAt: string
  appliedAmount: number
}

describe('Derivation — ctx.vault facade (#147)', () => {
  it('derive(source, ctx) can read sibling collections via ctx.vault.collection().get()', async () => {
    const strategy = withDerivation<Allocation, { receipt: Receipt }>({
      source: 'allocations',
      deterministic: true,
      outputs: { receipt: { shape: 'record', collection: 'receipts' } },
      derive: async (alloc, ctx) => {
        // Without ctx, paymentDate/clientId would have to be denormalised
        // onto the Allocation row and frozen by a paired withGuard.
        // With ctx.vault we read them directly off the sibling records.
        const payment = await ctx.vault.collection<Payment>('payments').get(alloc.paymentId)
        const bill = await ctx.vault.collection<Bill>('bills').get(alloc.billId)
        if (!payment) throw new Error(`allocation ${alloc.id}: unknown paymentId ${alloc.paymentId}`)
        if (!bill) throw new Error(`allocation ${alloc.id}: unknown billId ${alloc.billId}`)
        return {
          receipt: {
            id: alloc.id,
            paymentId: alloc.paymentId,
            billId: alloc.billId,
            clientId: bill.clientId,
            issuedAt: payment.paymentDate,
            appliedAmount: alloc.appliedAmount,
          },
        }
      },
      lifecycle: 'eager',
    })

    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'derivation-ctx-vault-passphrase-2026',
      derivationStrategies: [strategy],
    })
    const v = await db.openVault('demo')

    await v.collection<Payment>('payments').put('p1', { id: 'p1', paymentDate: '2026-05-19', amount: 1000 })
    await v.collection<Bill>('bills').put('b1', { id: 'b1', clientId: 'c-acme', netRemaining: 600 })
    await v.collection<Allocation>('allocations').put('a1', {
      id: 'a1', paymentId: 'p1', billId: 'b1', appliedAmount: 400,
    })

    const receipt = await v.collection<Receipt>('receipts').get('a1')
    expect(receipt).toMatchObject({
      id: 'a1',
      paymentId: 'p1',
      billId: 'b1',
      clientId: 'c-acme',
      issuedAt: '2026-05-19',
      appliedAmount: 400,
    })
  })

  it('ctx.vault has no write capability — no .put / .delete reachable through the facade', async () => {
    let capturedCtx: unknown = null
    const strategy = withDerivation<{ id: string; v: number }, { out: { id: string; v: number } }>({
      source: 'src',
      deterministic: true,
      outputs: { out: { shape: 'record', collection: 'out' } },
      derive: (s, ctx) => {
        capturedCtx = ctx
        return { out: { id: s.id, v: s.v } }
      },
      lifecycle: 'eager',
    })
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'derivation-ctx-no-writes-passphrase-2026',
      derivationStrategies: [strategy],
    })
    const v = await db.openVault('demo')
    await v.collection<{ id: string; v: number }>('src').put('s1', { id: 's1', v: 42 })

    const ctx = capturedCtx as { vault: { collection: (n: string) => Record<string, unknown> } }
    expect(typeof ctx.vault.collection).toBe('function')
    const accessor = ctx.vault.collection('out')
    expect(Object.prototype.hasOwnProperty.call(accessor, 'put')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(accessor, 'delete')).toBe(false)
    expect(typeof (accessor as { get?: unknown }).get).toBe('function')
    expect(typeof (accessor as { list?: unknown }).list).toBe('function')
    expect(typeof (accessor as { query?: unknown }).query).toBe('function')
  })

  it('lazy lifecycle: ctx.vault is available on resolve-on-read too', async () => {
    const strategy = withDerivation<Allocation, { receipt: Receipt }>({
      source: 'allocations',
      deterministic: true,
      outputs: { receipt: { shape: 'record', collection: 'receipts' } },
      derive: async (alloc, ctx) => {
        const payment = await ctx.vault.collection<Payment>('payments').get(alloc.paymentId)
        const bill = await ctx.vault.collection<Bill>('bills').get(alloc.billId)
        return {
          receipt: {
            id: alloc.id,
            paymentId: alloc.paymentId,
            billId: alloc.billId,
            clientId: bill?.clientId ?? '',
            issuedAt: payment?.paymentDate ?? '',
            appliedAmount: alloc.appliedAmount,
          },
        }
      },
      lifecycle: 'lazy',
    })

    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'derivation-ctx-vault-lazy-passphrase-2026',
      derivationStrategies: [strategy],
    })
    const v = await db.openVault('demo')

    await v.collection<Payment>('payments').put('p1', { id: 'p1', paymentDate: '2026-05-20', amount: 500 })
    await v.collection<Bill>('bills').put('b1', { id: 'b1', clientId: 'c-beta', netRemaining: 250 })
    await v.collection<Allocation>('allocations').put('a1', {
      id: 'a1', paymentId: 'p1', billId: 'b1', appliedAmount: 250,
    })
    // Force a re-derive on read: lazy mode marks stale on source write,
    // resolves the receipt on first get(). The sibling reads through
    // ctx.vault prove the facade is wired into the lazy path too.
    await v.collection<Allocation>('allocations').put('a1', {
      id: 'a1', paymentId: 'p1', billId: 'b1', appliedAmount: 250,
    })

    const receipt = await v.collection<Receipt>('receipts').get('a1')
    expect(receipt?.clientId).toBe('c-beta')
    expect(receipt?.issuedAt).toBe('2026-05-20')
  })
})
