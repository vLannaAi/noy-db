// Composite (multi-field) triggerBy — #1249.
// Spec: docs/superpowers/specs/2026-08-29-composite-triggerby-design.md
import { describe, it, expect } from 'vitest'
import { createNoydb, withDerivation, ValidationError, DerivationCapExceededError } from '../../src/index.js'
import type { NoydbStore, EncryptedEnvelope } from '../../src/kernel/types.js'
import { DerivationRegistry } from '../../src/with-formula/derivations/registry.js'

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

interface Bill extends Record<string, unknown> { id: string; clientId: string; cycle: string; status?: string }
interface Disbursement extends Record<string, unknown> { id: string; clientId: string; cycle: string; amount: number }

function billStatusStrategy(extra: { maxFanout?: number } = {}) {
  return withDerivation<Bill, { self: Bill }>({
    source: 'bills',
    deterministic: true,
    triggerBy: [{
      collection: 'disbursements',
      match: [{ from: 'clientId', to: 'clientId' }, { from: 'cycle', to: 'cycle' }],
      ...(extra.maxFanout !== undefined ? { maxFanout: extra.maxFanout } : {}),
    }],
    outputs: { self: { shape: 'record', collection: 'bills', denorm: ['status'] } },
    derive: async (bill, ctx) => {
      const all = await ctx.vault.collection<Disbursement>('disbursements').query()
        .where('clientId', '==', bill.clientId).where('cycle', '==', bill.cycle).toArray()
      const covered = all.reduce((s, d) => s + d.amount, 0) > 0
      return { self: { ...bill, status: covered ? 'covered' : 'uncovered' } as Bill }
    },
    lifecycle: 'eager',
  })
}

describe('composite triggerBy — factory validation (#1249)', () => {
  const base = {
    source: 'bills', deterministic: true as const, lifecycle: 'eager' as const,
    outputs: { self: { shape: 'record' as const, collection: 'bills', denorm: ['status'] } },
    derive: (b: Bill) => ({ self: b }),
  }
  it('rejects an entry with BOTH on and match', () => {
    expect(() => withDerivation<Bill, { self: Bill }>({
      ...base,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      triggerBy: [{ collection: 'disbursements', on: 'clientId', match: [{ from: 'id', to: 'clientId' }] } as any],
    })).toThrow(ValidationError)
  })
  it('rejects an entry with NEITHER on nor match', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => withDerivation<Bill, { self: Bill }>({ ...base, triggerBy: [{ collection: 'disbursements' } as any] }))
      .toThrow(ValidationError)
  })
  it('rejects empty match array', () => {
    expect(() => withDerivation<Bill, { self: Bill }>({ ...base, triggerBy: [{ collection: 'disbursements', match: [] }] }))
      .toThrow(ValidationError)
  })
  it('rejects an empty from or to', () => {
    expect(() => withDerivation<Bill, { self: Bill }>({ ...base, triggerBy: [{ collection: 'disbursements', match: [{ from: '', to: 'clientId' }] }] }))
      .toThrow(ValidationError)
    expect(() => withDerivation<Bill, { self: Bill }>({ ...base, triggerBy: [{ collection: 'disbursements', match: [{ from: 'clientId', to: '' }] }] }))
      .toThrow(ValidationError)
  })
  it('rejects duplicate `to` within one entry', () => {
    expect(() => withDerivation<Bill, { self: Bill }>({
      ...base,
      triggerBy: [{ collection: 'disbursements', match: [{ from: 'clientId', to: 'clientId' }, { from: 'cycle', to: 'clientId' }] }],
    })).toThrow(ValidationError)
  })
  it('accepts a valid composite entry (and the existing on-form untouched)', () => {
    expect(() => billStatusStrategy()).not.toThrow()
    expect(() => withDerivation<Bill, { self: Bill }>({ ...base, triggerBy: [{ collection: 'clients', on: 'clientId' }] })).not.toThrow()
  })
})

describe('registry — normalized triggers (#1249)', () => {
  it('hasFieldMatchTriggerFor: true only for field-match entries', async () => {
    const reg = new DerivationRegistry()
    await reg.register(billStatusStrategy().spec)          // match-form on 'disbursements'
    expect(reg.hasFieldMatchTriggerFor('disbursements')).toBe(true)
    expect(reg.hasFieldMatchTriggerFor('bills')).toBe(false)     // source, not trigger
    expect(reg.hasFieldMatchTriggerFor('unrelated')).toBe(false)
    const reg2 = new DerivationRegistry()
    await reg2.register(withDerivation<Bill, { self: Bill }>({
      source: 'bills', deterministic: true, lifecycle: 'eager',
      triggerBy: [{ collection: 'clients', on: 'clientId' }],   // id-form: no prior needed
      outputs: { self: { shape: 'record', collection: 'bills', denorm: ['status'] } },
      derive: (b) => ({ self: b }),
    }).spec)
    expect(reg2.hasFieldMatchTriggerFor('clients')).toBe(false)
  })
  it('validateFieldsFor: throws on unknown to-field for the source; silent when keys undefined', async () => {
    const reg = new DerivationRegistry()
    await reg.register(withDerivation<Bill, { self: Bill }>({
      source: 'bills', deterministic: true, lifecycle: 'eager',
      triggerBy: [{ collection: 'disbursements', match: [{ from: 'clientId', to: 'clientIdd' }] }], // typo
      outputs: { self: { shape: 'record', collection: 'bills', denorm: ['status'] } },
      derive: (b) => ({ self: b }),
    }).spec)
    expect(() => reg.validateFieldsFor('bills', new Set(['id', 'clientId', 'cycle']))).toThrow(ValidationError)
    expect(() => reg.validateFieldsFor('bills', undefined)).not.toThrow()          // unenumerable: silent
    expect(() => reg.validateFieldsFor('bills', new Set(['clientIdd']))).not.toThrow() // field exists: fine
  })
  it('validateFieldsFor: denorm fields are exempt on the source side', async () => {
    const reg = new DerivationRegistry()
    await reg.register(billStatusStrategy().spec)
    // 'status' is denorm-owned, absent from the schema keys — must not fire
    expect(() => reg.validateFieldsFor('bills', new Set(['id', 'clientId', 'cycle']), new Set(['status']))).not.toThrow()
  })
  it('validateFieldsFor: throws on unknown from-field for the TRIGGER collection', async () => {
    const reg = new DerivationRegistry()
    await reg.register(billStatusStrategy().spec)   // from: clientId, cycle on disbursements
    expect(() => reg.validateFieldsFor('disbursements', new Set(['id', 'amount']))).toThrow(ValidationError)
    expect(() => reg.validateFieldsFor('disbursements', new Set(['clientId', 'cycle', 'amount']))).not.toThrow()
  })
})

describe('composite fan-out query (#1249)', () => {
  it('matches on the conjunction; index-vs-scan equivalence', async () => {
    // Two dbs: one with an FK index on clientId, one without — same matched sets.
    // Build each: 3 bills (c1/Q1, c1/Q2, c2/Q1); pairs [clientId=c1, cycle=Q1] -> exactly ['b1'].
    for (const indexed of [false, true]) {
      const db = await createNoydb({
        store: toMemory(), user: 'alice', secret: 'composite-q-2026',
        derivationStrategies: [billStatusStrategy()],
      })
      const v = await db.openVault('firm')
      // Indexed variant wired the same way as trigger-by.test.ts's `indexed` setup:
      // per-collection `{ indexes: [...] }`, not a createNoydb-level option.
      const bills = indexed
        ? v.collection<Bill>('bills', { indexes: ['clientId'] })
        : v.collection<Bill>('bills')
      await bills.put('b1', { id: 'b1', clientId: 'c1', cycle: 'Q1' })
      await bills.put('b2', { id: 'b2', clientId: 'c1', cycle: 'Q2' })
      await bills.put('b3', { id: 'b3', clientId: 'c2', cycle: 'Q1' })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ids = await (bills as any)._findMatchingCompositeIds([
        { field: 'clientId', value: 'c1' }, { field: 'cycle', value: 'Q1' },
      ])
      expect(ids.sort()).toEqual(['b1'])
      await db.close()
    }
  })
  it('single-pair delegate preserves _findMatchingIds behaviour', async () => {
    const db = await createNoydb({ store: toMemory(), user: 'alice', secret: 'composite-q2-2026', derivationStrategies: [billStatusStrategy()] })
    const v = await db.openVault('firm')
    const bills = v.collection<Bill>('bills')
    await bills.put('b1', { id: 'b1', clientId: 'c1', cycle: 'Q1' })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await (bills as any)._findMatchingIds('clientId', 'c1')).toEqual(['b1'])
    await db.close()
  })
  it('single-pair indexed path answers straight from the index — zero record reads (#1249 review finding)', async () => {
    // Wraps toMemory() to count adapter get/list calls. The index alone must decide
    // membership when the sole pair is covered — same contract as the OLD
    // `_findMatchingIds`'s `if (hit) return [...hit]` fast path, which read nothing.
    const base = toMemory()
    const calls = { get: 0, list: 0 }
    const store: NoydbStore = {
      ...base,
      async get(v2, c, i) { calls.get++; return base.get(v2, c, i) },
      async list(v2, c) { calls.list++; return base.list(v2, c) },
    }
    const db = await createNoydb({ store, user: 'alice', secret: 'composite-q3-2026', derivationStrategies: [billStatusStrategy()] })
    const v = await db.openVault('firm')
    const bills = v.collection<Bill>('bills', { indexes: ['clientId'] })
    await bills.put('b1', { id: 'b1', clientId: 'c1', cycle: 'Q1' })
    await bills.put('b2', { id: 'b2', clientId: 'c1', cycle: 'Q2' })
    await bills.put('b3', { id: 'b3', clientId: 'c2', cycle: 'Q1' })
    calls.get = 0
    calls.list = 0
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ids = await (bills as any)._findMatchingCompositeIds([{ field: 'clientId', value: 'c1' }])
    expect(ids.sort()).toEqual(['b1', 'b2'])
    expect(calls.get).toBe(0)
    expect(calls.list).toBe(0)
    await db.close()
  })
})
