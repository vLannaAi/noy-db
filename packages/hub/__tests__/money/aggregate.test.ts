import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { createNoydb } from '../../src/index.js'
import { withAggregate } from '../../src/with-lookup/aggregate/index.js'
import { sum, min, max, count, avg } from '../../src/with-lookup/aggregate/reducers.js'
import { money, MoneyUnsupportedError } from '../../src/via/money/descriptor.js'
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

interface Line extends Record<string, unknown> { id: string; total: number | string | { amount: number | string; currency: string } }

async function vaultWith(moneyField: ReturnType<typeof money>) {
  const db = await createNoydb({
    store: memory(),
    user: 'alice',
    secret: 'money-aggregate-secret-2026-pilot3-exact',
    aggregateStrategy: withAggregate(),
  })
  const vault = await db.openVault('books')
  // Schema is loose enough for both fixed (number|string) and multi
  // ({amount,currency}) money input — the descriptor owns canonical form.
  const moneyInput = z.union([
    z.number(),
    z.string(),
    z.object({ amount: z.union([z.number(), z.string()]), currency: z.string() }),
  ])
  vault.collection<Line>('lines', {
    schema: z.object({ id: z.string(), total: moneyInput }),
    moneyFields: { total: moneyField },
  })
  return vault
}

describe('money aggregation — exact', () => {
  it('fixed-mode sum is exact (0.1 + 0.2 + 0.3 = 0.60, no float drift)', async () => {
    const vault = await vaultWith(money({ currency: 'EUR', scale: 2 }))
    const lines = vault.collection<Line>('lines')
    await lines.put('a', { id: 'a', total: '0.10' })
    await lines.put('b', { id: 'b', total: '0.20' })
    await lines.put('c', { id: 'c', total: '0.30' })

    const r = await lines.query().aggregate({ total: sum('total') }).run() as Record<string, unknown>
    expect(r.total).toBe('0.60') // exact string, not 0.6000000000000001
  })

  it('sum stays exact past Number.MAX_SAFE_INTEGER', async () => {
    const vault = await vaultWith(money({ currency: 'EUR', scale: 2 }))
    const lines = vault.collection<Line>('lines')
    await lines.put('a', { id: 'a', total: '90071992547409.91' })
    await lines.put('b', { id: 'b', total: '0.09' })

    const r = await lines.query().aggregate({ total: sum('total') }).run() as Record<string, unknown>
    expect(r.total).toBe('90071992547410.00')
  })

  it('an unwrapped generic sum over money would be wrong — proving the wrap ran', async () => {
    // If wrapMoneyReducers did NOT run, readNumber('10') → 0 and the sum
    // would be '0' / 0. The exact 0.60 above is the proof it ran.
    const vault = await vaultWith(money({ currency: 'EUR', scale: 2 }))
    const lines = vault.collection<Line>('lines')
    await lines.put('a', { id: 'a', total: '12.34' })
    const r = await lines.query().aggregate({ s: sum('total') }).run() as Record<string, unknown>
    expect(r.s).toBe('12.34')
  })

  it('min / max are exact in fixed mode', async () => {
    const vault = await vaultWith(money({ currency: 'EUR', scale: 2 }))
    const lines = vault.collection<Line>('lines')
    await lines.put('a', { id: 'a', total: '5.00' })
    await lines.put('b', { id: 'b', total: '1.50' })
    await lines.put('c', { id: 'c', total: '9.99' })
    const r = await lines.query().aggregate({ lo: min('total'), hi: max('total') }).run() as Record<string, unknown>
    expect(r.lo).toBe('1.50')
    expect(r.hi).toBe('9.99')
  })

  it('multi-currency sum returns an exact per-currency map', async () => {
    const vault = await vaultWith(money({ currencies: ['EUR', 'USD'] }))
    const lines = vault.collection<Line>('lines')
    await lines.put('a', { id: 'a', total: { amount: '10.00', currency: 'EUR' } as never })
    await lines.put('b', { id: 'b', total: { amount: '5.50', currency: 'EUR' } as never })
    await lines.put('c', { id: 'c', total: { amount: '3.00', currency: 'USD' } as never })

    const r = await lines.query().aggregate({ total: sum('total') }).run() as Record<string, unknown>
    expect(r.total).toEqual({ EUR: '15.50', USD: '3.00' })
  })

  it('multi-currency sum with convertTo + fx yields one exact figure', async () => {
    const vault = await vaultWith(money({ currencies: ['EUR', 'USD'] }))
    const lines = vault.collection<Line>('lines')
    await lines.put('a', { id: 'a', total: { amount: '10.00', currency: 'EUR' } as never })
    await lines.put('b', { id: 'b', total: { amount: '10.00', currency: 'USD' } as never })

    const r = await lines.query()
      .aggregate({ total: sum('total', { convertTo: 'EUR', fx: { 'USD->EUR': '0.90' } }) })
      .run() as Record<string, unknown>
    expect(r.total).toBe('19.00') // 10 EUR + 10 USD * 0.90 = 19.00
  })

  it('convertTo without fx throws', async () => {
    const vault = await vaultWith(money({ currencies: ['EUR', 'USD'] }))
    const lines = vault.collection<Line>('lines')
    await lines.put('a', { id: 'a', total: { amount: '1.00', currency: 'USD' } as never })
    expect(
      () => lines.query().aggregate({ total: sum('total', { convertTo: 'EUR' }) }).run(),
    ).toThrow(/fx/)
  })

  it('batch recompute stays exact after a source delete (see mv-and-live for the MV/live paths)', async () => {
    const vault = await vaultWith(money({ currency: 'EUR', scale: 2 }))
    const lines = vault.collection<Line>('lines')
    await lines.put('a', { id: 'a', total: '0.10' })
    await lines.put('b', { id: 'b', total: '0.20' })
    await lines.put('c', { id: 'c', total: '0.30' })

    let r = await lines.query().aggregate({ total: sum('total'), n: count() }).run() as Record<string, unknown>
    expect(r.total).toBe('0.60')
    expect(r.n).toBe(3)

    await lines.delete('b')
    r = await lines.query().aggregate({ total: sum('total'), n: count() }).run() as Record<string, unknown>
    expect(r.total).toBe('0.40') // exact recompute, not stale
    expect(r.n).toBe(2)
  })

  it('avg() over a money field throws MoneyUnsupportedError instead of silently returning 0', async () => {
    const vault = await vaultWith(money({ currency: 'EUR', scale: 2 }))
    const lines = vault.collection<Line>('lines')
    await lines.put('a', { id: 'a', total: '10.00' })
    await lines.put('b', { id: 'b', total: '20.00' })
    expect(
      () => lines.query().aggregate({ mean: avg('total') }).run(),
    ).toThrow(MoneyUnsupportedError)
  })

  it('grouped sum over a money field is exact per bucket', async () => {
    interface Sale extends Record<string, unknown> { id: string; buyer: string; total: number | string }
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'money-grouped-secret-2026-pilot3',
      aggregateStrategy: withAggregate(),
    })
    const vault = await db.openVault('books')
    vault.collection<Sale>('sales', {
      schema: z.object({ id: z.string(), buyer: z.string(), total: z.union([z.number(), z.string()]) }),
      moneyFields: { total: money({ currency: 'EUR', scale: 2 }) },
    })
    const sales = vault.collection<Sale>('sales')
    await sales.put('a', { id: 'a', buyer: 'acme', total: '0.10' })
    await sales.put('b', { id: 'b', buyer: 'acme', total: '0.20' })
    await sales.put('c', { id: 'c', buyer: 'globex', total: '1.00' })

    const rows = await sales.query().groupBy('buyer').aggregate({ total: sum('total') }).run() as Array<Record<string, unknown>>
    const byBuyer = Object.fromEntries(rows.map(r => [r.buyer, r.total]))
    expect(byBuyer.acme).toBe('0.30')
    expect(byBuyer.globex).toBe('1.00')
  })
})
