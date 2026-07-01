import { describe, it, expect } from 'vitest'
import { createNoydb, withDerivation, DerivationCycleError } from '../../src/index.js'
import { ValidationError } from '../../src/errors.js'
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
        if (vname === v) {
          out[cname!] = out[cname!] ?? {}
          out[cname!]![id!] = env
        }
      }
      return out
    },
    async saveAll(v, payload) {
      for (const c of Object.keys(payload)) {
        for (const i of Object.keys(payload[c]!)) {
          data.set(k(v, c, i), payload[c]![i]!)
        }
      }
    },
  }
}

// The accounting same-id shape (#344): an `invoice` row and its `fx`
// rate row share an id. The derivation's primary source is `invoice`,
// but it reads the sibling `fx` rate to compute a converted total.
// Declaring `sources: ['fx']` makes an fx write at the same id re-fire
// the derivation against the primary invoice record.
interface Invoice extends Record<string, unknown> { id: string; amount: number }
interface Fx extends Record<string, unknown> { id: string; rate: number }
interface Converted extends Record<string, unknown> { id: string; total: number; _derivedFrom?: unknown }

describe('Derivation — declared sibling sources[] (#344)', () => {
  it('(1) a write to a declared sibling re-fires derive against the primary source', async () => {
    const strategy = withDerivation<Invoice, { converted: Converted }>({
      source: 'invoices',
      sources: ['fx'],
      deterministic: true,
      outputs: { converted: { shape: 'record', collection: 'converted' } },
      derive: async (invoice, ctx) => {
        const fx = await ctx.vault.collection<Fx>('fx').get(invoice.id)
        return { converted: { id: invoice.id, total: invoice.amount * (fx?.rate ?? 1) } }
      },
      lifecycle: 'eager',
    })
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'derivation-sibling-rerun-passphrase-2026',
      derivationStrategies: [strategy],
    })
    const v = await db.openVault('demo')

    await v.collection<Invoice>('invoices').put('i1', { id: 'i1', amount: 100 })
    // First derive ran with no fx → rate defaults to 1.
    expect((await v.collection<Converted>('converted').get('i1'))?.total).toBe(100)

    // A write to the sibling `fx` at the SAME id must re-fire the
    // derivation; the output reflects the new sibling state.
    await v.collection<Fx>('fx').put('i1', { id: 'i1', rate: 1.25 })
    expect((await v.collection<Converted>('converted').get('i1'))?.total).toBe(125)
  })

  it('(2) a write to the primary source still re-fires', async () => {
    const strategy = withDerivation<Invoice, { converted: Converted }>({
      source: 'invoices',
      sources: ['fx'],
      deterministic: true,
      outputs: { converted: { shape: 'record', collection: 'converted' } },
      derive: async (invoice, ctx) => {
        const fx = await ctx.vault.collection<Fx>('fx').get(invoice.id)
        return { converted: { id: invoice.id, total: invoice.amount * (fx?.rate ?? 1) } }
      },
      lifecycle: 'eager',
    })
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'derivation-sibling-primary-passphrase-2026',
      derivationStrategies: [strategy],
    })
    const v = await db.openVault('demo')

    await v.collection<Fx>('fx').put('i1', { id: 'i1', rate: 2 })
    await v.collection<Invoice>('invoices').put('i1', { id: 'i1', amount: 50 })
    expect((await v.collection<Converted>('converted').get('i1'))?.total).toBe(100)

    await v.collection<Invoice>('invoices').put('i1', { id: 'i1', amount: 70 })
    expect((await v.collection<Converted>('converted').get('i1'))?.total).toBe(140)
  })

  it('(3) sibling write with no primary record at that id is a silent no-op', async () => {
    const strategy = withDerivation<Invoice, { converted: Converted }>({
      source: 'invoices',
      sources: ['fx'],
      deterministic: true,
      outputs: { converted: { shape: 'record', collection: 'converted' } },
      derive: async (invoice, ctx) => {
        const fx = await ctx.vault.collection<Fx>('fx').get(invoice.id)
        return { converted: { id: invoice.id, total: invoice.amount * (fx?.rate ?? 1) } }
      },
      lifecycle: 'eager',
    })
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'derivation-sibling-noprimary-passphrase-2026',
      derivationStrategies: [strategy],
    })
    const v = await db.openVault('demo')

    // No invoice at 'orphan' — the sibling write must not throw, and
    // must not synthesise any output.
    await expect(
      v.collection<Fx>('fx').put('orphan', { id: 'orphan', rate: 3 }),
    ).resolves.not.toThrow()
    expect(await v.collection<Converted>('converted').get('orphan')).toBeNull()
  })

  it('(4) lazy lifecycle: a sibling write marks stale, resolve-on-read re-derives', async () => {
    const strategy = withDerivation<Invoice, { converted: Converted }>({
      source: 'invoices',
      sources: ['fx'],
      deterministic: true,
      outputs: { converted: { shape: 'record', collection: 'converted' } },
      derive: async (invoice, ctx) => {
        const fx = await ctx.vault.collection<Fx>('fx').get(invoice.id)
        return { converted: { id: invoice.id, total: invoice.amount * (fx?.rate ?? 1) } }
      },
      lifecycle: 'lazy',
    })
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'derivation-sibling-lazy-passphrase-2026',
      derivationStrategies: [strategy],
    })
    const v = await db.openVault('demo')

    await v.collection<Invoice>('invoices').put('i1', { id: 'i1', amount: 100 })
    expect((await v.collection<Converted>('converted').get('i1'))?.total).toBe(100)

    // Sibling write marks the output stale; the next read re-derives
    // against the primary invoice and reflects the new rate.
    await v.collection<Fx>('fx').put('i1', { id: 'i1', rate: 1.5 })
    expect((await v.collection<Converted>('converted').get('i1'))?.total).toBe(150)
  })

  it('(5) multiple declared siblings — a write to any one triggers', async () => {
    interface Tax extends Record<string, unknown> { id: string; pct: number }
    interface Total extends Record<string, unknown> { id: string; total: number }
    const strategy = withDerivation<Invoice, { total: Total }>({
      source: 'invoices',
      sources: ['fx', 'tax'],
      deterministic: true,
      outputs: { total: { shape: 'record', collection: 'totals' } },
      derive: async (invoice, ctx) => {
        const fx = await ctx.vault.collection<Fx>('fx').get(invoice.id)
        const tax = await ctx.vault.collection<Tax>('tax').get(invoice.id)
        const base = invoice.amount * (fx?.rate ?? 1)
        return { total: { id: invoice.id, total: base * (1 + (tax?.pct ?? 0)) } }
      },
      lifecycle: 'eager',
    })
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'derivation-sibling-multi-passphrase-2026',
      derivationStrategies: [strategy],
    })
    const v = await db.openVault('demo')

    await v.collection<Invoice>('invoices').put('i1', { id: 'i1', amount: 100 })
    expect((await v.collection<Total>('totals').get('i1'))?.total).toBe(100)

    await v.collection<Fx>('fx').put('i1', { id: 'i1', rate: 2 })
    expect((await v.collection<Total>('totals').get('i1'))?.total).toBe(200)

    await v.collection<Tax>('tax').put('i1', { id: 'i1', pct: 0.1 })
    expect((await v.collection<Total>('totals').get('i1'))?.total).toBeCloseTo(220)
  })

  it('(6) sources[] containing the primary source throws ValidationError at factory time', () => {
    expect(() => withDerivation<Invoice, { converted: Converted }>({
      source: 'invoices',
      sources: ['fx', 'invoices'],
      deterministic: true,
      outputs: { converted: { shape: 'record', collection: 'converted' } },
      derive: (invoice) => ({ converted: { id: invoice.id, total: invoice.amount } }),
      lifecycle: 'eager',
    })).toThrow(ValidationError)
  })

  it('(6b) empty / non-string sources[] entry throws ValidationError', () => {
    expect(() => withDerivation<Invoice, { converted: Converted }>({
      source: 'invoices',
      sources: [''],
      deterministic: true,
      outputs: { converted: { shape: 'record', collection: 'converted' } },
      derive: (invoice) => ({ converted: { id: invoice.id, total: invoice.amount } }),
      lifecycle: 'eager',
    })).toThrow(ValidationError)
  })

  it('(7) a declared sibling that is also an output forms a detectable cycle at vault open', async () => {
    // source 'A' triggers off sibling 'B', and also writes to 'B' →
    // A's _bySource keys are {A, B}; walking B's strategy outputs back
    // to B closes the cycle.
    const cyclic = withDerivation({
      source: 'A',
      sources: ['B'],
      deterministic: true,
      outputs: { o: { shape: 'record', collection: 'B' } },
      derive: () => ({ o: {} }),
      lifecycle: 'eager',
    })
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'derivation-sibling-cycle-passphrase-2026',
      derivationStrategies: [cyclic],
    })
    await expect(db.openVault('demo')).rejects.toBeInstanceOf(DerivationCycleError)
  })
})
