/**
 * collection.toJSONSchema() — Task 2 (#484)
 *
 * Covers:
 *   - zod-4 collection: x- extension keys (x-semanticType, x-money, x-enumLabels, x-sensitivity)
 *   - x-enumLabels picks up inline dictKey labels (Task 1)
 *   - non-zod (Standard-Schema stub): minimal field-type schema fallback + x- metadata, no throw
 */

import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { createNoydb } from '../../src/kernel/noydb.js'
import { money } from '../../src/via/money/descriptor.js'
import { dictKey } from '../../src/via/i18n/dictionary.js'
import { ref } from '../../src/kernel/refs.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../../src/kernel/types.js'
import { ConflictError } from '../../src/kernel/errors.js'

function inlineMemory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function gc(c: string, col: string) {
    let comp = store.get(c)
    if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col)
    if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    async get(c, col, id) { return store.get(c)?.get(col)?.get(id) ?? null },
    async put(c, col, id, env, ev) {
      const coll = gc(c, col)
      const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(c, col, id) { store.get(c)?.get(col)?.delete(id) },
    async list(c, col) { const coll = store.get(c)?.get(col); return coll ? [...coll.keys()] : [] },
    async loadAll(c) {
      const comp = store.get(c)
      const s: VaultSnapshot = {}
      if (comp) {
        for (const [n, coll] of comp) {
          if (!n.startsWith('_')) {
            const r: Record<string, EncryptedEnvelope> = {}
            for (const [id, e] of coll) r[id] = e
            s[n] = r
          }
        }
      }
      return s
    },
    async saveAll(c, data) {
      for (const [n, recs] of Object.entries(data)) {
        const coll = gc(c, n)
        for (const [id, e] of Object.entries(recs)) coll.set(id, e)
      }
    },
  }
}

interface Order {
  id: string
  total: number
  status: string
  buyerId: string
  buyerVat: string
}

// ─── Shared fixtures ──────────────────────────────────────────────────────────

let orders: ReturnType<Awaited<ReturnType<Awaited<ReturnType<typeof createNoydb>>['openVault']>>['collection']>
let stubColl: ReturnType<Awaited<ReturnType<Awaited<ReturnType<typeof createNoydb>>['openVault']>>['collection']>

describe('collection.toJSONSchema()', async () => {
  const db = await createNoydb({ store: inlineMemory(), user: 'alice', secret: 'pw-json-schema-1' })
  const v = await db.openVault('vjs1')

  // Zod-4 collection with money/ref/dictKey-with-inline-labels/pii fieldMeta
  const ordersSchema = z.object({
    id: z.string(),
    total: z.number(),
    status: z.string(),
    buyerId: z.string(),
    buyerVat: z.string(),
  })

  orders = v.collection<Order>('orders_js', {
    schema: ordersSchema as import('../../src/kernel/schema.js').StandardSchemaV1<unknown, Order>,
    moneyFields: { total: money({ currency: 'EUR' }) },
    refs: { buyerId: ref('buyers') },
    dictKeyFields: { status: dictKey('saleStatus', { draft: 'Draft', to_verify: 'To Verify' }) },
    fieldMeta: {
      buyerVat: { sensitivity: 'pii', label: 'Buyer VAT' },
    },
  })

  // Non-zod Standard-Schema stub — no '~standard.vendor' === 'zod', no '_zod'
  const stubValidator = {
    '~standard': { version: 1, vendor: 'stub', validate: (v: unknown) => ({ value: v }) },
  }

  const db2 = await createNoydb({ store: inlineMemory(), user: 'alice', secret: 'pw-json-schema-2' })
  const v2 = await db2.openVault('vjs2')

  stubColl = v2.collection('orders_stub', {
    schema: stubValidator as unknown as import('../../src/kernel/schema.js').StandardSchemaV1,
    moneyFields: { total: money({ currency: 'USD' }) },
  })

  it('emits JSON Schema with x- metadata extensions', async () => {
    const js = await orders.toJSONSchema() as { properties: Record<string, Record<string, unknown>> }
    expect(js.properties.total!['x-semanticType']).toBe('currency')
    expect(js.properties.total!['x-money']).toMatchObject({ currency: 'EUR' })
    expect(js.properties.status!['x-enumLabels']).toMatchObject({ to_verify: 'To Verify' })
    expect(js.properties.buyerVat!['x-sensitivity']).toBe('pii')
  })

  it('non-zod validator → minimal schema from field types, no throw', async () => {
    const js = await stubColl.toJSONSchema() as { type: string; properties: Record<string, Record<string, unknown>> }
    expect(js.type).toBe('object')
    expect(js.properties.total!['x-semanticType']).toBe('currency')
  })
})
