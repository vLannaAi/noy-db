/**
 * A UNION MV whose DECLARED group key is a `dateTrunc()` calendar bucket
 * (#1350) — the shape that replaces pre-materialising a `yearMonth` field in
 * each arm's `map`.
 *
 * The point of the timezone case here is that it is not decoration: the two
 * receipts sit either side of local midnight-on-the-first in Bangkok, so the
 * SAME rows produce a different monthly split from the UTC declaration.
 */
import { describe, it, expect } from 'vitest'
import { createNoydb, withMaterializedView } from '../../src/index.js'
import { sum, withReduce } from '../../src/with-lookup/reduce/index.js'
import { dateTrunc } from '../../src/kernel/query/reduce/index.js'
import type { NoydbStore, EncryptedEnvelope } from '../../src/kernel/types.js'

function toMemory(): NoydbStore {
  const data = new Map<string, EncryptedEnvelope>()
  const k = (v: string, c: string, i: string): string => `${v}/${c}/${i}`
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

interface Receipt extends Record<string, unknown> {
  id: string
  issuedAt: string
  vat: number
}

interface MonthlyRow extends Record<string, unknown> {
  issuedAt_month: string
  vat: number
}

const RECEIPTS: Receipt[] = [
  // 2026-08-31 21:00 UTC = 2026-09-01 04:00 in Bangkok (UTC+7).
  { id: 'r-1', issuedAt: '2026-08-31T21:00:00Z', vat: 100 },
  { id: 'r-2', issuedAt: '2026-09-10T09:00:00Z', vat: 50 },
]

async function monthlyRows(timeZone: string, mvName: string): Promise<MonthlyRow[]> {
  const mv = withMaterializedView<MonthlyRow>({
    name: mvName,
    unionSources: [{ collection: 'receipts', map: r => r as unknown as MonthlyRow }],
    groupBy: dateTrunc('issuedAt', 'month', { timeZone }),
    aggregate: { vat: sum('vat') },
    rowKey: row => row.issuedAt_month,
    refresh: 'eager',
  })
  const db = await createNoydb({
    store: toMemory(),
    user: 'alice',
    secret: 'mv-date-trunc-secret-2026',
    materializedViewStrategies: [mv],
    reduceStrategy: withReduce(),
  })
  const vault = await db.openVault('demo')
  const receipts = vault.collection<Receipt>('receipts')
  for (const r of RECEIPTS) await receipts.put(r.id, r)
  return vault.collection<MonthlyRow>(mvName).list()
}

describe('UNION MV — declared dateTrunc group key (#1350)', () => {
  it('buckets by calendar month without a pre-materialised period field', async () => {
    const rows = await monthlyRows('UTC', 'monthlyUtc')
    expect(rows.map(r => [r.issuedAt_month, r.vat]).sort()).toEqual([
      ['2026-08-01', 100],
      ['2026-09-01', 50],
    ])
  })

  it('splits the same rows differently in a different timezone', async () => {
    const rows = await monthlyRows('Asia/Bangkok', 'monthlyBkk')
    expect(rows.map(r => [r.issuedAt_month, r.vat])).toEqual([['2026-09-01', 150]])
  })
})
