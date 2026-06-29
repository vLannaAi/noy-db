import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { createNoydb, money } from '../../src/index.js'
import type { NoydbStore, EncryptedEnvelope } from '../../src/types.js'

// #390 — orderBy on a money field must compare by the BigInt scaled-int
// value, not lexically by the stored scaled-int string ('9882' vs '10004'
// → '9' > '1' was wrong). Consistent with where (#336) and sum.

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

interface Invoice extends Record<string, unknown> { id: string; total: number | string }
const schema = z.object({ id: z.string(), total: z.union([z.number(), z.string()]) })

async function seed(values: Array<[string, number | string]>) {
  const db = await createNoydb({ store: memory(), user: 'a', secret: 'money-orderby-2026' })
  const vault = await db.openVault('books')
  const col = vault.collection<Invoice>('invoices', { schema, moneyFields: { total: money({ currency: 'EUR', scale: 2 }) } })
  for (const [id, total] of values) await col.put(id, { id, total })
  return col
}

describe('money orderBy — scaled-int numeric comparison (#390)', () => {
  it('sorts by value, not lexically (the 98.82 vs 100.04 repro)', async () => {
    const col = await seed([['a', 98.82], ['b', 100.04]])
    // desc: 100.04 must come before 98.82 (lexical would put 98.82 first)
    expect((col.query().orderBy('total', 'desc').toArray()).map(r => r.id)).toEqual(['b', 'a'])
    expect((col.query().orderBy('total', 'asc').toArray()).map(r => r.id)).toEqual(['a', 'b'])
  })

  it('orders a wider magnitude range correctly across digit counts', async () => {
    const col = await seed([['a', 5], ['b', 99.5], ['c', 100], ['d', 1000000], ['e', 0.07]])
    expect((col.query().orderBy('total', 'asc').toArray()).map(r => r.id)).toEqual(['e', 'a', 'b', 'c', 'd'])
    expect((col.query().orderBy('total', 'desc').toArray()).map(r => r.id)).toEqual(['d', 'c', 'b', 'a', 'e'])
  })

  it('decoded output is correct and ordered (round-trips the read shape)', async () => {
    const col = await seed([['a', 98.82], ['b', 100.04]])
    const rows = col.query().orderBy('total', 'desc').toArray()
    expect(rows.map(r => r.total)).toEqual(['100.04', '98.82'])
  })

  it('handles negatives and ties (stable)', async () => {
    const col = await seed([['a', -50], ['b', 0], ['c', 100], ['d', 100]])
    expect((col.query().orderBy('total', 'asc').toArray()).map(r => r.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('still sorts non-money fields with the generic comparator', async () => {
    const col = await seed([['a', 100], ['b', 5]])
    expect((col.query().orderBy('id', 'asc').toArray()).map(r => r.id)).toEqual(['a', 'b'])
  })
})
