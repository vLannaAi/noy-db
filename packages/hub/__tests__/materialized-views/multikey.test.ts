import { describe, it, expect } from 'vitest'
import { createNoydb, withMaterializedView, sum, GroupedAggregation } from '../../src/index.js'
import { withAggregate } from '../../src/aggregate/index.js'
import type { NoydbStore, EncryptedEnvelope } from '../../src/types.js'

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

interface Compensation extends Record<string, unknown> {
  id: string
  clientId: string
  period: string
  taxAmount: number
}

interface Pnd1Row extends Record<string, unknown> {
  clientId: string
  period: string
  total: number
}

describe('withMaterializedView — multi-key groupBy inside query() (#166)', () => {
  it('refreshes a per-(clientId, period) MV when source rows are added', async () => {
    // Aggregate-shape MV — query() returns a GroupedAggregation. The
    // dependency analyzer cannot walk through groupBy().aggregate()
    // back to the source, so `sources` is declared explicitly per the
    // CLAUDE.md note.
    const pnd1Auto = withMaterializedView<Pnd1Row>({
      name: 'pnd1Auto',
      query: db =>
        db.collection<Compensation>('compensations')
          .query()
          .groupBy('clientId', 'period')
          .aggregate({ total: sum('taxAmount') }) as GroupedAggregation<Pnd1Row>,
      sources: ['compensations'],
      rowKey: row => `${row.clientId}|${row.period}`,
      refresh: 'eager',
    })

    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'mv-multikey-groupby-passphrase-2026',
      materializedViewStrategies: [pnd1Auto],
      aggregateStrategy: withAggregate(),
    })
    const vault = await db.openVault('demo')

    const comps = vault.collection<Compensation>('compensations')
    await comps.put('c-1', { id: 'c-1', clientId: 'c1', period: '2026-05', taxAmount: 100 })
    await comps.put('c-2', { id: 'c-2', clientId: 'c1', period: '2026-05', taxAmount: 50 })
    await comps.put('c-3', { id: 'c-3', clientId: 'c2', period: '2026-05', taxAmount: 200 })

    // Read out of the MV output collection (defaults to MV name).
    const out = vault.collection<Pnd1Row & { _materializedFrom?: unknown }>('pnd1Auto')
    const c1May = await out.get('c1|2026-05')
    const c2May = await out.get('c2|2026-05')

    expect(c1May).not.toBeNull()
    expect(c1May?.clientId).toBe('c1')
    expect(c1May?.period).toBe('2026-05')
    expect(c1May?.total).toBe(150)

    expect(c2May).not.toBeNull()
    expect(c2May?.clientId).toBe('c2')
    expect(c2May?.period).toBe('2026-05')
    expect(c2May?.total).toBe(200)
  })
})
