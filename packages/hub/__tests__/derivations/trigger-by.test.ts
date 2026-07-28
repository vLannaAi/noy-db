// FK-keyed derivation triggers — reverse-denormalization (#376 Slice 1).
//
// `triggerBy: [{ collection, on }]` fans a PARENT write out to every source
// record whose FK matches, re-deriving each. A self-write output (collection
// === source) declaring `denorm` patches only those fields back onto the
// source record — field-level provenance — and the value-equality guard
// terminates the self-write recursion.

import { describe, it, expect } from 'vitest'
import { createNoydb, withDerivation, ValidationError, DerivationCapExceededError } from '../../src/index.js'
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
        const [vname, cname, id] = key.split('/')
        if (vname === v && cname && id) { out[cname] = out[cname] ?? {}; out[cname]![id] = env }
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

interface Buyer extends Record<string, unknown> { id: string; companyName: string }
interface Sale extends Record<string, unknown> { id: string; buyerId: string; total: number; buyerName?: string; note?: string }

function buyerNameDenorm(extra: { indexed?: boolean } = {}) {
  return withDerivation<Sale, { self: Sale }>({
    source: 'sales',
    deterministic: true,
    triggerBy: [{ collection: 'buyers', on: 'buyerId' }],
    outputs: { self: { shape: 'record', collection: 'sales', denorm: ['buyerName'] } },
    derive: async (sale, ctx) => {
      const b = await ctx.vault.collection<Buyer>('buyers').get(sale.buyerId)
      return { self: { ...sale, buyerName: b?.companyName ?? sale.buyerName ?? null } as Sale }
    },
    lifecycle: 'eager',
  })
}

describe('triggerBy — factory validation (#376)', () => {
  it('rejects triggerBy.collection equal to source', () => {
    expect(() =>
      withDerivation<Sale, { self: Sale }>({
        source: 'sales',
        deterministic: true,
        triggerBy: [{ collection: 'sales', on: 'buyerId' }],
        outputs: { self: { shape: 'record', collection: 'sales', denorm: ['buyerName'] } },
        derive: (s) => ({ self: s }),
        lifecycle: 'eager',
      }),
    ).toThrow(ValidationError)
  })
  it('rejects a triggerBy entry missing `on`', () => {
    expect(() =>
      withDerivation<Sale, { self: Sale }>({
        source: 'sales',
        deterministic: true,
        triggerBy: [{ collection: 'buyers', on: '' }],
        outputs: { self: { shape: 'record', collection: 'sales', denorm: ['buyerName'] } },
        derive: (s) => ({ self: s }),
        lifecycle: 'eager',
      }),
    ).toThrow(ValidationError)
  })
  it('rejects a self-write output without denorm', () => {
    expect(() =>
      withDerivation<Sale, { self: Sale }>({
        source: 'sales',
        deterministic: true,
        triggerBy: [{ collection: 'buyers', on: 'buyerId' }],
        outputs: { self: { shape: 'record', collection: 'sales' } },
        derive: (s) => ({ self: s }),
        lifecycle: 'eager',
      }),
    ).toThrow(ValidationError)
  })
})

describe('triggerBy — reverse-denormalization fan-out (#376)', () => {
  async function setup(indexed = false) {
    const db = await createNoydb({
      store: toMemory(), user: 'alice', secret: 'trigger-by-secret-2026',
      derivationStrategies: [buyerNameDenorm()],
    })
    const v = await db.openVault('firm')
    const buyers = v.collection<Buyer>('buyers')
    const sales = indexed
      ? v.collection<Sale>('sales', { indexes: ['buyerId'] })
      : v.collection<Sale>('sales')
    return { db, v, buyers, sales }
  }

  it('a parent rename fans out to every matching source record', async () => {
    const { buyers, sales } = await setup()
    await buyers.put('b1', { id: 'b1', companyName: 'Acme' })
    await buyers.put('b2', { id: 'b2', companyName: 'Globex' })
    await sales.put('s1', { id: 's1', buyerId: 'b1', total: 100 })
    await sales.put('s2', { id: 's2', buyerId: 'b1', total: 200 })
    await sales.put('s3', { id: 's3', buyerId: 'b2', total: 300 })

    // On insert (sale write, source path) buyerName is already stamped.
    expect((await sales.get('s1'))?.buyerName).toBe('Acme')
    expect((await sales.get('s3'))?.buyerName).toBe('Globex')

    // Rename the parent → fan out to b1's sales only.
    await buyers.put('b1', { id: 'b1', companyName: 'Acme Corp' })
    expect((await sales.get('s1'))?.buyerName).toBe('Acme Corp')
    expect((await sales.get('s2'))?.buyerName).toBe('Acme Corp')
    expect((await sales.get('s3'))?.buyerName).toBe('Globex') // untouched
  })

  it('works the same with an FK index on the source (index fan-out path)', async () => {
    const { buyers, sales } = await setup(true)
    await buyers.put('b1', { id: 'b1', companyName: 'Acme' })
    await sales.put('s1', { id: 's1', buyerId: 'b1', total: 100 })
    await sales.put('s2', { id: 's2', buyerId: 'b1', total: 200 })
    await buyers.put('b1', { id: 'b1', companyName: 'Acme Corp' })
    expect((await sales.get('s1'))?.buyerName).toBe('Acme Corp')
    expect((await sales.get('s2'))?.buyerName).toBe('Acme Corp')
  })

  it('only patches denorm fields — never clobbers other user fields', async () => {
    const { buyers, sales } = await setup()
    await buyers.put('b1', { id: 'b1', companyName: 'Acme' })
    await sales.put('s1', { id: 's1', buyerId: 'b1', total: 100, note: 'keep me' })
    await buyers.put('b1', { id: 'b1', companyName: 'Acme Corp' })
    const s = await sales.get('s1')
    expect(s?.buyerName).toBe('Acme Corp')
    expect(s?.note).toBe('keep me')   // untouched by the denorm patch
    expect(s?.total).toBe(100)        // untouched
  })

  it('self-write terminates (no infinite loop) and is idempotent', async () => {
    const { buyers, sales } = await setup()
    await buyers.put('b1', { id: 'b1', companyName: 'Acme' })
    await sales.put('s1', { id: 's1', buyerId: 'b1', total: 100 })
    // A redundant parent write (same name) must not loop or error.
    await buyers.put('b1', { id: 'b1', companyName: 'Acme' })
    await buyers.put('b1', { id: 'b1', companyName: 'Acme' })
    expect((await sales.get('s1'))?.buyerName).toBe('Acme')
  })

  it('enforces maxFanout', async () => {
    const db = await createNoydb({
      store: toMemory(), user: 'alice', secret: 'trigger-by-cap-secret-2026',
      derivationStrategies: [
        withDerivation<Sale, { self: Sale }>({
          source: 'sales',
          deterministic: true,
          triggerBy: [{ collection: 'buyers', on: 'buyerId', maxFanout: 1 }],
          outputs: { self: { shape: 'record', collection: 'sales', denorm: ['buyerName'] } },
          derive: async (sale, ctx) => {
            const b = await ctx.vault.collection<Buyer>('buyers').get(sale.buyerId)
            return { self: { ...sale, buyerName: b?.companyName ?? null } as Sale }
          },
          lifecycle: 'eager',
        }),
      ],
    })
    const v = await db.openVault('firm')
    const buyers = v.collection<Buyer>('buyers')
    const sales = v.collection<Sale>('sales')
    await buyers.put('b1', { id: 'b1', companyName: 'Acme' })
    await sales.put('s1', { id: 's1', buyerId: 'b1', total: 100 })
    await sales.put('s2', { id: 's2', buyerId: 'b1', total: 200 }) // 2 matches > maxFanout 1
    await expect(buyers.put('b1', { id: 'b1', companyName: 'Acme Corp' }))
      .rejects.toBeInstanceOf(DerivationCapExceededError)
  })
})
