import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { createNoydb, money, ValidationError } from '../../src/index.js'
import { quantizeMoneyFields, decodeMoneyFields } from '../../src/via/money/normalize.js'
import { money as moneyFactory } from '../../src/via/money/descriptor.js'
import type { NoydbStore, EncryptedEnvelope } from '../../src/kernel/types.js'

// #334 — nested-path money declarations. The descriptor key is a path:
// 'lineItems[].amount', 'billing.monthlyServiceFee', 'summary.*'.
// Registration validates syntax loudly; the write walk throws on shape
// mismatch (an un-quantized amount must never reach storage); the read
// walk is lenient (legacy data stays readable).

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

const THB = () => moneyFactory({ currency: 'THB', scale: 2 })

describe('nested money paths — pure quantize/decode (#334)', () => {
  it('array element members: lineItems[].amount', () => {
    const mf = { 'lineItems[].amount': THB() }
    const stored = quantizeMoneyFields(
      { id: 'b1', lineItems: [{ desc: 'a', amount: 100.5 }, { desc: 'b', amount: '99.99' }] },
      mf,
    )
    expect(stored.lineItems).toEqual([
      { desc: 'a', amount: '10050' },
      { desc: 'b', amount: '9999' },
    ])
    const read = decodeMoneyFields(stored, mf, 'raw')
    expect(read.lineItems).toEqual([
      { desc: 'a', amount: '100.50' },
      { desc: 'b', amount: '99.99' },
    ])
  })

  it('nested object members: billing.monthlyServiceFee', () => {
    const mf = { 'billing.monthlyServiceFee': THB() }
    const stored = quantizeMoneyFields(
      { id: 'c1', billing: { plan: 'pro', monthlyServiceFee: 1500 } },
      mf,
    )
    expect(stored.billing).toEqual({ plan: 'pro', monthlyServiceFee: '150000' })
    const read = decodeMoneyFields(stored, mf, 'raw')
    expect((read.billing as Record<string, unknown>).monthlyServiceFee).toBe('1500.00')
  })

  it('record/map wildcards: summary.*', () => {
    const mf = { 'summary.*': THB() }
    const stored = quantizeMoneyFields(
      { id: 'f1', summary: { advance: 1000, reimbursed: '250.25', pending: 0 } },
      mf,
    )
    expect(stored.summary).toEqual({ advance: '100000', reimbursed: '25025', pending: '0' })
    const read = decodeMoneyFields(stored, mf, 'raw')
    expect(read.summary).toEqual({ advance: '1000.00', reimbursed: '250.25', pending: '0.00' })
  })

  it('deep composition: income[].taxWithheld alongside a top-level field', () => {
    const mf = { total: THB(), 'income[].taxWithheld': THB() }
    const stored = quantizeMoneyFields(
      { id: 'cert1', total: 500, income: [{ type: 'svc', taxWithheld: 15 }, { type: 'rent', taxWithheld: '7.50' }] },
      mf,
    )
    expect(stored.total).toBe('50000')
    expect(stored.income).toEqual([
      { type: 'svc', taxWithheld: '1500' },
      { type: 'rent', taxWithheld: '750' },
    ])
  })

  it('formatted virtuals land as siblings inside the nested container', () => {
    const mf = { 'lineItems[].amount': THB() }
    const stored = quantizeMoneyFields({ id: 'b1', lineItems: [{ amount: 100.5 }] }, mf)
    const read = decodeMoneyFields(stored, mf, 'th-TH') as Record<string, unknown>
    const item = (read.lineItems as Array<Record<string, unknown>>)[0]!
    expect(item.amount).toBe('100.50')
    expect(String(item.amountFormatted)).toContain('100.50')
    expect(item.amountNumber).toBe(100.5)
  })

  it('missing optional containers and null leaves are not an error', () => {
    const mf = { 'billing.monthlyServiceFee': THB(), 'lineItems[].amount': THB() }
    const r = { id: 'x', billing: null, note: 'no lineItems at all' }
    expect(quantizeMoneyFields(r, mf)).toEqual(r)
    expect(decodeMoneyFields(r, mf, 'raw')).toEqual(r)
  })

  it('quantize throws LOUDLY on a shape mismatch (declared [] over a non-array)', () => {
    const mf = { 'lineItems[].amount': THB() }
    expect(() => quantizeMoneyFields({ id: 'b', lineItems: { amount: 1 } }, mf)).toThrow(ValidationError)
  })

  it('decode is lenient on shape mismatch — legacy data stays readable', () => {
    const mf = { 'lineItems[].amount': THB() }
    const legacy = { id: 'b', lineItems: 'not-an-array-anymore' }
    expect(decodeMoneyFields(legacy, mf, 'raw')).toEqual(legacy)
  })

  it('does not mutate the input (copy-on-write along the path)', () => {
    const mf = { 'lineItems[].amount': THB() }
    const input = { id: 'b1', lineItems: [{ amount: 100.5 }] }
    const snapshot = structuredClone(input)
    quantizeMoneyFields(input, mf)
    expect(input).toEqual(snapshot)
  })
})

describe('nested money paths — registration validation (#334)', () => {
  async function open() {
    const db = await createNoydb({
      store: memory(), user: 'alice',
      secret: 'money-nested-registration-secret-2026',
    })
    return db.openVault('books')
  }

  it('a syntactically invalid path throws at collection registration', async () => {
    const vault = await open()
    expect(() =>
      vault.collection('bills', {
        moneyFields: { 'lineItems[]..amount': THB() },
      }),
    ).toThrow(ValidationError)
    expect(() =>
      vault.collection('bills2', {
        moneyFields: { 'a[0].amount': THB() }, // indexed access is not path syntax
      }),
    ).toThrow(ValidationError)
  })

  it('valid nested declarations register fine', async () => {
    const vault = await open()
    expect(() =>
      vault.collection('bills', {
        moneyFields: {
          'lineItems[].amount': THB(),
          'billing.monthlyServiceFee': THB(),
          'summary.*': THB(),
        },
      }),
    ).not.toThrow()
  })
})

describe('nested money paths — end-to-end through encryption (#334)', () => {
  it('round-trips a bill with nested money through put/get', async () => {
    const db = await createNoydb({
      store: memory(), user: 'alice',
      secret: 'money-nested-e2e-secret-2026',
    })
    const vault = await db.openVault('books')
    const col = vault.collection<Record<string, unknown>>('bills', {
      schema: z.object({
        id: z.string(),
        client: z.object({
          name: z.string(),
          billing: z.object({ monthlyServiceFee: z.union([z.number(), z.string()]) }),
        }),
        lineItems: z.array(z.object({
          desc: z.string(),
          amount: z.union([z.number(), z.string()]),
        })),
      }),
      moneyFields: {
        'client.billing.monthlyServiceFee': THB(),
        'lineItems[].amount': THB(),
      },
    })

    await col.put('b1', {
      id: 'b1',
      client: { name: 'firm', billing: { monthlyServiceFee: 12000 } },
      lineItems: [
        { desc: 'bookkeeping', amount: 8000 },
        { desc: 'filing', amount: '4000.00' },
      ],
    })

    const read = await col.get('b1') as Record<string, unknown>
    const client = read.client as { billing: { monthlyServiceFee: unknown } }
    expect(client.billing.monthlyServiceFee).toBe('12000.00')
    expect((read.lineItems as Array<{ amount: unknown }>).map(li => li.amount))
      .toEqual(['8000.00', '4000.00'])
  })
})
