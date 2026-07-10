/**
 * Runtime coverage for the money-typed reducer constructors. `moneySum` is
 * exercised end-to-end by `mv-and-live.test.ts`; this adds `moneyMin`/`moneyMax`
 * and confirms all three read back as decimal strings WITHOUT a cast (the typed
 * result is the point — see `moneySum`'s doc).
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, moneySum, moneyMin, moneyMax } from '../../src/index.js'
import { z } from 'zod'
import { withAggregate } from '../../src/with-lookup/aggregate/index.js'
import { money } from '../../src/shape/via-money/descriptor.js'
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

interface Line extends Record<string, unknown> { id: string; total: number | string }

async function linesWith3() {
  const db = await createNoydb({
    store: memory(),
    user: 'alice',
    secret: 'money-reducers-passphrase-2026-pilot3-exact',
    aggregateStrategy: withAggregate(),
  })
  const vault = await db.openVault('books')
  const lines = vault.collection<Line>('lines', {
    schema: z.object({ id: z.string(), total: z.union([z.number(), z.string()]) }),
    moneyFields: { total: money({ currency: 'EUR', scale: 2 }) },
  })
  await lines.put('a', { id: 'a', total: '0.10' })
  await lines.put('b', { id: 'b', total: '0.20' })
  await lines.put('c', { id: 'c', total: '0.30' })
  return lines
}

describe('money reducer constructors — runtime', () => {
  it('moneySum reads back as an exact decimal string, no cast', async () => {
    const lines = await linesWith3()
    const r = await lines.query().aggregate({ total: moneySum('total') }).run()
    // `r.total` is typed MoneyString — usable directly as a string.
    expect(r.total).toBe('0.60')
  })

  it('moneyMin / moneyMax read back as decimal strings, no cast', async () => {
    const lines = await linesWith3()
    const r = await lines
      .query()
      .aggregate({ lo: moneyMin('total'), hi: moneyMax('total') })
      .run()
    expect(r.lo).toBe('0.10')
    expect(r.hi).toBe('0.30')
  })

  it('moneyMin / moneyMax are null on an empty result set', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'money-reducers-passphrase-2026-pilot3-exact',
      aggregateStrategy: withAggregate(),
    })
    const vault = await db.openVault('books')
    const lines = vault.collection<Line>('lines', {
      schema: z.object({ id: z.string(), total: z.union([z.number(), z.string()]) }),
      moneyFields: { total: money({ currency: 'EUR', scale: 2 }) },
    })
    const r = await lines.query().aggregate({ lo: moneyMin('total'), hi: moneyMax('total') }).run()
    expect(r.lo).toBeNull()
    expect(r.hi).toBeNull()
  })
})
