// Aggregate-onto-parent rollups (#376 slice 2).
//
// withRollup({ from, key, into, field, compute }) keeps a summary field on the
// parent in sync with its children, on insert / update / delete, gap-free.

import { describe, it, expect } from 'vitest'
import { createNoydb, withRollup, ValidationError, DerivationCycleError } from '../../src/index.js'
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
      store: toMemory(), user: 'alice', secret: 'rollup-secret-2026',
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
      store: toMemory(), user: 'alice', secret: 'rollup-obj-secret-2026',
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

describe('withRollup — mutual/rotating cycle refusal at declare time (#639)', () => {
  it('refuses two mutually-dependent rollups (A rollup into B.x, B rollup into A.y)', async () => {
    const bRollsUpA = withRollup({ from: 'a', key: 'aId', into: 'b', field: 'x', compute: () => 0 })
    const aRollsUpB = withRollup({ from: 'b', key: 'bId', into: 'a', field: 'y', compute: () => 0 })
    const db = await createNoydb({
      store: toMemory(), user: 'alice', secret: 'rollup-mutual-cycle-secret-2026',
      derivationStrategies: [bRollsUpA, aRollsUpB],
    })
    await expect(db.openVault('demo')).rejects.toBeInstanceOf(DerivationCycleError)
  })

  it('refuses a three-collection rollup rotation (A rollup into B.x, B rollup into C.y, C rollup into A.z)', async () => {
    const bRollsUpA = withRollup({ from: 'a', key: 'aId', into: 'b', field: 'x', compute: () => 0 })
    const cRollsUpB = withRollup({ from: 'b', key: 'bId', into: 'c', field: 'y', compute: () => 0 })
    const aRollsUpC = withRollup({ from: 'c', key: 'cId', into: 'a', field: 'z', compute: () => 0 })
    const db = await createNoydb({
      store: toMemory(), user: 'alice', secret: 'rollup-rotation-cycle-secret-2026',
      derivationStrategies: [bRollsUpA, cRollsUpB, aRollsUpC],
    })
    await expect(db.openVault('demo')).rejects.toBeInstanceOf(DerivationCycleError)
  })

  it('does not refuse an acyclic rollup chain (A rollup into B.x; B rollup into C.z) — control', async () => {
    const bRollsUpA = withRollup({ from: 'a', key: 'aId', into: 'b', field: 'x', compute: () => 0 })
    const cRollsUpB = withRollup({ from: 'b', key: 'bId', into: 'c', field: 'z', compute: () => 0 })
    const db = await createNoydb({
      store: toMemory(), user: 'alice', secret: 'rollup-acyclic-chain-secret-2026',
      derivationStrategies: [bRollsUpA, cRollsUpB],
    })
    await expect(db.openVault('demo')).resolves.toBeDefined()
  })
})

/**
 * #1257 — a child moving from parent A to parent B left A's aggregate stale.
 *
 * The dispatcher read the key from the INCOMING record only, so it recomputed
 * the new parent and never touched the old one. Same old-value class #1249
 * fixed for `triggerBy` with union fan-out; the prior-record capture that fix
 * added to the write path is what makes this a small change rather than a new
 * mechanism.
 *
 * The stranded value is the dangerous part: A's `totalSpent` keeps a number
 * that was correct once, so it reads as data rather than as an error — nobody
 * re-checks a plausible total.
 */
describe('withRollup — a child that re-parents (#1257)', () => {
  it('recomputes BOTH the old and the new parent', async () => {
    const db = await createNoydb({
      store: toMemory(), user: 'alice', secret: 'rollup-reparent-2026',
      derivationStrategies: [totalSpentRollup()],
    })
    const v = await db.openVault('firm')
    const buyers = v.collection<Buyer>('buyers')
    const sales = v.collection<Sale>('sales')

    await buyers.put('b1', { id: 'b1', companyName: 'Acme' })
    await buyers.put('b2', { id: 'b2', companyName: 'Globex' })
    await sales.put('s1', { id: 's1', buyerId: 'b1', total: 100 })
    await sales.put('s2', { id: 's2', buyerId: 'b1', total: 40 })

    expect((await buyers.get('b1'))?.totalSpent).toBe(140)
    expect((await buyers.get('b2'))?.totalSpent ?? 0).toBe(0)

    // Re-parent s1: b1 -> b2.
    await sales.put('s1', { id: 's1', buyerId: 'b2', total: 100 })

    expect((await buyers.get('b2'))?.totalSpent).toBe(100)   // new parent gains it
    expect((await buyers.get('b1'))?.totalSpent).toBe(40)    // OLD parent loses it
    await db.close()
  })

  it('does NOT double-recompute when the key is unchanged — the control', async () => {
    const db = await createNoydb({
      store: toMemory(), user: 'alice', secret: 'rollup-samekey-2026',
      derivationStrategies: [totalSpentRollup()],
    })
    const v = await db.openVault('firm')
    const buyers = v.collection<Buyer>('buyers')
    const sales = v.collection<Sale>('sales')

    await buyers.put('b1', { id: 'b1', companyName: 'Acme' })
    await sales.put('s1', { id: 's1', buyerId: 'b1', total: 100 })
    // Same parent, new amount — the ordinary update path must still be right.
    await sales.put('s1', { id: 's1', buyerId: 'b1', total: 250 })
    expect((await buyers.get('b1'))?.totalSpent).toBe(250)
    await db.close()
  })
})

/**
 * Design pass, decision 5 — `rowKey is required` reported the wrong condition.
 *
 * A field NAME (the shape every neighbouring option takes) produced "rowKey is
 * required", which names ABSENCE. Two states that warrant different responses
 * — "you forgot it" vs "you passed the wrong type" — rendered identically.
 */
describe('withMaterializedView rowKey — absent vs wrong-typed (design pass, decision 5)', () => {
  it('a STRING rowKey says it must be a function, and names the type it got', async () => {
    const { withMaterializedView } = await import('../../src/with-formula/materialized-views/with-materialized-view.js')
    expect(() => withMaterializedView({
      name: 'byTag', source: 'rows', refresh: 'eager',
      rowKey: 'someField', query: () => undefined,
    } as never)).toThrow(/must be a FUNCTION/)
  })

  it('an ABSENT rowKey still says it is required — the control', async () => {
    const { withMaterializedView } = await import('../../src/with-formula/materialized-views/with-materialized-view.js')
    expect(() => withMaterializedView({
      name: 'byTag', source: 'rows', refresh: 'eager',
      query: () => undefined,
    } as never)).toThrow(/is required/)
  })
})

/**
 * #1269 / design pass decision 2 — an MV group key naming a VIRTUAL computed
 * field bucketed every row under an `undefined` key: a well-formed aggregate
 * carrying a wrong NUMBER, not an error. `query().where()` already refuses the
 * same field, so the two halves of one apparent query layer disagreed.
 *
 * Refused at collection registration where the MV is visible. The residue is
 * DELIBERATE and documented at the guard: a single-query MV that constructs its
 * own source inside `query: (db) => db.collection(name)` is registered after
 * this point, so it is not caught here.
 */
describe('MV groupBy on a VIRTUAL field is refused (#1269)', () => {
  const virtualTag = (r: Record<string, unknown>) => `t${String(r['total'])}`

  async function withMV(groupField: string, mode: 'virtual' | 'materialized') {
    const { withMaterializedView } = await import('../../src/with-formula/materialized-views/with-materialized-view.js')
    const { withReduce } = await import('../../src/with-lookup/reduce/index.js')
    const db = await createNoydb({
      store: toMemory(), user: 'alice', secret: `mv-virtual-${groupField}-${mode}-2026`,
      reduceStrategy: withReduce(),
      materializedViewStrategies: [withMaterializedView({
        name: 'byTag', source: 'sales', refresh: 'eager',
        rowKey: (r: Record<string, unknown>) => String(r[groupField]),
        unionSources: [{ collection: 'sales', map: (r: unknown) => r }],
        groupBy: [groupField],
        aggregate: { n: { count: true } },
      } as never)],
    } as never)
    const v = await db.openVault('firm')
    const make = () => v.collection<Sale>('sales', {
      computed: { tag: { fn: virtualTag, mode } },
    } as never)
    return { db, make }
  }

  it('refuses a virtual group key at registration, naming the field', async () => {
    const { db, make } = await withMV('tag', 'virtual')
    expect(make).toThrow(/VIRTUAL computed field/)
    await db.close()
  })

  it('accepts the same MV when the field is materialized — the control', async () => {
    const { db, make } = await withMV('tag', 'materialized')
    expect(make).not.toThrow()
    await db.close()
  })

  it('accepts a group key that is a plain stored field — the second control', async () => {
    const { db, make } = await withMV('buyerId', 'virtual')
    expect(make).not.toThrow()   // 'tag' is virtual but nothing groups on it
    await db.close()
  })
})
