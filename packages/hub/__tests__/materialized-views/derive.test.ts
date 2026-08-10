/**
 * #1007 — post-aggregate `derive` on materialized-view rows.
 *
 * `aggregate` accepts reducers only, so a row could carry every input a
 * derived value needs and still not express it. `max(0, netTotal - paid)` is
 * not a reduction, so the last step had to happen in a consumer — leaving the
 * rule half in the store and half out, which is the split an MV exists to
 * remove.
 *
 * `derive` is deliberately the narrow version: ONE pure function over ONE
 * finished row, no cross-row access, no second aggregation pass. It runs after
 * grouping/aggregation and immediately before materialisation, so it composes
 * with incremental recompute for free — it only ever sees the row the reducer
 * just produced.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, withMaterializedView, money } from '../../src/index.js'
import { sum, withReduce } from '../../src/with-lookup/reduce/index.js'
import { MaterializedViewConfigError } from '../../src/kernel/errors.js'
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
      return [...data.keys()].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length))
    },
    async loadAll(v) {
      const out: Record<string, Record<string, EncryptedEnvelope>> = {}
      for (const [key, env] of data) {
        const [vname, cname, id] = key.split('/')
        if (vname === v && cname !== undefined && id !== undefined) {
          out[cname] = out[cname] ?? {}
          out[cname]![id] = env
        }
      }
      return out
    },
    async saveAll(v, payload) {
      for (const c of Object.keys(payload)) {
        for (const i of Object.keys(payload[c]!)) data.set(k(v, c, i), payload[c]![i]!)
      }
    },
  }
}

interface BalanceRow extends Record<string, unknown> {
  billId: string
  netTotal: number
  paid: number
  toPay?: unknown
}

/** The reporter's shape: a bill's own total plus three payment-ish sources, grouped by bill. */
function billBalanceMV(derive?: (row: BalanceRow) => Record<string, unknown> | null | undefined) {
  return withMaterializedView<BalanceRow>({
    name: 'billBalance',
    unionSources: [
      { collection: 'bills', map: (r) => ({ billId: r.id as string, netTotal: r.total as number, paid: 0 }) },
      { collection: 'receipts', map: (r) => ({ billId: r.billId as string, netTotal: 0, paid: r.amount as number }) },
      { collection: 'creditNotes', map: (r) => ({ billId: r.billId as string, netTotal: 0, paid: -(r.amount as number) }) },
    ],
    groupBy: ['billId'],
    aggregate: { netTotal: sum('netTotal'), paid: sum('paid') },
    ...(derive ? { derive } : {}),
    rowKey: (row) => row.billId,
    refresh: 'eager',
  })
}

async function openVault(strategies: unknown[]) {
  const db = await createNoydb({
    store: toMemory(),
    user: 'alice',
    secret: 'mv-derive-secret-2026',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    materializedViewStrategies: strategies as any,
    reduceStrategy: withReduce(),
  })
  return db.openVault('demo')
}

describe('#1007 — MV post-aggregate derive', () => {
  it('computes a derived field from two aggregated operands on the same row', async () => {
    const vault = await openVault([
      billBalanceMV((row) => ({ toPay: Math.max(0, row.netTotal - row.paid) })),
    ])
    await vault.collection('bills').put('b1', { id: 'b1', total: 1000 })
    await vault.collection('receipts').put('r1', { id: 'r1', billId: 'b1', amount: 300 })
    await vault.collection('receipts').put('r2', { id: 'r2', billId: 'b1', amount: 200 })

    const row = await vault.collection<BalanceRow>('billBalance').get('b1')
    expect(row?.netTotal).toBe(1000)
    expect(row?.paid).toBe(500)
    expect(row?.toPay).toBe(500)
  })

  it('recomputes the derived field when a source row changes (composes with incremental refresh)', async () => {
    const vault = await openVault([
      billBalanceMV((row) => ({ toPay: Math.max(0, row.netTotal - row.paid) })),
    ])
    await vault.collection('bills').put('b1', { id: 'b1', total: 1000 })
    await vault.collection('receipts').put('r1', { id: 'r1', billId: 'b1', amount: 300 })
    expect((await vault.collection<BalanceRow>('billBalance').get('b1'))?.toPay).toBe(700)

    await vault.collection('receipts').put('r2', { id: 'r2', billId: 'b1', amount: 700 })
    expect((await vault.collection<BalanceRow>('billBalance').get('b1'))?.toPay).toBe(0)

    // A credit note contributes negatively — overpayment must still clamp at 0.
    await vault.collection('creditNotes').put('cn1', { id: 'cn1', billId: 'b1', amount: 400 })
    const row = await vault.collection<BalanceRow>('billBalance').get('b1')
    expect(row?.paid).toBe(600)
    expect(row?.toPay).toBe(400)
  })

  it('runs per row, independently, across groups', async () => {
    const vault = await openVault([
      billBalanceMV((row) => ({ toPay: Math.max(0, row.netTotal - row.paid) })),
    ])
    await vault.collection('bills').put('b1', { id: 'b1', total: 100 })
    await vault.collection('bills').put('b2', { id: 'b2', total: 250 })
    await vault.collection('receipts').put('r1', { id: 'r1', billId: 'b1', amount: 100 })

    expect((await vault.collection<BalanceRow>('billBalance').get('b1'))?.toPay).toBe(0)
    expect((await vault.collection<BalanceRow>('billBalance').get('b2'))?.toPay).toBe(250)
  })

  it('cannot overwrite a group key — that would break rowKey identity', async () => {
    const vault = await openVault([billBalanceMV((row) => ({ billId: `hijacked-${row.billId}` }))])
    await expect(
      vault.collection('bills').put('b1', { id: 'b1', total: 100 }),
    ).rejects.toBeInstanceOf(MaterializedViewConfigError)
  })

  it('a derive returning null or undefined leaves the row untouched', async () => {
    for (const ret of [null, undefined]) {
      const vault = await openVault([billBalanceMV(() => ret)])
      await vault.collection('bills').put('b1', { id: 'b1', total: 100 })
      const row = await vault.collection<BalanceRow>('billBalance').get('b1')
      expect(row?.netTotal).toBe(100)
      expect(row?.toPay).toBeUndefined()
    }
  })

  it('an MV with no derive is unchanged', async () => {
    const vault = await openVault([billBalanceMV()])
    await vault.collection('bills').put('b1', { id: 'b1', total: 100 })
    const row = await vault.collection<BalanceRow>('billBalance').get('b1')
    expect(row?.netTotal).toBe(100)
    expect('toPay' in (row ?? {})).toBe(false)
  })

  const THB = money({ currency: 'THB', scale: 2 })
  function moneyMV(derive: NonNullable<Parameters<typeof withMaterializedView<BalanceRow>>[0]['derive']>) {
    return withMaterializedView<BalanceRow>({
      name: 'billBalanceMoney',
      unionSources: [
        { collection: 'bills', map: (r) => ({ billId: r.id as string, netTotal: r.total as number, paid: 0 }) },
        { collection: 'receipts', map: (r) => ({ billId: r.billId as string, netTotal: 0, paid: r.amount as number }) },
      ],
      groupBy: ['billId'],
      aggregate: { netTotal: sum('netTotal'), paid: sum('paid') },
      moneyFields: { netTotal: THB, paid: THB, toPay: THB },
      derive,
      rowKey: (row) => row.billId,
      refresh: 'eager',
    })
  }

  it('presents declared money fields to derive in decoded decimal form, not the scaled integer', async () => {
    const seen: Record<string, unknown>[] = []
    const vault = await openVault([moneyMV((row) => { seen.push({ ...row }); return {} })])
    await vault.collection('bills').put('b1', { id: 'b1', total: 10.05 })
    await vault.collection('receipts').put('r1', { id: 'r1', billId: 'b1', amount: 0.1 })

    // `1005` where the schema says `10.05` would make every derived money
    // expression wrong by a factor of the scale.
    const last = seen[seen.length - 1]!
    expect(last.netTotal).toBe('10.05')
    expect(last.paid).toBe('0.10')
  })

  it('exact.sub keeps a derived money field exact — no float drift', async () => {
    const vault = await openVault([
      moneyMV((row, exact) => ({ toPay: exact.max(0, exact.sub(row.netTotal, row.paid)) })),
    ])
    await vault.collection('bills').put('b1', { id: 'b1', total: 10.05 })
    await vault.collection('receipts').put('r1', { id: 'r1', billId: 'b1', amount: 0.1 })

    const row = await vault.collection<BalanceRow>('billBalanceMoney').get('b1')
    expect(String(row?.toPay)).toBe('9.95')
  })

  /**
   * #1018 — the derived money field must ROUND-TRIP, not merely be non-zero.
   *
   * It was canonicalized into the scaled-integer STORAGE form while the
   * aggregated money fields beside it are decimal strings, so `toPay` read back
   * as `"1000000"` next to `netTotal: "10000.00"` — 100× the true value, in the
   * shape of a plausible amount. An assertion like "outstanding > 0" passes
   * against that; only an exact equality catches it.
   */
  it('a derived money field reads back in the SAME decimal shape as its aggregated siblings', async () => {
    const vault = await openVault([
      moneyMV((row, exact) => ({ toPay: exact.max(0, exact.sub(row.netTotal, row.paid)) })),
    ])
    await vault.collection('bills').put('b1', { id: 'b1', total: 10000 })

    const row = await vault.collection<BalanceRow>('billBalanceMoney').get('b1')
    expect(row?.netTotal).toBe('10000.00')
    expect(row?.paid).toBe('0.00')
    expect(row?.toPay).toBe('10000.00')
  })

  it('round-trips a partially-paid balance to the exact decimal', async () => {
    const vault = await openVault([
      moneyMV((row, exact) => ({ toPay: exact.max(0, exact.sub(row.netTotal, row.paid)) })),
    ])
    await vault.collection('bills').put('b1', { id: 'b1', total: 10000 })
    await vault.collection('receipts').put('r1', { id: 'r1', billId: 'b1', amount: 4000 })

    const row = await vault.collection<BalanceRow>('billBalanceMoney').get('b1')
    expect(row?.toPay).toBe('6000.00')
    // The reported symptom, stated as a guard: never the scaled integer.
    expect(row?.toPay).not.toBe('600000')
  })

  it('pads a derived value to the declared scale, matching the reducers', async () => {
    const vault = await openVault([moneyMV(() => ({ toPay: '7' }))])
    await vault.collection('bills').put('b1', { id: 'b1', total: 10 })
    expect((await vault.collection<BalanceRow>('billBalanceMoney').get('b1'))?.toPay).toBe('7.00')
  })

  it('float arithmetic in derive is REFUSED rather than silently storing drift', async () => {
    // This is why `exact` exists: Number('10.05') - Number('0.10') is
    // 9.950000000000001, which cannot be represented at scale 2. The quantiser
    // refuses it instead of rounding behind the caller's back.
    const vault = await openVault([
      moneyMV((row) => ({ toPay: Number(row.netTotal) - Number(row.paid) })),
    ])
    await vault.collection('bills').put('b1', { id: 'b1', total: 10.05 })
    await expect(
      vault.collection('receipts').put('r1', { id: 'r1', billId: 'b1', amount: 0.1 }),
    ).rejects.toThrow(/exceeds scale 2/)
  })
})
