// Aggregate-onto-parent rollups (#376 slice 2).
//
// withRollup({ from, key, into, field, compute }) keeps a summary field on the
// parent in sync with its children, on insert / update / delete, gap-free.

import { describe, it, expect } from 'vitest'
import { createNoydb, withRollup, ValidationError } from '../../src/index.js'
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

interface Buyer extends Record<string, unknown> { id: string; companyName: string; totalSpent?: number; orderCount?: number }
interface Sale extends Record<string, unknown> { id: string; buyerId: string; total: number }

const totalSpentRollup = () =>
  withRollup<Sale, Buyer>({
    from: 'sales',
    key: 'buyerId',
    into: 'buyers',
    field: 'totalSpent',
    compute: (sales) => sales.reduce((t, s) => t + s.total, 0),
  })

describe('withRollup — factory validation (#376)', () => {
  it('rejects from === into', () => {
    expect(() => withRollup({ from: 'x', key: 'k', into: 'x', field: 'f', compute: () => 0 })).toThrow(ValidationError)
  })
  it('rejects a missing field', () => {
    expect(() => withRollup({ from: 'sales', key: 'buyerId', into: 'buyers', field: '', compute: () => 0 })).toThrow(ValidationError)
  })
  it('rejects a non-function compute', () => {
    // @ts-expect-error — compute must be a function
    expect(() => withRollup({ from: 'sales', key: 'buyerId', into: 'buyers', field: 'f', compute: 5 })).toThrow(ValidationError)
  })
})

describe('withRollup — aggregate maintenance (#376)', () => {
  async function setup(indexed = false) {
    const db = await createNoydb({
      store: memory(), user: 'alice', secret: 'rollup-passphrase-2026',
      derivationStrategies: [totalSpentRollup()],
    })
    const v = await db.openVault('firm')
    const buyers = v.collection<Buyer>('buyers')
    const sales = indexed
      ? v.collection<Sale>('sales', { indexes: ['buyerId'] })
      : v.collection<Sale>('sales')
    return { db, v, buyers, sales }
  }

  it('maintains the aggregate across insert, update, and delete', async () => {
    const { buyers, sales } = await setup()
    await buyers.put('b1', { id: 'b1', companyName: 'Acme' })

    await sales.put('s1', { id: 's1', buyerId: 'b1', total: 100 })
    expect((await buyers.get('b1'))?.totalSpent).toBe(100)

    await sales.put('s2', { id: 's2', buyerId: 'b1', total: 250 })
    expect((await buyers.get('b1'))?.totalSpent).toBe(350)

    // Update a child → recompute.
    await sales.put('s2', { id: 's2', buyerId: 'b1', total: 50 })
    expect((await buyers.get('b1'))?.totalSpent).toBe(150)

    // Delete a child → recompute (gap-free).
    await sales.delete('s1')
    expect((await buyers.get('b1'))?.totalSpent).toBe(50)

    await sales.delete('s2')
    expect((await buyers.get('b1'))?.totalSpent).toBe(0)
  })

  it('works with an FK index on the child', async () => {
    const { buyers, sales } = await setup(true)
    await buyers.put('b1', { id: 'b1', companyName: 'Acme' })
    await sales.put('s1', { id: 's1', buyerId: 'b1', total: 100 })
    await sales.put('s2', { id: 's2', buyerId: 'b1', total: 200 })
    expect((await buyers.get('b1'))?.totalSpent).toBe(300)
    await sales.delete('s1')
    expect((await buyers.get('b1'))?.totalSpent).toBe(200)
  })

  it('isolates parents', async () => {
    const { buyers, sales } = await setup()
    await buyers.put('b1', { id: 'b1', companyName: 'Acme' })
    await buyers.put('b2', { id: 'b2', companyName: 'Globex' })
    await sales.put('s1', { id: 's1', buyerId: 'b1', total: 100 })
    await sales.put('s2', { id: 's2', buyerId: 'b2', total: 999 })
    await sales.put('s3', { id: 's3', buyerId: 'b1', total: 50 })
    expect((await buyers.get('b1'))?.totalSpent).toBe(150)
    expect((await buyers.get('b2'))?.totalSpent).toBe(999)
  })

  it('fills in a parent created AFTER its children', async () => {
    const { buyers, sales } = await setup()
    // Children written first — no parent record yet, so the rollup has
    // nowhere to write (silently skipped).
    await sales.put('s1', { id: 's1', buyerId: 'b1', total: 100 })
    await sales.put('s2', { id: 's2', buyerId: 'b1', total: 200 })
    // Now the parent appears → a parent write recomputes its own aggregate.
    await buyers.put('b1', { id: 'b1', companyName: 'Acme' })
    expect((await buyers.get('b1'))?.totalSpent).toBe(300)
  })

  it('patches only the rollup field — other parent fields preserved', async () => {
    const { buyers, sales } = await setup()
    await buyers.put('b1', { id: 'b1', companyName: 'Acme' })
    await sales.put('s1', { id: 's1', buyerId: 'b1', total: 100 })
    const b = await buyers.get('b1')
    expect(b?.totalSpent).toBe(100)
    expect(b?.companyName).toBe('Acme') // untouched
  })

  it('supports an object aggregate (group-by-style) value', async () => {
    const db = await createNoydb({
      store: memory(), user: 'alice', secret: 'rollup-obj-passphrase-2026',
      derivationStrategies: [
        withRollup<Sale & { year: number }, Buyer>({
          from: 'sales', key: 'buyerId', into: 'buyers', field: 'byYear',
          compute: (sales) => {
            const out: Record<string, number> = {}
            for (const s of sales) out[String(s.year)] = (out[String(s.year)] ?? 0) + s.total
            return out
          },
        }),
      ],
    })
    const v = await db.openVault('firm')
    const buyers = v.collection<Buyer & { byYear?: Record<string, number> }>('buyers')
    const sales = v.collection<Sale & { year: number }>('sales')
    await buyers.put('b1', { id: 'b1', companyName: 'Acme' })
    await sales.put('s1', { id: 's1', buyerId: 'b1', total: 100, year: 2026 })
    await sales.put('s2', { id: 's2', buyerId: 'b1', total: 50, year: 2026 })
    await sales.put('s3', { id: 's3', buyerId: 'b1', total: 70, year: 2027 })
    expect((await buyers.get('b1'))?.byYear).toEqual({ '2026': 150, '2027': 70 })
    await sales.delete('s1')
    expect((await buyers.get('b1'))?.byYear).toEqual({ '2026': 50, '2027': 70 })
  })
})
