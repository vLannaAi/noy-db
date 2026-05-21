import { describe, it, expect } from 'vitest'
import { createNoydb, withMaterializedView, sum } from '../../src/index.js'
import { withAggregate } from '../../src/aggregate/index.js'
import type { NoydbStore, EncryptedEnvelope } from '../../src/types.js'

function memory(): NoydbStore {
  const data = new Map<string, EncryptedEnvelope>()
  const k = (v: string, c: string, i: string) => `${v}/${c}/${i}`
  return {
    capabilities: { casAtomic: true, auth: { kind: 'none' } },
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
          out[cname] = out[cname] ?? {}
          out[cname][id] = env
        }
      }
      return out
    },
    async saveAll(v, payload) {
      for (const c of Object.keys(payload)) {
        for (const i of Object.keys(payload[c])) {
          data.set(k(v, c, i), payload[c][i])
        }
      }
    },
  }
}

interface TaxReceipt extends Record<string, unknown> {
  id: string
  issuedAt: string
  paidServicesVat: number
}

interface CreditNote extends Record<string, unknown> {
  id: string
  issuedAt: string
  paidServicesVat: number
}

interface MonthlyVatRow extends Record<string, unknown> {
  period: string
  vat: number
}

interface ArmRowA extends Record<string, unknown> {
  id: string
  k: string
  n: number
}

interface ArmRowB extends Record<string, unknown> {
  id: string
  k: string
  n: number
}

interface TotalsRow extends Record<string, unknown> {
  k: string
  n: number
}

describe('UNION MV — basic 2-source (#165)', () => {
  it('reads from both arms, maps, groupBy, aggregate', async () => {
    const monthlyVat = withMaterializedView<MonthlyVatRow>({
      name: 'monthlyVat',
      unionSources: [
        {
          collection: 'taxReceipts',
          map: r => {
            const tr = r as unknown as TaxReceipt
            return { period: tr.issuedAt.slice(0, 7), vat: tr.paidServicesVat }
          },
        },
        {
          collection: 'creditNotes',
          map: r => {
            const cn = r as unknown as CreditNote
            return { period: cn.issuedAt.slice(0, 7), vat: -cn.paidServicesVat }
          },
        },
      ],
      groupBy: 'period',
      aggregate: { vat: sum('vat') },
      rowKey: row => row.period,
      refresh: 'eager',
    })

    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'mv-union-basic-passphrase-2026',
      materializedViewStrategies: [monthlyVat],
      aggregateStrategy: withAggregate(),
    })
    const vault = await db.openVault('demo')

    const receipts = vault.collection<TaxReceipt>('taxReceipts')
    const notes = vault.collection<CreditNote>('creditNotes')

    await receipts.put('r-1', { id: 'r-1', issuedAt: '2026-05-15', paidServicesVat: 100 })
    await receipts.put('r-2', { id: 'r-2', issuedAt: '2026-05-20', paidServicesVat: 50 })
    await notes.put('cn-1', { id: 'cn-1', issuedAt: '2026-05-25', paidServicesVat: 30 })

    const out = vault.collection<MonthlyVatRow & { _materializedFrom?: unknown }>('monthlyVat')
    const row = await out.get('2026-05')
    expect(row).not.toBeNull()
    expect(row?.period).toBe('2026-05')
    expect(row?.vat).toBe(120) // 100 + 50 - 30
  })

  it('refreshes on writes to either arm independently', async () => {
    const totals = withMaterializedView<TotalsRow>({
      name: 'totals',
      unionSources: [
        {
          collection: 'a',
          map: r => {
            const row = r as unknown as ArmRowA
            return { k: row.k, n: row.n }
          },
        },
        {
          collection: 'b',
          map: r => {
            const row = r as unknown as ArmRowB
            return { k: row.k, n: row.n }
          },
        },
      ],
      groupBy: 'k',
      aggregate: { n: sum('n') },
      rowKey: row => row.k,
      refresh: 'eager',
    })

    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'mv-union-arms-independent-passphrase-2026',
      materializedViewStrategies: [totals],
      aggregateStrategy: withAggregate(),
    })
    const vault = await db.openVault('demo')

    const a = vault.collection<ArmRowA>('a')
    const b = vault.collection<ArmRowB>('b')
    const out = vault.collection<TotalsRow & { _materializedFrom?: unknown }>('totals')

    // Write to arm A first.
    await a.put('a-1', { id: 'a-1', k: 'x', n: 10 })
    let row = await out.get('x')
    expect(row).not.toBeNull()
    expect(row?.n).toBe(10)

    // Write to arm B — MV must refresh from the B-arm write too.
    await b.put('b-1', { id: 'b-1', k: 'x', n: 5 })
    row = await out.get('x')
    expect(row).not.toBeNull()
    expect(row?.n).toBe(15)
  })
})
