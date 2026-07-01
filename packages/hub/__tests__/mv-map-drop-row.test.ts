/**
 * #297 — UNION MV `map` returning null/undefined should drop the source
 * row from the output instead of pushing a null value downstream.
 *
 * Before the fix, `arm.map(r)` was pushed unconditionally into `unified`,
 * so a null return ended up in the groupBy/aggregate pipeline and either
 * threw (canonicalGroupKey reading fields off null) or produced a bad row.
 *
 * After the fix: `if (mapped == null) continue` — the row is silently
 * omitted and only genuinely mapped rows flow into the aggregate.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, withMaterializedView, sum } from '../src/index.js'
import { withAggregate } from '../src/with-lookup/aggregate/index.js'
import type { NoydbStore, EncryptedEnvelope } from '../src/kernel/types.js'

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
        if (vname === v && cname !== undefined && id !== undefined) {
          out[cname] = out[cname] ?? {}
          out[cname]![id] = env
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

interface InvoiceRow extends Record<string, unknown> {
  id: string
  clientId: string
  period: string
  amount: number
  /** 'posted' rows should be included; 'draft' rows should be dropped */
  status: 'posted' | 'draft'
}

interface MvRow extends Record<string, unknown> {
  clientId: string
  period: string
  total: number
}

describe('UNION MV map drop-row (#297)', () => {
  it('map returning null drops the source row — only posted rows appear in the output', async () => {
    const invoiceTotals = withMaterializedView<MvRow>({
      name: 'invoiceTotals',
      unionSources: [
        {
          collection: 'invoices',
          // Return null for drafts — they should be omitted from the MV.
          // This is the core type widening: (sourceRow) => MvRow | null
          map: (r): MvRow | null => {
            const inv = r as unknown as InvoiceRow
            if (inv.status === 'draft') return null
            return { clientId: inv.clientId, period: inv.period, total: inv.amount }
          },
        },
        {
          collection: 'adjustments',
          map: (r): MvRow | null => {
            const inv = r as unknown as InvoiceRow
            if (inv.status === 'draft') return null
            return { clientId: inv.clientId, period: inv.period, total: inv.amount }
          },
        },
      ],
      groupBy: ['clientId', 'period'],
      aggregate: { total: sum('total') },
      rowKey: row => `${row.clientId}|${row.period}`,
      refresh: 'eager',
    })

    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'mv-map-drop-row-passphrase-2026',
      materializedViewStrategies: [invoiceTotals],
      aggregateStrategy: withAggregate(),
    })
    const vault = await db.openVault('demo')

    const invoices = vault.collection<InvoiceRow>('invoices')
    const adjustments = vault.collection<InvoiceRow>('adjustments')

    // Posted — should appear in MV
    await invoices.put('inv-1', { id: 'inv-1', clientId: 'c1', period: '2026-05', amount: 100, status: 'posted' })
    await invoices.put('inv-2', { id: 'inv-2', clientId: 'c1', period: '2026-05', amount: 50,  status: 'posted' })
    // Draft — map returns null → must NOT appear in any output bucket
    await invoices.put('inv-3', { id: 'inv-3', clientId: 'c1', period: '2026-05', amount: 999, status: 'draft' })
    await invoices.put('inv-4', { id: 'inv-4', clientId: 'c2', period: '2026-05', amount: 888, status: 'draft' })
    // Posted in second arm — should appear
    await adjustments.put('adj-1', { id: 'adj-1', clientId: 'c1', period: '2026-05', amount: 20, status: 'posted' })
    // Draft in second arm — map returns null → must NOT appear
    await adjustments.put('adj-2', { id: 'adj-2', clientId: 'c2', period: '2026-05', amount: 777, status: 'draft' })

    const out = vault.collection<MvRow & { _materializedFrom?: unknown }>('invoiceTotals')
    const rows = await out.list()

    // Only c1|2026-05 should exist — c2 had only drafts in both arms,
    // so no posted rows means no bucket for c2.
    expect(rows).toHaveLength(1)

    const c1Row = await out.get('c1|2026-05')
    expect(c1Row).not.toBeNull()
    expect(c1Row?.clientId).toBe('c1')
    expect(c1Row?.period).toBe('2026-05')
    // 100 + 50 + 20 = 170; 999 and 888 and 777 (all draft) must not be included
    expect(c1Row?.total).toBe(170)

    // c2 had only drafts — no row should exist
    const c2Row = await out.get('c2|2026-05')
    expect(c2Row).toBeNull()
  })

  it('map returning undefined also drops the source row', async () => {
    const totals = withMaterializedView<MvRow>({
      name: 'totals',
      unionSources: [
        {
          collection: 'invoices',
          map: (r): MvRow | undefined => {
            const inv = r as unknown as InvoiceRow
            if (inv.status === 'draft') return undefined
            return { clientId: inv.clientId, period: inv.period, total: inv.amount }
          },
        },
        {
          collection: 'adjustments',
          map: (r): MvRow | undefined => {
            const inv = r as unknown as InvoiceRow
            if (inv.status === 'draft') return undefined
            return { clientId: inv.clientId, period: inv.period, total: inv.amount }
          },
        },
      ],
      groupBy: ['clientId', 'period'],
      aggregate: { total: sum('total') },
      rowKey: row => `${row.clientId}|${row.period}`,
      refresh: 'eager',
    })

    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'mv-map-drop-row-undef-passphrase-2026',
      materializedViewStrategies: [totals],
      aggregateStrategy: withAggregate(),
    })
    const vault = await db.openVault('demo')

    const invoices = vault.collection<InvoiceRow>('invoices')
    const adjustments = vault.collection<InvoiceRow>('adjustments')

    await invoices.put('inv-1', { id: 'inv-1', clientId: 'c1', period: '2026-05', amount: 200, status: 'posted' })
    await invoices.put('inv-2', { id: 'inv-2', clientId: 'c1', period: '2026-05', amount: 100, status: 'draft' })
    await adjustments.put('adj-1', { id: 'adj-1', clientId: 'c1', period: '2026-05', amount: 50, status: 'draft' })

    const out = vault.collection<MvRow & { _materializedFrom?: unknown }>('totals')
    const rows = await out.list()
    expect(rows).toHaveLength(1)

    const c1Row = await out.get('c1|2026-05')
    expect(c1Row).not.toBeNull()
    // Only the one posted invoice (200); the two drafts are dropped
    expect(c1Row?.total).toBe(200)
  })
})
