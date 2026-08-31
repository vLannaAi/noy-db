// Composite (multi-field) triggerBy — #1249.
// Spec: docs/superpowers/specs/2026-08-29-composite-triggerby-design.md
import { describe, it, expect, vi } from 'vitest'
import { createNoydb, withDerivation, ValidationError, DerivationCapExceededError, DerivationCycleError, DerivationOutputShapeError } from '../../src/index.js'
import type { NoydbStore, EncryptedEnvelope } from '../../src/kernel/types.js'
import type { DerivationContext } from '../../src/with-formula/derivations/types.js'
import { DerivationRegistry } from '../../src/with-formula/derivations/registry.js'
import { dict } from '../../src/via/lookup/descriptor.js'
import { via } from '../../src/kernel/via/compose.js'
import { computed } from '../../src/via/computed/descriptor.js'
import { z } from 'zod'

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
  it('validateFieldsFor: throws on unknown to-field for the source; silent when schema unenumerable', async () => {
    const { z } = await import('zod')
    const reg = new DerivationRegistry()
    await reg.register(withDerivation<Bill, { self: Bill }>({
      source: 'bills', deterministic: true, lifecycle: 'eager',
      triggerBy: [{ collection: 'disbursements', match: [{ from: 'clientId', to: 'clientIdd' }] }], // typo
      outputs: { self: { shape: 'record', collection: 'bills', denorm: ['status'] } },
      derive: (b) => ({ self: b }),
    }).spec)
    expect(() => reg.validateFieldsFor('bills', z.object({ id: z.string(), clientId: z.string(), cycle: z.string() }), []))
      .toThrow(ValidationError)
    expect(() => reg.validateFieldsFor('bills', undefined, [])).not.toThrow()          // unenumerable: silent
    expect(() => reg.validateFieldsFor('bills', z.object({ clientIdd: z.string() }), [])).not.toThrow() // field exists: fine
  })
  it('validateFieldsFor: denorm fields are exempt on the source side', async () => {
    const { z } = await import('zod')
    const reg = new DerivationRegistry()
    await reg.register(billStatusStrategy().spec)
    // 'status' is denorm-owned, absent from the schema keys — must not fire
    expect(() => reg.validateFieldsFor('bills', z.object({ id: z.string(), clientId: z.string(), cycle: z.string() }), []))
      .not.toThrow()
  })
  it('validateFieldsFor: throws on unknown from-field for the TRIGGER collection', async () => {
    const { z } = await import('zod')
    const reg = new DerivationRegistry()
    await reg.register(billStatusStrategy().spec)   // from: clientId, cycle on disbursements
    expect(() => reg.validateFieldsFor('disbursements', z.object({ id: z.string(), amount: z.number() }), []))
      .toThrow(ValidationError)
    expect(() => reg.validateFieldsFor('disbursements', z.object({ clientId: z.string(), cycle: z.string(), amount: z.number() }), []))
      .not.toThrow()
  })
  it('validateFieldsFor: denorm fields are exempt on the TRIGGER (from) side too (Imp 1)', async () => {
    const { z } = await import('zod')
    const reg = new DerivationRegistry()
    // Strategy A reads `note` — a field owned by another derivation's
    // self-write denorm onto `disbursements` — as a `from` on the trigger side.
    await reg.register(withDerivation<Bill, { self: Bill }>({
      source: 'bills', deterministic: true, lifecycle: 'eager',
      triggerBy: [{ collection: 'disbursements', match: [{ from: 'note', to: 'clientId' }] }],
      outputs: { self: { shape: 'record', collection: 'bills', denorm: ['status'] } },
      derive: (b) => ({ self: b }),
    }).spec)
    // Strategy B denorm-writes `note` onto `disbursements` itself.
    await reg.register(withDerivation<Disbursement, { self: Disbursement }>({
      source: 'disbursements', deterministic: true, lifecycle: 'eager',
      outputs: { self: { shape: 'record', collection: 'disbursements', denorm: ['note'] } },
      derive: (d) => ({ self: d }),
    }).spec)
    // 'note' is absent from the schema — must not false-positive as a typo.
    expect(() => reg.validateFieldsFor('disbursements', z.object({ id: z.string(), clientId: z.string(), cycle: z.string(), amount: z.number() }), []))
      .not.toThrow()
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

describe('composite triggerBy — write-path fan-out (#1249)', () => {
  async function setup() {
    const db = await createNoydb({ store: toMemory(), user: 'alice', secret: 'composite-w-2026', derivationStrategies: [billStatusStrategy()] })
    const v = await db.openVault('firm')
    const bills = v.collection<Bill>('bills')
    const disb = v.collection<Disbursement>('disbursements')
    await bills.put('b1', { id: 'b1', clientId: 'c1', cycle: 'Q1' })
    await bills.put('b2', { id: 'b2', clientId: 'c1', cycle: 'Q2' })
    await bills.put('b3', { id: 'b3', clientId: 'c2', cycle: 'Q1' })
    return { db, v, bills, disb }
  }
  it("the pilot's case: a disbursement write re-fires ONLY the matching (clientId, cycle) bills", async () => {
    const { db, bills, disb } = await setup()
    // Every bill's own put already self-derives 'uncovered' (isSource fires derive
    // immediately, same as sales/buyerName in trigger-by.test.ts — "on insert the
    // source path is already stamped"). What the disbursement write must NOT do is
    // flip an unmatched bill's status, so the baseline for "not fired" is 'uncovered',
    // not undefined.
    expect((await bills.get('b2'))?.status).toBe('uncovered')
    await disb.put('d1', { id: 'd1', clientId: 'c1', cycle: 'Q1', amount: 500 })
    expect((await bills.get('b1'))?.status).toBe('covered')      // matched
    expect((await bills.get('b2'))?.status).toBe('uncovered')    // same client, other cycle: NOT fired
    expect((await bills.get('b3'))?.status).toBe('uncovered')    // other client: NOT fired
    await db.close()
  })
  it('shared-key reverse match: single field-pair, neither side an id', async () => {
    const db = await createNoydb({
      store: toMemory(), user: 'alice', secret: 'composite-rev-2026',
      derivationStrategies: [withDerivation<Bill, { self: Bill }>({
        source: 'bills', deterministic: true, lifecycle: 'eager',
        triggerBy: [{ collection: 'clients', match: [{ from: 'entityId', to: 'entityId' }] }],
        outputs: { self: { shape: 'record', collection: 'bills', denorm: ['status'] } },
        // Conditional on real state (a matching client existing), not unconditional —
        // an unconditional derive would stamp every bill identically at its OWN
        // isSource put, before the client write ever runs, and the test would pass
        // whether or not the fan-out worked at all.
        derive: async (b, ctx) => {
          const matches = await ctx.vault.collection('clients').query()
            .where('entityId', '==', b.entityId).toArray()
          return { self: { ...b, status: matches.length > 0 ? 'touched' : (b.status as string | undefined) } as Bill }
        },
      })],
    })
    const v = await db.openVault('firm')
    const bills = v.collection<Bill>('bills')
    await bills.put('b1', { id: 'b1', clientId: 'c1', cycle: 'Q1', entityId: 'ent-1' } as Bill)
    await bills.put('b2', { id: 'b2', clientId: 'c1', cycle: 'Q1', entityId: 'ent-2' } as Bill)
    expect((await bills.get('b1'))?.status).toBeUndefined()   // no matching client yet
    await v.collection('clients').put('c1', { entityId: 'ent-1', services: ['pnd1'] })
    expect((await bills.get('b1'))?.status).toBe('touched')
    expect((await bills.get('b2'))?.status).toBeUndefined()
    await db.close()
  })
  it('maxFanout caps the matched set', async () => {
    const db = await createNoydb({ store: toMemory(), user: 'alice', secret: 'composite-cap-2026', derivationStrategies: [billStatusStrategy({ maxFanout: 1 })] })
    const v = await db.openVault('firm')
    const bills = v.collection<Bill>('bills')
    await bills.put('b1', { id: 'b1', clientId: 'c1', cycle: 'Q1' })
    await bills.put('b2', { id: 'b2', clientId: 'c1', cycle: 'Q1' })   // two matches, cap 1
    await expect(v.collection('disbursements').put('d1', { clientId: 'c1', cycle: 'Q1', amount: 1 }))
      .rejects.toThrow(DerivationCapExceededError)
    await db.close()
  })
  it('TWO entries naming the same collection BOTH fire (the .find() fix)', async () => {
    // one strategy with two triggers on 'events': match clientId, and match cycle.
    // A write matching only the second must still fan out.
    const db = await createNoydb({
      store: toMemory(), user: 'alice', secret: 'composite-two-2026',
      derivationStrategies: [withDerivation<Bill, { self: Bill }>({
        source: 'bills', deterministic: true, lifecycle: 'eager',
        triggerBy: [
          { collection: 'events', match: [{ from: 'clientId', to: 'clientId' }] },
          { collection: 'events', match: [{ from: 'cycle', to: 'cycle' }] },
        ],
        outputs: { self: { shape: 'record', collection: 'bills', denorm: ['status'] } },
        // Conditional on real 'events' state, same reasoning as the shared-key test:
        // an unconditional derive would already be stamped by b1's own isSource put,
        // making the assertion below pass even if the .find() bug were still present.
        derive: async (b, ctx) => {
          const byClient = await ctx.vault.collection('events').query()
            .where('clientId', '==', b.clientId).toArray()
          const byCycle = await ctx.vault.collection('events').query()
            .where('cycle', '==', b.cycle).toArray()
          const matched = byClient.length > 0 || byCycle.length > 0
          return { self: { ...b, status: matched ? 'poked' : (b.status as string | undefined) } as Bill }
        },
      })],
    })
    const v = await db.openVault('firm')
    const bills = v.collection<Bill>('bills')
    await bills.put('b1', { id: 'b1', clientId: 'cX', cycle: 'Q9' })
    expect((await bills.get('b1'))?.status).toBeUndefined()   // no matching event yet
    await v.collection('events').put('e1', { cycle: 'Q9' })   // matches ONLY the second entry (no clientId field)
    expect((await bills.get('b1'))?.status).toBe('poked')
    await db.close()
  })
})

describe('union fan-out on update (#1249, spec §7)', () => {
  it('a disbursement moving Q1→Q2 re-fires BOTH the old and new bill sets', async () => {
    const db = await createNoydb({ store: toMemory(), user: 'alice', secret: 'composite-u-2026', derivationStrategies: [billStatusStrategy()] })
    const v = await db.openVault('firm')
    const bills = v.collection<Bill>('bills')
    const disb = v.collection<Disbursement>('disbursements')
    await bills.put('b1', { id: 'b1', clientId: 'c1', cycle: 'Q1' })
    await bills.put('b2', { id: 'b2', clientId: 'c1', cycle: 'Q2' })
    await disb.put('d1', { id: 'd1', clientId: 'c1', cycle: 'Q1', amount: 500 })
    expect((await bills.get('b1'))?.status).toBe('covered')
    expect((await bills.get('b2'))?.status).toBe('uncovered')   // self-derived on b2's own put; unmatched by d1@Q1
    // MOVE the disbursement to Q2: b1 must become uncovered (old set re-fired),
    // b2 covered (new set fired). Without the union, b1 stays 'covered' — stale.
    await disb.put('d1', { id: 'd1', clientId: 'c1', cycle: 'Q2', amount: 500 })
    expect((await bills.get('b1'))?.status).toBe('uncovered')   // ← THE union assertion
    expect((await bills.get('b2'))?.status).toBe('covered')
    await db.close()
  })
  it('create (no prior) fans out the new tuple only — no error, no double-fire', async () => {
    const db = await createNoydb({ store: toMemory(), user: 'alice', secret: 'composite-u2-2026', derivationStrategies: [billStatusStrategy()] })
    const v = await db.openVault('firm')
    await v.collection<Bill>('bills').put('b1', { id: 'b1', clientId: 'c1', cycle: 'Q1' })
    await v.collection<Disbursement>('disbursements').put('d1', { id: 'd1', clientId: 'c1', cycle: 'Q1', amount: 1 })
    expect((await v.collection<Bill>('bills').get('b1'))?.status).toBe('covered')
    await db.close()
  })
  it('maxFanout caps the UNION', async () => {
    const db = await createNoydb({ store: toMemory(), user: 'alice', secret: 'composite-u3-2026', derivationStrategies: [billStatusStrategy({ maxFanout: 1 })] })
    const v = await db.openVault('firm')
    const bills = v.collection<Bill>('bills')
    await bills.put('b1', { id: 'b1', clientId: 'c1', cycle: 'Q1' })   // old set: 1
    await bills.put('b2', { id: 'b2', clientId: 'c1', cycle: 'Q2' })   // new set: 1 → union 2 > cap 1
    const disb = v.collection<Disbursement>('disbursements')
    await disb.put('d1', { id: 'd1', clientId: 'c1', cycle: 'Q1', amount: 1 })
    await expect(disb.put('d1', { id: 'd1', clientId: 'c1', cycle: 'Q2', amount: 1 }))
      .rejects.toThrow(DerivationCapExceededError)
    await db.close()
  })
})

describe('delete fan-out — both forms (#1249, spec §8)', () => {
  it('deleting a disbursement re-fires the matched bills (field-match form)', async () => {
    const db = await createNoydb({ store: toMemory(), user: 'alice', secret: 'composite-d-2026', derivationStrategies: [billStatusStrategy()] })
    const v = await db.openVault('firm')
    const bills = v.collection<Bill>('bills')
    const disb = v.collection<Disbursement>('disbursements')
    await bills.put('b1', { id: 'b1', clientId: 'c1', cycle: 'Q1' })
    await disb.put('d1', { id: 'd1', clientId: 'c1', cycle: 'Q1', amount: 500 })
    expect((await bills.get('b1'))?.status).toBe('covered')
    await disb.delete('d1')
    expect((await bills.get('b1'))?.status).toBe('uncovered')   // pre-#1249: stayed 'covered', silently stale
    await db.close()
  })
  it('deleting a buyer re-fires their sales (the PRE-EXISTING id-form gap, now closed)', async () => {
    // Reuse the buyerName denorm shape from trigger-by.test.ts: derive falls
    // back to null when the buyer is gone.
    interface Buyer2 extends Record<string, unknown> { id: string; companyName: string }
    interface Sale2 extends Record<string, unknown> { id: string; buyerId: string; buyerName?: string | null }
    const db = await createNoydb({
      store: toMemory(), user: 'alice', secret: 'composite-d2-2026',
      derivationStrategies: [withDerivation<Sale2, { self: Sale2 }>({
        source: 'sales', deterministic: true, lifecycle: 'eager',
        triggerBy: [{ collection: 'buyers', on: 'buyerId' }],
        outputs: { self: { shape: 'record', collection: 'sales', denorm: ['buyerName'] } },
        derive: async (sale, ctx) => {
          const b = await ctx.vault.collection<Buyer2>('buyers').get(sale.buyerId)
          return { self: { ...sale, buyerName: b?.companyName ?? null } as Sale2 }
        },
      })],
    })
    const v = await db.openVault('firm')
    const sales = v.collection<Sale2>('sales')
    await v.collection<Buyer2>('buyers').put('u1', { id: 'u1', companyName: 'ACME' })
    await sales.put('s1', { id: 's1', buyerId: 'u1' })
    await v.collection('buyers').put('u1', { id: 'u1', companyName: 'ACME Ltd' })
    expect((await sales.get('s1'))?.buyerName).toBe('ACME Ltd')
    await v.collection('buyers').delete('u1')
    expect((await sales.get('s1'))?.buyerName).toBeNull()       // re-derived against the absent parent
    await db.close()
  })
})

describe('match-field typo guard at collection construction (#1249, spec §5)', () => {
  const typoStrategy = () => withDerivation<Bill, { self: Bill }>({
    source: 'bills', deterministic: true, lifecycle: 'eager',
    triggerBy: [{ collection: 'disbursements', match: [{ from: 'clientId', to: 'clientIdd' }] }], // typo'd to
    outputs: { self: { shape: 'record', collection: 'bills', denorm: ['status'] } },
    derive: (b) => ({ self: b }),
  })
  it('throws at vault.collection() when the source has an enumerable schema missing the field', async () => {
    const { z } = await import('zod')
    const db = await createNoydb({ store: toMemory(), user: 'alice', secret: 'composite-g-2026', derivationStrategies: [typoStrategy()] })
    const v = await db.openVault('firm')
    expect(() => v.collection('bills', { schema: z.object({ id: z.string(), clientId: z.string(), cycle: z.string() }) }))
      .toThrow(ValidationError)
    await db.close()
  })
  it('SILENT for a TS-generic collection (unenumerable) — the #1253 posture', async () => {
    const db = await createNoydb({ store: toMemory(), user: 'alice', secret: 'composite-g2-2026', derivationStrategies: [typoStrategy()] })
    const v = await db.openVault('firm')
    expect(() => v.collection<Bill>('bills')).not.toThrow()   // no schema: fields unenumerable
    await db.close()
  })
  it('denorm-owned fields do not false-positive', async () => {
    const { z } = await import('zod')
    // billStatusStrategy writes denorm ['status']; schema omits it — must not throw.
    const db = await createNoydb({ store: toMemory(), user: 'alice', secret: 'composite-g3-2026', derivationStrategies: [billStatusStrategy()] })
    const v = await db.openVault('firm')
    expect(() => v.collection('bills', { schema: z.object({ id: z.string(), clientId: z.string(), cycle: z.string() }) }))
      .not.toThrow()
    await db.close()
  })
  it('throws for a typo on the TRIGGER side when that collection is schema-d', async () => {
    const { z } = await import('zod')
    const db = await createNoydb({
      store: toMemory(), user: 'alice', secret: 'composite-g4-2026',
      derivationStrategies: [withDerivation<Bill, { self: Bill }>({
        source: 'bills', deterministic: true, lifecycle: 'eager',
        triggerBy: [{ collection: 'disbursements', match: [{ from: 'clientIdd', to: 'clientId' }] }],  // typo'd from
        outputs: { self: { shape: 'record', collection: 'bills', denorm: ['status'] } },
        derive: (b) => ({ self: b }),
      })],
    })
    const v = await db.openVault('firm')
    expect(() => v.collection('disbursements', { schema: z.object({ id: z.string(), clientId: z.string(), cycle: z.string(), amount: z.number() }) }))
      .toThrow(ValidationError)
    await db.close()
  })
  it('a match field declared only via lookupFields does not false-positive (Imp 1)', async () => {
    const { z } = await import('zod')
    const db = await createNoydb({
      store: toMemory(), user: 'alice', secret: 'composite-g5-2026',
      derivationStrategies: [withDerivation<Bill, { self: Bill }>({
        source: 'bills', deterministic: true, lifecycle: 'eager',
        triggerBy: [{ collection: 'disbursements', match: [{ from: 'clientId', to: 'clientTag' }] }],
        outputs: { self: { shape: 'record', collection: 'bills', denorm: ['status'] } },
        derive: (b) => ({ self: b }),
      })],
    })
    const v = await db.openVault('firm')
    // 'clientTag' is absent from the schema but declared via lookupFields — must not throw.
    expect(() => v.collection('bills', {
      schema: z.object({ id: z.string(), clientId: z.string(), cycle: z.string() }),
      lookupFields: { clientTag: dict('clientTag') },
    })).not.toThrow()
    await db.close()
  })
})

describe('remaining spec §11 rows (#1249)', () => {
  it('on-form and its normalized match-form produce identical fan-out', async () => {
    // Mirrors trigger-by.test.ts's buyerNameDenorm fixture, run once per
    // triggerBy form. match:[{from:'id',to:'buyerId'}] is exactly what
    // normalizeTriggerBy() turns on:'buyerId' into (trigger-match.test.ts,
    // "normalizes the on-form to match [{from:'id'}]") — so this drives
    // BOTH forms through identical writes and checks they land on the
    // exact same final values, i.e. the sugar changes nothing observable.
    interface Buyer3 extends Record<string, unknown> { id: string; companyName: string }
    interface Sale3 extends Record<string, unknown> { id: string; buyerId: string; buyerName?: string | null }
    const makeStrategy = (form: 'on' | 'match') => withDerivation<Sale3, { self: Sale3 }>({
      source: 'sales',
      deterministic: true,
      triggerBy: form === 'on'
        ? [{ collection: 'buyers', on: 'buyerId' }]
        : [{ collection: 'buyers', match: [{ from: 'id', to: 'buyerId' }] }],
      outputs: { self: { shape: 'record', collection: 'sales', denorm: ['buyerName'] } },
      derive: async (sale, ctx) => {
        const b = await ctx.vault.collection<Buyer3>('buyers').get(sale.buyerId)
        return { self: { ...sale, buyerName: b?.companyName ?? null } as Sale3 }
      },
      lifecycle: 'eager',
    })
    async function run(form: 'on' | 'match') {
      const db = await createNoydb({
        store: toMemory(), user: 'alice', secret: `composite-sugar-${form}-2026`,
        derivationStrategies: [makeStrategy(form)],
      })
      const v = await db.openVault('firm')
      const buyers = v.collection<Buyer3>('buyers')
      const sales = v.collection<Sale3>('sales')
      await buyers.put('b1', { id: 'b1', companyName: 'Acme' })
      await buyers.put('b2', { id: 'b2', companyName: 'Globex' })
      await sales.put('s1', { id: 's1', buyerId: 'b1' })
      await sales.put('s2', { id: 's2', buyerId: 'b1' })
      await sales.put('s3', { id: 's3', buyerId: 'b2' })
      await buyers.put('b1', { id: 'b1', companyName: 'Acme Corp' }) // fan out to s1, s2 only
      const result = {
        s1: (await sales.get('s1'))?.buyerName,
        s2: (await sales.get('s2'))?.buyerName,
        s3: (await sales.get('s3'))?.buyerName,
      }
      await db.close()
      return result
    }
    const onResult = await run('on')
    const matchResult = await run('match')
    expect(onResult).toEqual({ s1: 'Acme Corp', s2: 'Acme Corp', s3: 'Globex' })
    expect(matchResult).toEqual(onResult)
  })

  it('lazy lifecycle marks the SAME set stale as eager fires', async () => {
    // Copies lazy.test.ts's read pattern: a vi.fn() spy on `derive`, whose
    // call COUNT (not a return value) is the observable. lazy.test.ts's own
    // "does NOT derive on source write" + "derives on first read of the
    // stale output" pair establishes that `derive` only runs for an id
    // that was actually marked stale — a read of a NEVER-stale id is a
    // no-op short-circuit in resolveStaleOnRead() (stale.ts) that never
    // calls `derive` at all. So reading b1/b2/b3 after the disbursement
    // write and checking which of the three calls reached `derive` IS a
    // direct read of the stale set — it can only show {b1} if the
    // composite match fan-out marked exactly b1 (not b2/b3) stale.
    const derive = vi.fn(async (bill: Bill, ctx: DerivationContext) => {
      const all = await ctx.vault.collection<Disbursement>('disbursements').query()
        .where('clientId', '==', bill.clientId).where('cycle', '==', bill.cycle).toArray()
      const covered = all.reduce((s, d) => s + d.amount, 0) > 0
      return { self: { ...bill, status: covered ? 'covered' : 'uncovered' } as Bill }
    })
    const strategy = withDerivation<Bill, { self: Bill }>({
      source: 'bills',
      deterministic: true,
      triggerBy: [{ collection: 'disbursements', match: [{ from: 'clientId', to: 'clientId' }, { from: 'cycle', to: 'cycle' }] }],
      outputs: { self: { shape: 'record', collection: 'bills', denorm: ['status'] } },
      derive,
      lifecycle: 'lazy',
    })
    const db = await createNoydb({
      store: toMemory(), user: 'alice', secret: 'composite-lazy-2026',
      derivationStrategies: [strategy],
    })
    const v = await db.openVault('firm')
    const bills = v.collection<Bill>('bills')
    const disb = v.collection<Disbursement>('disbursements')
    await bills.put('b1', { id: 'b1', clientId: 'c1', cycle: 'Q1' })
    await bills.put('b2', { id: 'b2', clientId: 'c1', cycle: 'Q2' })
    await bills.put('b3', { id: 'b3', clientId: 'c2', cycle: 'Q1' })
    expect(derive).not.toHaveBeenCalled()   // lazy: no derive on source write (lazy.test.ts's first assertion)
    // Each bill's OWN put is itself an `isSource` dispatch (dispatch.ts) and
    // under lazy mode that ALSO marks the bill stale against its own id —
    // same as lazy.test.ts's "derives on first read of the stale output".
    // Read all three now to consume that self-put baseline stale flag
    // before touching the trigger collection, so any stale flag observed
    // AFTER the disbursement write can only have come from the fan-out.
    await bills.get('b1')
    await bills.get('b2')
    await bills.get('b3')
    expect(derive).toHaveBeenCalledTimes(3)
    derive.mockClear()
    await disb.put('d1', { id: 'd1', clientId: 'c1', cycle: 'Q1', amount: 500 })
    expect(derive).not.toHaveBeenCalled()   // lazy: marking stale on the trigger write is not a derive call either
    await bills.get('b2')
    await bills.get('b3')
    expect(derive).not.toHaveBeenCalled()   // b2/b3 were NOT re-marked stale by the fan-out — no-op reads
    await bills.get('b1')
    expect(derive).toHaveBeenCalledTimes(1) // b1 — and only b1 — was re-marked stale by the fan-out
    await db.close()
  })

  it('cycle detection fires through a match entry', async () => {
    // Mirrors cycle.test.ts's "refuses A -> B -> A" fixture shape and its
    // asserted error class. There, BOTH edges into the cycle come from a
    // strategy's plain `source` label. Here, B's back-edge into 'a' comes
    // SOLELY from a triggerBy match entry: B's own `source` is 'x' (not
    // 'b'), and registry.edges() (#1249) folds `triggerBy[].collection`
    // into the same `sources` list as `source` when building the
    // derivation graph. So this can only detect the cycle if a match-form
    // triggerBy collection is wired into that graph — an implementation
    // that only walked `spec.source`/`spec.sources` (ignoring triggerBy)
    // would see no edge from 'b' into anything and openVault() would
    // resolve, not reject.
    const a = withDerivation({
      source: 'a',
      deterministic: true,
      outputs: { o: { shape: 'record', collection: 'b' } },
      derive: () => ({ o: {} }),
      lifecycle: 'eager',
    })
    const b = withDerivation({
      source: 'x',
      deterministic: true,
      triggerBy: [{ collection: 'b', match: [{ from: 'f', to: 'f' }] }],
      outputs: { o: { shape: 'record', collection: 'a' } },
      derive: () => ({ o: {} }),
      lifecycle: 'eager',
    })
    const db = await createNoydb({
      store: toMemory(), user: 'alice', secret: 'composite-cycle-2026',
      derivationStrategies: [a, b],
    })
    await expect(db.openVault('demo')).rejects.toBeInstanceOf(DerivationCycleError)
  })

  it('scalar coercion: number written value matches string source value', async () => {
    // Isolates the FAN-OUT MATCH itself (trigger-match.ts's String(x)===String(y)
    // conjunction), not any downstream query — a vi.fn() spy, same idiom as the
    // lazy test above, so the only thing that can make derive fire a SECOND
    // time is the composite match itself accepting a number written value
    // against a string source value.
    const derive = vi.fn((bill: Bill) => ({ self: { ...bill, status: 'touched' } as Bill }))
    const strategy = withDerivation<Bill, { self: Bill }>({
      source: 'bills',
      deterministic: true,
      triggerBy: [{ collection: 'disbursements', match: [{ from: 'clientId', to: 'clientId' }, { from: 'cycle', to: 'cycle' }] }],
      outputs: { self: { shape: 'record', collection: 'bills', denorm: ['status'] } },
      derive,
      lifecycle: 'eager',
    })
    const db = await createNoydb({
      store: toMemory(), user: 'alice', secret: 'composite-coerce-2026',
      derivationStrategies: [strategy],
    })
    const v = await db.openVault('firm')
    const bills = v.collection<Bill>('bills')
    const disb = v.collection<Disbursement>('disbursements')
    await bills.put('b1', { id: 'b1', clientId: 'c1', cycle: '2026' })      // cycle: STRING
    expect(derive).toHaveBeenCalled()   // b1's own isSource put (self-write settles after 1-2 calls; see lazy test note)
    derive.mockClear()
    await disb.put('d1', { id: 'd1', clientId: 'c1', cycle: 2026, amount: 500 } as unknown as Disbursement) // cycle: NUMBER (deliberate type mismatch)
    expect(derive).toHaveBeenCalled()   // re-fired via the composite match, despite the type mismatch
    await db.close()
  })
})

describe('stale-flag restore on throw (#1249 review Imp 3)', () => {
  it('a lazy re-derive whose output is malformed leaves the record STILL STALE — a subsequent read retries', async () => {
    // A required record-shape output returning undefined makes
    // DerivationExecutor.run() throw DerivationOutputShapeError DIRECTLY —
    // not via the 'failed'-kind branch resolveStaleOnRead's strict check
    // already guarded. Exercises the general throw path (stale.ts).
    const derive = vi.fn(() => ({ self: undefined }) as unknown as { self: Bill })
    const strategy = withDerivation<Bill, { self: Bill }>({
      source: 'bills',
      deterministic: true,
      lifecycle: 'lazy',
      outputs: { self: { shape: 'record', collection: 'bills', denorm: ['status'] } },
      derive,
    })
    const db = await createNoydb({ store: toMemory(), user: 'alice', secret: 'composite-stale-throw-2026', derivationStrategies: [strategy] })
    const v = await db.openVault('firm')
    const bills = v.collection<Bill>('bills')
    await bills.put('b1', { id: 'b1', clientId: 'c1', cycle: 'Q1' })   // marks b1 stale (lazy self-write)
    await expect(bills.get('b1')).rejects.toThrow(DerivationOutputShapeError)
    const callsAfterFirst = derive.mock.calls.length
    // If the stale flag was lost on the throw, this second read would be a
    // no-op short-circuit (derive not called again) instead of a retry.
    await expect(bills.get('b1')).rejects.toThrow(DerivationOutputShapeError)
    expect(derive.mock.calls.length).toBeGreaterThan(callsAfterFirst)
    await db.close()
  })
})

describe('index-hydration hardening (#1249 review Imp 4)', () => {
  it('a trigger fan-out matches a source record whose collection was never touched (and so never hydrated) this session', async () => {
    const store = toMemory()
    {
      const seed = await createNoydb({ store, user: 'alice', secret: 'composite-hydrate-2026' })
      const sv = await seed.openVault('firm')
      await sv.collection<Bill>('bills', { indexes: ['clientId'] }).put('b1', { id: 'b1', clientId: 'c1', cycle: 'Q1' })
      await seed.close()
    }
    const db = await createNoydb({ store, user: 'alice', secret: 'composite-hydrate-2026', derivationStrategies: [billStatusStrategy()] })
    const v = await db.openVault('firm')
    // Declare 'bills' (with its index) but never call get()/put() on it —
    // the fan-out below must hydrate it itself before probing the index.
    v.collection<Bill>('bills', { indexes: ['clientId'] })
    await v.collection<Disbursement>('disbursements').put('d1', { id: 'd1', clientId: 'c1', cycle: 'Q1', amount: 500 })
    expect((await v.collection<Bill>('bills').get('b1'))?.status).toBe('covered')
    await db.close()
  })
})

/**
 * #1266 (pilot) — a `match` target that names a VIRTUAL-mode computed field was
 * accepted at registration and then matched nothing, forever: `configKeys`
 * includes every `computed` entry regardless of mode, but a virtual field is
 * computed on the READ path and never exists on the stored record the matcher
 * reads. The guard's own stated failure mode, reached THROUGH the guard.
 *
 * Rejected rather than made to work: matching a virtual field means running
 * user code per candidate row, turning an indexed narrow into a scan.
 * `mode: 'materialized'` is stored and already works, so the error points there.
 *
 * Both sides are checked. The report covers `to` (the source side); `from` has
 * the identical defect, because the written record handed to the dispatcher is
 * the stored shape too.
 */
describe('composite triggerBy — virtual computed match targets (#1266)', () => {
  const virtualCell = (rec: Record<string, unknown>) => `${String(rec['clientId'])}:${String(rec['cycle'])}`

  it('REJECTS a `to` naming a virtual computed field, and names materialized', async () => {
    const db = await createNoydb({
      store: toMemory(), user: 'alice', secret: 'virtual-to-2026',
      derivationStrategies: [withDerivation<Bill, { self: Bill }>({
        source: 'bills', deterministic: true, lifecycle: 'eager',
        triggerBy: [{ collection: 'disbursements', match: [{ from: 'cell', to: 'cell' }] }],
        outputs: { self: { shape: 'record', collection: 'bills', denorm: ['status'] } },
        derive: async (b: Bill) => ({ self: b }),
      })],
    })
    const v = await db.openVault('firm')
    expect(() => v.collection<Bill>('bills', {
      computed: { cell: { fn: virtualCell, mode: 'virtual' } },
    } as never)).toThrow(/virtual/i)
    await db.close()
  })

  it('REJECTS a `from` naming a virtual computed field on the written collection', async () => {
    const db = await createNoydb({
      store: toMemory(), user: 'alice', secret: 'virtual-from-2026',
      derivationStrategies: [withDerivation<Bill, { self: Bill }>({
        source: 'bills', deterministic: true, lifecycle: 'eager',
        triggerBy: [{ collection: 'disbursements', match: [{ from: 'cell', to: 'clientId' }] }],
        outputs: { self: { shape: 'record', collection: 'bills', denorm: ['status'] } },
        derive: async (b: Bill) => ({ self: b }),
      })],
    })
    const v = await db.openVault('firm')
    expect(() => v.collection<Disbursement>('disbursements', {
      computed: { cell: { fn: virtualCell, mode: 'virtual' } },
    } as never)).toThrow(/virtual/i)
    await db.close()
  })

  it('ACCEPTS a via()-declared MATERIALIZED field — the guard must not over-fire (#1266)', async () => {
    // Second defect found while fixing the first: `viaFields` was missing from
    // the guard's key set entirely, so a via()-declared field read as an
    // undeclared typo and was REJECTED. A guard that refuses valid configs is
    // how people learn to stop trusting it, so both directions ship together.
    const db = await createNoydb({
      store: toMemory(), user: 'alice', secret: 'via-materialized-2026',
      derivationStrategies: [withDerivation<Bill, { self: Bill }>({
        source: 'bills', deterministic: true, lifecycle: 'eager',
        triggerBy: [{ collection: 'disbursements', match: [{ from: 'cell', to: 'cell' }] }],
        outputs: { self: { shape: 'record', collection: 'bills', denorm: ['status'] } },
        derive: async (b: Bill) => ({ self: b }),
      })],
    })
    const v = await db.openVault('firm')
    expect(() => v.collection<Bill>('bills', {
      schema: z.object({ id: z.string(), clientId: z.string(), cycle: z.string() }),
      viaFields: { cell: via(computed(virtualCell, { mode: 'materialized' })) },
    } as never)).not.toThrow()
    await db.close()
  })

  it('ACCEPTS a materialized computed field as a match target — the control', async () => {
    const db = await createNoydb({
      store: toMemory(), user: 'alice', secret: 'materialized-2026',
      derivationStrategies: [withDerivation<Bill, { self: Bill }>({
        source: 'bills', deterministic: true, lifecycle: 'eager',
        triggerBy: [{ collection: 'disbursements', match: [{ from: 'cell', to: 'cell' }] }],
        outputs: { self: { shape: 'record', collection: 'bills', denorm: ['status'] } },
        derive: async (b: Bill) => ({ self: b }),
      })],
    })
    const v = await db.openVault('firm')
    expect(() => v.collection<Bill>('bills', {
      computed: { cell: { fn: virtualCell, mode: 'materialized' } },
    } as never)).not.toThrow()
    await db.close()
  })
})

/**
 * #1277 — one declared hop, and the intermediate write that makes it honest.
 *
 * Topology: bills carry `entityId`, disbursements carry `clientId`, and the
 * CLIENT record relates them. The two collections share no field, so a direct
 * `match` cannot express the relationship at all.
 *
 *   client C1 { id: 'C1', entityId: 'E1' }          <- INTERMEDIATE
 *   bill   B1 { id: 'B1', entityId: 'E1', cycle }   <- SOURCE
 *   disb   D1 { clientId: 'C1', cycle }             <- TRIGGER
 *
 * The second test is the reason option 2 was chosen over the cheaper option 1:
 * re-pointing the client writes to NEITHER the trigger nor the source
 * collection, so nothing else in the system can notice. Under option 1 that
 * test fails silently — the bill keeps a status computed for a client
 * relationship that no longer exists.
 */
describe('composite triggerBy — one declared hop (#1277)', () => {
  interface Client extends Record<string, unknown> { id: string; entityId: string }

  const hopStrategy = (extra: { maxFanout?: number } = {}) =>
    withDerivation<Bill, { self: Bill }>({
      source: 'bills',
      deterministic: true,
      lifecycle: 'eager',
      triggerBy: [{
        collection: 'disbursements',
        match: [
          { from: 'clientId', to: 'entityId', via: { collection: 'clients', take: 'id', on: 'entityId' } },
          { from: 'cycle', to: 'cycle' },
        ],
        ...(extra.maxFanout !== undefined ? { maxFanout: extra.maxFanout } : {}),
      }],
      outputs: { self: { shape: 'record', collection: 'bills', denorm: ['status'] } },
      derive: async (bill, ctx) => {
        // Resolve this bill's client through the same hop, then look for cover.
        const clients = await ctx.vault.collection<Client>('clients').query()
          .where('entityId', '==', bill.entityId).toArray()
        const client = clients[0]
        if (!client) return { self: { ...bill, status: 'no-client' } }
        const disb = await ctx.vault.collection<Disbursement>('disbursements').query()
          .where('clientId', '==', client.id).where('cycle', '==', bill.cycle).toArray()
        return { self: { ...bill, status: disb.length > 0 ? 'covered' : 'uncovered' } }
      },
    })

  async function setup(secret: string, extra: { maxFanout?: number } = {}) {
    const db = await createNoydb({
      store: toMemory(), user: 'alice', secret,
      derivationStrategies: [hopStrategy(extra)],
    })
    const v = await db.openVault('firm')
    const clients = v.collection<Client>('clients')
    const bills = v.collection<Bill>('bills')
    const disb = v.collection<Disbursement>('disbursements')
    await clients.put('C1', { id: 'C1', entityId: 'E1' })
    await bills.put('B1', { id: 'B1', clientId: '', cycle: 'Q1', entityId: 'E1' } as never)
    return { db, v, clients, bills, disb }
  }
  const statusOf = async (bills: { get: (id: string) => Promise<Bill | null> }, id: string) =>
    (await bills.get(id))?.status

  it('EDIT A — a disbursement write reaches the bill THROUGH the client', async () => {
    const { db, bills, disb } = await setup('hop-edit-a-2026')
    expect(await statusOf(bills, 'B1')).not.toBe('covered')
    await disb.put('D1', { id: 'D1', clientId: 'C1', cycle: 'Q1', amount: 100 })
    expect(await statusOf(bills, 'B1')).toBe('covered')
    await db.close()
  })

  it('EDIT B — RE-POINTING THE CLIENT refreshes the bills it used to address', async () => {
    // The test option 1 would fail. Nothing is written to bills or
    // disbursements here; only the intermediate moves.
    const { db, v, clients, bills, disb } = await setup('hop-edit-b-2026')
    await v.collection<Bill>('bills').put('B2', { id: 'B2', clientId: '', cycle: 'Q1', entityId: 'E2' } as never)
    await disb.put('D1', { id: 'D1', clientId: 'C1', cycle: 'Q1', amount: 100 })
    expect(await statusOf(bills, 'B1')).toBe('covered')     // E1 bill covered via C1
    expect(await statusOf(bills, 'B2')).not.toBe('covered') // E2 bill not

    // The engagement is corrected: C1 actually covers entity E2.
    await clients.put('C1', { id: 'C1', entityId: 'E2' })

    expect(await statusOf(bills, 'B2')).toBe('covered')      // now addressed by C1
    // 'no-client', not 'uncovered': with C1 moved to E2, entity E1 has no
    // client at all. That distinction is what proves B1 was RE-DERIVED against
    // the new world rather than merely left alone — a stranded B1 would still
    // read 'covered'.
    expect(await statusOf(bills, 'B1')).toBe('no-client')
    await db.close()
  })

  it('EDIT C — DELETING a disbursement through the hop re-fires the bill (#1294)', async () => {
    // Reported by a consumer adopting the hop: puts through a hop fired,
    // deletes did not, while deletes through a plain pair did. The delete path
    // used the UNHOPPED tuple, so a mapped pair compared a clientId against an
    // entityId — the wrong side of the relationship — and matched nothing.
    const { db, bills, disb } = await setup('hop-delete-2026')
    await disb.put('D1', { id: 'D1', clientId: 'C1', cycle: 'Q1', amount: 100 })
    expect(await statusOf(bills, 'B1')).toBe('covered')
    await disb.delete('D1')
    expect(await statusOf(bills, 'B1')).toBe('uncovered')
    await db.close()
  })

  it('EDIT D — DELETING the intermediate re-fires the bills it addressed (#1294)', async () => {
    // Same class as the re-point: nothing is written to bills or disbursements
    // when a client is deleted, so no other path can notice.
    const { db, v, bills, disb } = await setup('hop-delete-intermediate-2026')
    await disb.put('D1', { id: 'D1', clientId: 'C1', cycle: 'Q1', amount: 100 })
    expect(await statusOf(bills, 'B1')).toBe('covered')
    await v.collection<Client>('clients').delete('C1')
    expect(await statusOf(bills, 'B1')).toBe('no-client')
    await db.close()
  })

  it('a dangling hop matches nothing rather than throwing', async () => {
    const { db, bills, disb } = await setup('hop-dangling-2026')
    await disb.put('D9', { id: 'D9', clientId: 'NO-SUCH-CLIENT', cycle: 'Q1', amount: 1 })
    expect(await statusOf(bills, 'B1')).not.toBe('covered')
    await db.close()
  })

  it('maxFanout caps the hop fan-out', async () => {
    const { db, v, disb } = await setup('hop-cap-2026', { maxFanout: 1 })
    await v.collection<Bill>('bills').put('B2', { id: 'B2', clientId: '', cycle: 'Q1', entityId: 'E1' } as never)
    await expect(
      disb.put('D1', { id: 'D1', clientId: 'C1', cycle: 'Q1', amount: 100 }),
    ).rejects.toThrow(DerivationCapExceededError)
    await db.close()
  })
})
