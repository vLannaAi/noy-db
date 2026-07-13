import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { createNoydb } from '../../src/index.js'
import { ComputedFieldError } from '../../src/with-formula/computed/index.js'
import { withAggregate } from '../../src/with-lookup/aggregate/index.js'
import { sum } from '../../src/with-lookup/aggregate/reducers.js'
import { money } from '../../src/via/money/descriptor.js'
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

interface Line extends Record<string, unknown> {
  id: string; unitPrice: number; qty: number
  netAmount?: number | undefined; taxAmount?: number | undefined; total?: number | undefined
}

async function vault(extra?: { aggregate?: boolean }) {
  const db = await createNoydb({
    store: memory(), user: 'alice', secret: 'computed-fields-passphrase-2026-pilot3',
    ...(extra?.aggregate ? { aggregateStrategy: withAggregate() } : {}),
  })
  return db.openVault('books')
}

describe('computed scalar fields — collection integration', () => {
  it('materializes computed fields on write; user need not supply them', async () => {
    const v = await vault()
    v.collection<Line>('lines', {
      schema: z.object({
        id: z.string(), unitPrice: z.number(), qty: z.number(),
        netAmount: z.number().optional(), taxAmount: z.number().optional(), total: z.number().optional(),
      }),
      computed: {
        netAmount: (r) => (r.unitPrice as number) * (r.qty as number),
        taxAmount: (r) => (r.netAmount as number) * 0.5,
        total: (r) => (r.netAmount as number) + (r.taxAmount as number),
      },
    })
    const lines = v.collection<Line>('lines')
    await lines.put('a', { id: 'a', unitPrice: 10, qty: 2 } as Line)

    const row = await lines.get('a')
    expect(row?.netAmount).toBe(20)
    expect(row?.taxAmount).toBe(10)
    expect(row?.total).toBe(30)
  })

  it('computed overwrites a user-supplied value of the same name', async () => {
    const v = await vault()
    v.collection<Line>('lines', {
      schema: z.object({ id: z.string(), unitPrice: z.number(), qty: z.number(), total: z.number().optional() }),
      computed: { total: (r) => (r.unitPrice as number) * (r.qty as number) },
    })
    const lines = v.collection<Line>('lines')
    await lines.put('a', { id: 'a', unitPrice: 5, qty: 3, total: 9999 } as Line)
    expect((await lines.get('a'))?.total).toBe(15)
  })

  it('schema validates the computed result', async () => {
    const v = await vault()
    v.collection<Line>('lines', {
      schema: z.object({ id: z.string(), unitPrice: z.number(), qty: z.number(), total: z.number().nonnegative() }),
      computed: { total: () => -1 }, // violates nonnegative
    })
    const lines = v.collection<Line>('lines')
    await expect(lines.put('a', { id: 'a', unitPrice: 1, qty: 1 } as Line)).rejects.toThrow()
  })

  it('a throwing computed function rejects with ComputedFieldError', async () => {
    const v = await vault()
    v.collection<Line>('lines', {
      schema: z.object({ id: z.string(), unitPrice: z.number(), qty: z.number() }),
      computed: { total: () => { throw new Error('boom') } },
    })
    const lines = v.collection<Line>('lines')
    await expect(lines.put('a', { id: 'a', unitPrice: 1, qty: 1 } as Line)).rejects.toBeInstanceOf(ComputedFieldError)
  })

  it('a computed money field aggregates exactly (computed + money interplay)', async () => {
    interface SaleLine extends Record<string, unknown> { id: string; unitPrice: number; qty: number; total?: string | number | undefined }
    const v = await vault({ aggregate: true })
    v.collection<SaleLine>('lines', {
      schema: z.object({
        id: z.string(), unitPrice: z.number(), qty: z.number(),
        total: z.union([z.number(), z.string()]).optional(),
      }),
      computed: { total: (r) => (r.unitPrice as number) * (r.qty as number) },
      moneyFields: { total: money({ currency: 'EUR', scale: 2 }) },
    })
    const lines = v.collection<SaleLine>('lines')
    await lines.put('a', { id: 'a', unitPrice: 0.10, qty: 1 } as SaleLine)
    await lines.put('b', { id: 'b', unitPrice: 0.20, qty: 1 } as SaleLine)

    // total computed (0.10, 0.20) → quantized → exact money sum
    const agg = await lines.query().aggregate({ total: sum('total') }).run() as Record<string, unknown>
    expect(agg.total).toBe('0.30')
    // and the stored computed money field reads back as an exact decimal
    expect((await lines.get('a'))?.total).toBe('0.10')
  })
})
