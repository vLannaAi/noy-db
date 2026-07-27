import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { createNoydb, withMaterializedView } from '../../src/index.js'
import { withReduce } from '../../src/with-lookup/reduce/index.js'
import { moneySum } from '../../src/with-lookup/reduce/reducers.js'
import { money } from '../../src/via/money/descriptor.js'
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

interface Line extends Record<string, unknown> { id: string; total: number | string }
interface Rollup extends Record<string, unknown> { total: string }

describe('money in materialized views + live aggregation (the saleRollups scenario)', () => {
  it('eager MV over a money sum: string aggregate survives MV storage + recomputes exactly on source delete', async () => {
    // The literal saleRollups shape: money → sum → MV, refreshed on put/delete.
    const rollup = withMaterializedView<Rollup>({
      name: 'sale-rollups',
      sources: ['lines'],
      query: (db) => db.collection<Line>('lines').query().aggregate({ total: moneySum('total') }),
      rowKey: () => 'grand-total',
      refresh: 'eager',
    })
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'money-mv-secret-2026-pilot3-rollups',
      reduceStrategy: withReduce(),
      materializedViewStrategies: [rollup],
    })
    const vault = await db.openVault('books')
    vault.collection<Line>('lines', {
      schema: z.object({ id: z.string(), total: z.union([z.number(), z.string()]) }),
      moneyFields: { total: money({ currency: 'EUR', scale: 2 }) },
    })
    const lines = vault.collection<Line>('lines')

    await lines.put('a', { id: 'a', total: '0.10' })
    await lines.put('b', { id: 'b', total: '0.20' })
    await lines.put('c', { id: 'c', total: '0.30' })

    // MV row holds the exact decimal string (not a corrupted number).
    let row = await vault.collection<Rollup>('sale-rollups').get('grand-total')
    expect(row?.total).toBe('0.60')

    // Source delete → eager MV recomputes exactly (the #305 path, now with money).
    await lines.delete('b')
    row = await vault.collection<Rollup>('sale-rollups').get('grand-total')
    expect(row?.total).toBe('0.40')
  })

  it('.live() over a money sum: exact value, updates on put and delete', async () => {
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'money-live-secret-2026-pilot3',
      reduceStrategy: withReduce(),
    })
    const vault = await db.openVault('books')
    vault.collection<Line>('lines', {
      schema: z.object({ id: z.string(), total: z.union([z.number(), z.string()]) }),
      moneyFields: { total: money({ currency: 'EUR', scale: 2 }) },
    })
    const lines = vault.collection<Line>('lines')
    await lines.put('a', { id: 'a', total: '0.10' })
    await lines.put('b', { id: 'b', total: '0.20' })

    const live = lines.query().aggregate({ total: moneySum('total') }).live()
    // moneySum() types `total` as MoneyString (a string) — no cast needed.
    expect(live.value!.total).toBe('0.30')

    const seen: string[] = []
    live.subscribe(() => {
      const v = live.value
      if (v) seen.push(v.total)
    })

    await lines.put('c', { id: 'c', total: '0.30' })
    expect(live.value!.total).toBe('0.60')

    await lines.delete('a')
    expect(live.value!.total).toBe('0.50')

    expect(seen).toContain('0.60')
    expect(seen).toContain('0.50')
  })
})
