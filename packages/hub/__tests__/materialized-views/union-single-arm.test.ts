import { describe, it, expect } from 'vitest'
import { createNoydb, withMaterializedView, sum, count } from '../../src/index.js'
import { withAggregate } from '../../src/with-lookup/aggregate/index.js'
import type { NoydbStore, EncryptedEnvelope } from '../../src/types.js'

// #331 — single-arm union: map→group→aggregate over ONE collection with a
// COMPUTED bucket key. The query form's .groupBy() accepts stored field
// names only; the union arm's `map` is where a derived key (month sliced
// from a date) gets computed. The executor was always arm-count-agnostic —
// only registration validation gated this shape.

function memory(): NoydbStore {
  const data = new Map<string, EncryptedEnvelope>()
  const k = (v: string, c: string, i: string) => `${v}/${c}/${i}`
  return {
    capabilities: { casAtomic: true, auth: { kind: 'none', required: false, flow: 'static' as const } },
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

interface Receipt extends Record<string, unknown> {
  id: string
  entityId: string
  issuedAt: string
  whtWithheldByPayer: number
}

interface WhtRow extends Record<string, unknown> {
  entityId: string
  period: string
  wht: number
  receipts: number
}

function whtByMonth() {
  return withMaterializedView<WhtRow>({
    name: 'whtByMonth',
    unionSources: [
      {
        collection: 'receipts',
        map: r => {
          const rec = r as unknown as Receipt
          return {
            entityId: rec.entityId,
            period: rec.issuedAt.slice(0, 7), // computed bucket key
            wht: rec.whtWithheldByPayer,
            receipts: 0,
          }
        },
      },
    ],
    groupBy: ['entityId', 'period'],
    aggregate: { wht: sum('wht'), receipts: count() },
    rowKey: row => `${row.entityId}/${row.period}`,
    refresh: 'eager',
  })
}

async function openWithMv() {
  const db = await createNoydb({
    store: memory(),
    user: 'alice',
    secret: 'mv-union-single-arm-passphrase-2026',
    materializedViewStrategies: [whtByMonth()],
    aggregateStrategy: withAggregate(),
  })
  const vault = await db.openVault('demo')
  return { db, vault, receipts: vault.collection<Receipt>('receipts') }
}

describe('UNION MV — single arm with computed bucket key (#331)', () => {
  it('aggregates one collection by (entityId, computed month)', async () => {
    const { vault, receipts } = await openWithMv()

    await receipts.put('r-1', { id: 'r-1', entityId: 'e1', issuedAt: '2026-05-15', whtWithheldByPayer: 300 })
    await receipts.put('r-2', { id: 'r-2', entityId: 'e1', issuedAt: '2026-05-20', whtWithheldByPayer: 200 })
    await receipts.put('r-3', { id: 'r-3', entityId: 'e1', issuedAt: '2026-06-01', whtWithheldByPayer: 100 })
    await receipts.put('r-4', { id: 'r-4', entityId: 'e2', issuedAt: '2026-05-31', whtWithheldByPayer: 50 })

    const out = vault.collection<WhtRow>('whtByMonth')
    const may1 = await out.get('e1/2026-05')
    expect(may1?.wht).toBe(500)
    expect(may1?.receipts).toBe(2)
    expect((await out.get('e1/2026-06'))?.wht).toBe(100)
    expect((await out.get('e2/2026-05'))?.wht).toBe(50)
  })

  it('eager refresh tracks update and delete of source records', async () => {
    const { vault, receipts } = await openWithMv()
    const out = vault.collection<WhtRow>('whtByMonth')

    await receipts.put('r-1', { id: 'r-1', entityId: 'e1', issuedAt: '2026-05-15', whtWithheldByPayer: 300 })
    await receipts.put('r-2', { id: 'r-2', entityId: 'e1', issuedAt: '2026-05-20', whtWithheldByPayer: 200 })
    expect((await out.get('e1/2026-05'))?.wht).toBe(500)

    // Move r-2 to June — May shrinks, June appears.
    await receipts.put('r-2', { id: 'r-2', entityId: 'e1', issuedAt: '2026-06-20', whtWithheldByPayer: 200 })
    expect((await out.get('e1/2026-05'))?.wht).toBe(300)
    expect((await out.get('e1/2026-06'))?.wht).toBe(200)

    await receipts.delete('r-1')
    const may = await out.get('e1/2026-05')
    // Bucket either drops to zero rows or reports a zero sum — both mean "gone".
    expect(may === null || may.wht === 0).toBe(true)
  })
})
