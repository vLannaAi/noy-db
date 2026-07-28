import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { createNoydb, money, MoneyUnsupportedError } from '../../src/index.js'
import type { NoydbStore, EncryptedEnvelope } from '../../src/kernel/types.js'
import { withIndexing } from '../../src/with-lookup/indexing/index.js'
import { CollectionIndexes } from '../../src/with-lookup/indexing/eager-indexes.js'

// #336 — where() on a declared money field accepts MAJOR-unit operands
// and compares BigInt-exact in scaled-integer space. Before this,
// clauses evaluated against the raw stored digit string ('1000000'),
// so `where('total', '>', 10000)` was excluded by isComparable
// (string vs number) and equality never matched.

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

interface Invoice extends Record<string, unknown> {
  id: string
  total: number | string
  status: string
}

const invoiceSchema = z.object({
  id: z.string(),
  total: z.union([z.number(), z.string()]),
  status: z.string(),
})

async function seedFixed() {
  const db = await createNoydb({
    store: toMemory(), user: 'alice',
    secret: 'money-where-fixed-secret-2026',
  })
  const vault = await db.openVault('books')
  const col = vault.collection<Invoice>('invoices', {
    schema: invoiceSchema,
    moneyFields: { total: money({ currency: 'THB', scale: 2 }) },
  })
  await col.put('a', { id: 'a', total: 99.5, status: 'open' })
  await col.put('b', { id: 'b', total: '100.00', status: 'open' })
  await col.put('c', { id: 'c', total: 250, status: 'paid' })
  await col.put('d', { id: 'd', total: '1000000.00', status: 'open' })
  return col
}

describe('money where() — fixed mode, scaled-space comparison (#336)', () => {
  it('range operators take major-unit operands', async () => {
    const col = await seedFixed()
    const over100 = col.query().where('total', '>', 100).toArray()
    expect(over100.map(r => r.id).sort()).toEqual(['c', 'd'])

    const atLeast100 = col.query().where('total', '>=', '100.00').toArray()
    expect(atLeast100.map(r => r.id).sort()).toEqual(['b', 'c', 'd'])

    const under100 = col.query().where('total', '<', 100).toArray()
    expect(under100.map(r => r.id)).toEqual(['a'])
  })

  it('equality matches across input shapes (number, decimal string)', async () => {
    const col = await seedFixed()
    expect(col.query().where('total', '==', 100).toArray().map(r => r.id)).toEqual(['b'])
    expect(col.query().where('total', '==', '99.50').toArray().map(r => r.id)).toEqual(['a'])
    expect(col.query().where('total', '!=', 100).toArray().map(r => r.id).sort()).toEqual(['a', 'c', 'd'])
  })

  it('between and in operate in scaled space', async () => {
    const col = await seedFixed()
    expect(
      col.query().where('total', 'between', [100, 300]).toArray().map(r => r.id).sort(),
    ).toEqual(['b', 'c'])
    expect(
      col.query().where('total', 'in', [99.5, 250]).toArray().map(r => r.id).sort(),
    ).toEqual(['a', 'c'])
  })

  it('is exact past 2^53 (no float drift on big amounts)', async () => {
    const col = await seedFixed()
    // 1_000_000.00 THB stored as scaled-int '100000000' — still trivially
    // exact; the BigInt path guarantees the same for arbitrarily large values.
    expect(col.query().where('total', '==', '1000000.00').toArray().map(r => r.id)).toEqual(['d'])
  })

  it('where() agrees with the decoded output values (predicates vs read parity)', async () => {
    const col = await seedFixed()
    const rows = col.query().where('total', '>=', 100).toArray()
    // Output is decoded canonical — and every row really satisfies the
    // predicate in major units.
    for (const r of rows) expect(Number(r.total)).toBeGreaterThanOrEqual(100)
  })

  it('string operators on a money field throw at build time', async () => {
    const col = await seedFixed()
    expect(() => col.query().where('total', 'contains', '00')).toThrow(MoneyUnsupportedError)
    expect(() => col.query().where('total', 'startsWith', '1')).toThrow(MoneyUnsupportedError)
  })

  it('a malformed operand throws at build time, not silently filters', async () => {
    const col = await seedFixed()
    expect(() => col.query().where('total', '>', 'banana')).toThrow(MoneyUnsupportedError)
  })

  it('non-money fields keep generic semantics', async () => {
    const col = await seedFixed()
    expect(col.query().where('status', '==', 'paid').toArray().map(r => r.id)).toEqual(['c'])
  })
})

describe('money where() — multi-currency mode (#336)', () => {
  interface Payment extends Record<string, unknown> {
    id: string
    amount: unknown
  }

  async function seedMulti() {
    const db = await createNoydb({
      store: toMemory(), user: 'alice',
      secret: 'money-where-multi-secret-2026',
    })
    const vault = await db.openVault('books')
    const col = vault.collection<Payment>('payments', {
      schema: z.object({ id: z.string(), amount: z.unknown() }),
      moneyFields: { amount: money({ currencies: ['EUR', 'USD'] }) },
    })
    await col.put('e1', { id: 'e1', amount: { amount: 100, currency: 'EUR' } })
    await col.put('e2', { id: 'e2', amount: { amount: 250, currency: 'EUR' } })
    await col.put('u1', { id: 'u1', amount: { amount: 100, currency: 'USD' } })
    return col
  }

  it('compares within the operand currency only — other currencies have no order', async () => {
    const col = await seedMulti()
    const eurOver50 = col.query().where('amount', '>', { amount: 50, currency: 'EUR' }).toArray()
    expect(eurOver50.map(r => r.id).sort()).toEqual(['e1', 'e2'])

    const eur100 = col.query().where('amount', '==', { amount: 100, currency: 'EUR' }).toArray()
    expect(eur100.map(r => r.id)).toEqual(['e1'])
  })

  it('!= matches cross-currency records (different currency IS a different value)', async () => {
    const col = await seedMulti()
    const ne = col.query().where('amount', '!=', { amount: 100, currency: 'EUR' }).toArray()
    expect(ne.map(r => r.id).sort()).toEqual(['e2', 'u1'])
  })

  it('bare amounts throw on a genuinely multi-currency field', async () => {
    const col = await seedMulti()
    expect(() => col.query().where('amount', '>', 100)).toThrow(MoneyUnsupportedError)
  })

  it('between with mixed-currency bounds throws at build time', async () => {
    const col = await seedMulti()
    expect(() =>
      col.query().where('amount', 'between', [
        { amount: 50, currency: 'EUR' },
        { amount: 500, currency: 'USD' },
      ]),
    ).toThrow(MoneyUnsupportedError)
  })
})

describe('money where() — indexed fast path agrees with the scan (#336, hardened for #625)', () => {
  // #625: the original version of this suite declared `indexes: ['total']`
  // but never passed `indexingStrategy: withIndexing()` to createNoydb, so
  // `getIndexes()` returned null (builder.ts's index fast path never
  // engages without it) and every "indexed" query below silently ran a
  // full scan — the assertions happened to pass, but they proved nothing
  // about the index. Every test in this suite now opts in for real and
  // spies on `CollectionIndexes.lookupEqual`/`lookupIn` to prove which
  // path actually ran.
  async function seedIndexedFixed() {
    const db = await createNoydb({
      store: toMemory(), user: 'alice',
      secret: 'money-where-indexed-secret-2026',
      indexingStrategy: withIndexing(),
    })
    const vault = await db.openVault('books')
    const col = vault.collection<Invoice>('invoices', {
      schema: invoiceSchema,
      moneyFields: { total: money({ currency: 'THB', scale: 2 }) },
      indexes: ['total'],
    })
    await col.put('a', { id: 'a', total: 99.5, status: 'open' })
    await col.put('b', { id: 'b', total: '100.00', status: 'open' })
    await col.put('c', { id: 'c', total: 100, status: 'paid' })
    return col
  }

  it('== hits CollectionIndexes.lookupEqual (fast path proven, not just correct output)', async () => {
    const col = await seedIndexedFixed()
    const spy = vi.spyOn(CollectionIndexes.prototype, 'lookupEqual')
    try {
      const hit = col.query().where('total', '==', 100).toArray()
      expect(hit.map(r => r.id).sort()).toEqual(['b', 'c'])
      expect(spy).toHaveBeenCalledTimes(1)
      // Byte-parity evidence (seam-map §4's dependency flag): the probed
      // value handed to the index is the exact STORED scaled-int digit
      // string quantizeMoneyFields would have written for 100 THB @
      // scale 2 ('10000'), not the caller's major-unit operand (100) —
      // this is what makes the bucket hit (and 'b'/'c' come back) instead
      // of a silent miss against an empty bucket.
      expect(spy).toHaveBeenCalledWith('total', '10000')
    } finally {
      spy.mockRestore()
    }
  })

  it("'in' hits CollectionIndexes.lookupIn (fast path proven)", async () => {
    const col = await seedIndexedFixed()
    const spy = vi.spyOn(CollectionIndexes.prototype, 'lookupIn')
    try {
      const hit = col.query().where('total', 'in', [99.5, 100]).toArray()
      expect(hit.map(r => r.id).sort()).toEqual(['a', 'b', 'c'])
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy).toHaveBeenCalledWith('total', ['9950', '10000'])
    } finally {
      spy.mockRestore()
    }
  })

  it('multi-currency money never probes the index — always scans, results still correct', async () => {
    const db = await createNoydb({
      store: toMemory(), user: 'alice',
      secret: 'money-where-indexed-multi-secret-2026',
      indexingStrategy: withIndexing(),
    })
    const vault = await db.openVault('books')
    const col = vault.collection<{ id: string; amount: unknown } & Record<string, unknown>>('payments', {
      schema: z.object({ id: z.string(), amount: z.unknown() }),
      moneyFields: { amount: money({ currencies: ['EUR', 'USD'] }) },
      indexes: ['amount'],
    })
    await col.put('e1', { id: 'e1', amount: { amount: 100, currency: 'EUR' } })
    await col.put('u1', { id: 'u1', amount: { amount: 100, currency: 'USD' } })

    const spy = vi.spyOn(CollectionIndexes.prototype, 'lookupEqual')
    try {
      const hit = col.query().where('amount', '==', { amount: 100, currency: 'EUR' }).toArray()
      expect(hit.map(r => r.id)).toEqual(['e1'])
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it('a range operator (>=) never probes the index — always scans, results still correct', async () => {
    const col = await seedIndexedFixed()
    const eqSpy = vi.spyOn(CollectionIndexes.prototype, 'lookupEqual')
    const inSpy = vi.spyOn(CollectionIndexes.prototype, 'lookupIn')
    try {
      const hit = col.query().where('total', '>=', 100).toArray()
      expect(hit.map(r => r.id).sort()).toEqual(['b', 'c'])
      expect(eqSpy).not.toHaveBeenCalled()
      expect(inSpy).not.toHaveBeenCalled()
    } finally {
      eqSpy.mockRestore()
      inSpy.mockRestore()
    }
  })

  it('a non-money indexed field keeps hitting the fast path unchanged (behavior lock)', async () => {
    const db = await createNoydb({
      store: toMemory(), user: 'alice',
      secret: 'money-where-indexed-status-secret-2026',
      indexingStrategy: withIndexing(),
    })
    const vault = await db.openVault('books')
    const col = vault.collection<Invoice>('invoices', {
      schema: invoiceSchema,
      indexes: ['status'],
    })
    await col.put('a', { id: 'a', total: 1, status: 'open' })
    await col.put('b', { id: 'b', total: 2, status: 'paid' })

    const spy = vi.spyOn(CollectionIndexes.prototype, 'lookupEqual')
    try {
      const hit = col.query().where('status', '==', 'paid').toArray()
      expect(hit.map(r => r.id)).toEqual(['b'])
      expect(spy).toHaveBeenCalledWith('status', 'paid')
    } finally {
      spy.mockRestore()
    }
  })
})
