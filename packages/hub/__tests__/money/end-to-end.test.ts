import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { createNoydb } from '../../src/index.js'
import { withAggregate } from '../../src/with-lookup/aggregate/index.js'
import { sum, count } from '../../src/with-lookup/aggregate/reducers.js'
import { money } from '../../src/with-shape/money/descriptor.js'
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
        const [vname, cname, id] = key.split('/') as [string, string, string]
        if (vname === v) { out[cname] = out[cname] ?? {}; out[cname][id] = env }
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

interface SaleLine extends Record<string, unknown> {
  id: string
  unitPrice: number | string
  taxAmount: number | string
  total: number | string | null
}

describe('money — invoice-shaped end-to-end', () => {
  it('multiple money fields, negative credit, null excluded from sum, rounding write', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'money-e2e-passphrase-2026-pilot3-invoices',
      aggregateStrategy: withAggregate(),
    })
    const vault = await db.openVault('books')
    vault.collection<SaleLine>('lines', {
      schema: z.object({
        id: z.string(),
        unitPrice: z.union([z.number(), z.string()]),
        taxAmount: z.union([z.number(), z.string()]),
        total: z.union([z.number(), z.string()]).nullable(),
      }),
      moneyFields: {
        unitPrice: money({ currency: 'EUR', scale: 2 }),
        taxAmount: money({ currency: 'EUR', scale: 2 }),
        // rounding field: VAT computed upstream may carry extra precision
        total: money({ currency: 'EUR', scale: 2, rounding: 'half-even' }),
      },
    })
    const lines = vault.collection<SaleLine>('lines')

    await lines.put('l1', { id: 'l1', unitPrice: '10.00', taxAmount: '2.20', total: '12.20' })
    await lines.put('l2', { id: 'l2', unitPrice: '3.33', taxAmount: '0.73', total: '4.065' }) // rounds → 4.07 (half-even on 4.065 → 4.06? tie to even)
    await lines.put('credit', { id: 'credit', unitPrice: '-5.00', taxAmount: '-1.10', total: '-6.10' })
    await lines.put('draft', { id: 'draft', unitPrice: '9.99', taxAmount: '0', total: null }) // not yet totalled

    // read: exact decimal strings + formatting
    const l1 = await lines.get('l1', { locale: 'en-US' }) as Record<string, unknown>
    expect(l1.total).toBe('12.20')
    expect(String(l1.totalFormatted)).toContain('12.20')

    // negative credit round-trips
    const credit = await lines.get('credit') as Record<string, unknown>
    expect(credit.total).toBe('-6.10')

    // half-even rounding: 4.065 → 4.06 (round to even tie)
    const l2 = await lines.get('l2') as Record<string, unknown>
    expect(l2.total).toBe('4.06')

    // null total stays null
    const draft = await lines.get('draft') as Record<string, unknown>
    expect(draft.total).toBeNull()

    // exact sum over total — null excluded, credit subtracted:
    // 12.20 + 4.06 + (-6.10) = 10.16
    const agg = await lines.query().aggregate({ total: sum('total'), n: count() }).run() as Record<string, unknown>
    expect(agg.total).toBe('10.16')
    expect(agg.n).toBe(4) // count is over records, not non-null totals
  })
})
