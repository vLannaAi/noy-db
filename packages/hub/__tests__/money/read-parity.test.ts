import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { createNoydb } from '../../src/index.js'
import { withAggregate } from '../../src/aggregate/index.js'
import { sum } from '../../src/aggregate/reducers.js'
import { money } from '../../src/money/descriptor.js'
import type { NoydbStore, EncryptedEnvelope } from '../../src/types.js'

// #322 — money fields read back differently via get() (decimal) vs
// list()/query().toArray() (raw scaled-int cents). The stored scaled-int is
// an internal representation and must never leak; all read paths must return
// the same canonical decimal, matching get() / sum().

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

interface Sale extends Record<string, unknown> { id: string; total: number | string }

async function salesVault(defaultLocale?: string) {
  const db = await createNoydb({ store: memory(), user: 'op', secret: 'pilot3-money-parity-2026-exact', aggregateStrategy: withAggregate() })
  const v = await db.openVault('books')
  v.collection<Sale>('sales', {
    schema: z.object({ id: z.string(), total: z.union([z.number(), z.string()]) }),
    moneyFields: { total: money({ currency: 'EUR', scale: 2 }) },
    ...(defaultLocale ? { defaultLocale } : {}),
  })
  return v
}

describe('money read parity — get() vs list() vs query().toArray() (#322)', () => {
  it('returns the same decimal representation across all three read paths', async () => {
    const v = await salesVault()
    const sales = v.collection<Sale>('sales')
    await sales.put('s1', { id: 's1', total: 122 })

    const viaGet = await sales.get('s1')
    const viaList = (await sales.list())[0]
    const viaQuery = sales.query().toArray()[0]

    expect(viaGet!.total).toBe('122.00')
    expect(viaList!.total).toBe('122.00')   // was '12200' (raw cents) — the bug
    expect(viaQuery!.total).toBe('122.00')  // was '12200' (raw cents) — the bug
    // get() and list() are both collection-level reads with locale context →
    // identical records (canonical decimal + the same derived virtuals).
    expect(viaList).toEqual(viaGet)
    // query().toArray() is locale-less → it agrees on the canonical decimal
    // VALUE but does not fabricate locale-formatted virtuals (see below).
    expect(viaQuery!.total).toBe(viaGet!.total)
  })

  it('canonical value parity holds even with a collection defaultLocale (virtuals are not faked on the locale-less query path)', async () => {
    const v = await salesVault('it-IT')
    const sales = v.collection<Sale>('sales')
    await sales.put('s1', { id: 's1', total: 122 })

    const viaGet = (await sales.get('s1')) as Record<string, unknown>
    const viaQuery = sales.query().toArray()[0] as Record<string, unknown>

    // The canonical decimal agrees regardless of locale — the #322 invariant.
    expect(viaGet.total).toBe('122.00')
    expect(viaQuery.total).toBe('122.00')
    // get() formats virtuals with the collection's it-IT locale; the locale-less
    // query path deliberately omits them rather than guessing a wrong locale
    // (which would reintroduce #322 on the virtual field).
    expect(viaGet.totalFormatted).toBeDefined()
    expect(viaQuery.totalFormatted).toBeUndefined()
  })

  it('scan() streams the canonical decimal, not raw cents (#322)', async () => {
    const v = await salesVault()
    const sales = v.collection<Sale>('sales')
    await sales.put('s1', { id: 's1', total: 122 })
    await sales.put('s2', { id: 's2', total: 5 })

    const seen: string[] = []
    for await (const rec of sales.scan({ pageSize: 10 })) {
      seen.push(String(rec.total))
    }
    expect(seen.sort()).toEqual(['122.00', '5.00'])
  })

  it('aggregate sum already agreed with get() and still does', async () => {
    const v = await salesVault()
    const sales = v.collection<Sale>('sales')
    await sales.put('s1', { id: 's1', total: 122 })
    await sales.put('s2', { id: 's2', total: 78 })
    const got1 = await sales.get('s1')
    expect(got1!.total).toBe('122.00')
    const summed = await sales.query().aggregate({ t: sum('total') }).run() as Record<string, unknown>
    expect(summed.t).toBe('200.00')
  })
})
