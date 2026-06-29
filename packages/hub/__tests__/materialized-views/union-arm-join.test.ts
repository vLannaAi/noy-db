import { describe, it, expect } from 'vitest'
import { createNoydb, withMaterializedView, ref } from '../../src/index.js'
import { sum } from '../../src/aggregate/reducers.js'
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
        const [vname, cname, id] = key.split('/') as [string, string, string]
        if (vname === v) { out[cname] = out[cname] ?? {}; out[cname][id] = env }
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

interface Client extends Record<string, unknown> { id: string; region: string }
interface Bill extends Record<string, unknown> { id: string; clientId: string; n: number }
interface RegionRow extends Record<string, unknown> { region: string; n: number }

describe('UNION MV — per-arm join (#347 / AU+031)', () => {
  it('resolves an arm FK to a parent and reads it via sourceRow[as] in map', async () => {
    const byRegion = withMaterializedView<RegionRow>({
      name: 'byRegion',
      sources: ['clients'], // right-side of the join, for dependency tracking
      unionSources: [
        {
          collection: 'bills',
          join: [{ field: 'clientId', as: 'client' }],
          map: r => {
            const client = r.client as Client | null
            if (!client) return null
            return { region: client.region, n: r.n as number }
          },
        },
      ],
      groupBy: 'region',
      aggregate: { n: sum('n') },
      rowKey: row => row.region,
      refresh: 'eager',
    })

    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'mv-union-armjoin-basic-passphrase-2026',
      materializedViewStrategies: [byRegion],
      aggregateStrategy: withAggregate(),
    })
    const vault = await db.openVault('books')
    vault.collection<Client>('clients')
    vault.collection<Bill>('bills', { refs: { clientId: ref('clients') } })

    const clients = vault.collection<Client>('clients')
    const bills = vault.collection<Bill>('bills')

    await clients.put('c1', { id: 'c1', region: 'north' })
    await clients.put('c2', { id: 'c2', region: 'south' })
    await bills.put('b1', { id: 'b1', clientId: 'c1', n: 10 })
    await bills.put('b2', { id: 'b2', clientId: 'c1', n: 5 })
    await bills.put('b3', { id: 'b3', clientId: 'c2', n: 7 })

    const out = vault.collection<RegionRow>('byRegion')
    expect((await out.get('north'))?.n).toBe(15)
    expect((await out.get('south'))?.n).toBe(7)
  })

  it('refreshes when a right-side (join target) collection is written', async () => {
    const byRegion = withMaterializedView<RegionRow>({
      name: 'byRegion',
      sources: ['clients'],
      unionSources: [
        {
          collection: 'bills',
          join: [{ field: 'clientId', as: 'client' }],
          map: r => {
            const client = r.client as Client | null
            if (!client) return null
            return { region: client.region, n: r.n as number }
          },
        },
      ],
      groupBy: 'region',
      aggregate: { n: sum('n') },
      rowKey: row => row.region,
      refresh: 'eager',
    })

    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'mv-union-armjoin-rhs-refresh-passphrase-2026',
      materializedViewStrategies: [byRegion],
      aggregateStrategy: withAggregate(),
    })
    const vault = await db.openVault('books')
    vault.collection<Client>('clients')
    vault.collection<Bill>('bills', { refs: { clientId: ref('clients', 'warn') } })

    const clients = vault.collection<Client>('clients')
    const bills = vault.collection<Bill>('bills')

    // Bill written first; client not yet present → dangling, omitted by map.
    await clients.put('c1', { id: 'c1', region: 'north' })
    await bills.put('b1', { id: 'b1', clientId: 'c1', n: 10 })
    expect((await vault.collection<RegionRow>('byRegion').get('north'))?.n).toBe(10)

    // Reassign the client's region — a write to the RIGHT side. The MV
    // must refresh because `sources: ['clients']` registers the dependency.
    await clients.put('c1', { id: 'c1', region: 'west' })
    const out = vault.collection<RegionRow>('byRegion')
    expect(await out.get('north')).toBeNull()
    expect((await out.get('west'))?.n).toBe(10)
  })

  it('dangling ref (no matching parent, warn mode) → row omitted', async () => {
    const byRegion = withMaterializedView<RegionRow>({
      name: 'byRegion',
      sources: ['clients'],
      unionSources: [
        {
          collection: 'bills',
          join: [{ field: 'clientId', as: 'client' }],
          map: r => {
            const client = r.client as Client | null
            if (!client) return null
            return { region: client.region, n: r.n as number }
          },
        },
      ],
      groupBy: 'region',
      aggregate: { n: sum('n') },
      rowKey: row => row.region,
      refresh: 'eager',
    })

    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'mv-union-armjoin-dangling-passphrase-2026',
      materializedViewStrategies: [byRegion],
      aggregateStrategy: withAggregate(),
    })
    const vault = await db.openVault('books')
    vault.collection<Client>('clients')
    // warn mode so the dangling ref attaches null instead of throwing.
    vault.collection<Bill>('bills', { refs: { clientId: ref('clients', 'warn') } })

    const clients = vault.collection<Client>('clients')
    const bills = vault.collection<Bill>('bills')

    await clients.put('c1', { id: 'c1', region: 'north' })
    await bills.put('b1', { id: 'b1', clientId: 'c1', n: 10 })
    await bills.put('b2', { id: 'b2', clientId: 'ghost', n: 99 }) // dangling

    const out = vault.collection<RegionRow>('byRegion')
    // ghost bill is omitted by map (client === null) → only north counts.
    expect((await out.get('north'))?.n).toBe(10)
    expect(await out.list()).toHaveLength(1)
  })

  it('arm join WITHOUT sources throws a config error', () => {
    expect(() =>
      withMaterializedView<RegionRow>({
        name: 'no-sources',
        // sources omitted
        unionSources: [
          {
            collection: 'bills',
            join: [{ field: 'clientId', as: 'client' }],
            map: r => {
              const client = r.client as Client | null
              return client ? { region: client.region, n: r.n as number } : null
            },
          },
        ],
        groupBy: 'region',
        aggregate: { n: sum('n') },
        rowKey: row => row.region,
        refresh: 'eager',
      }),
    ).toThrow(/sources/)
  })

  it('multi-arm union with one joined arm and one plain arm', async () => {
    interface Direct extends Record<string, unknown> { id: string; region: string; n: number }
    const byRegion = withMaterializedView<RegionRow>({
      name: 'byRegionMixed',
      sources: ['clients'],
      unionSources: [
        {
          collection: 'bills',
          join: [{ field: 'clientId', as: 'client' }],
          map: r => {
            const client = r.client as Client | null
            return client ? { region: client.region, n: r.n as number } : null
          },
        },
        {
          collection: 'directs',
          // no join — region is already on the row
          map: r => ({ region: r.region as string, n: r.n as number }),
        },
      ],
      groupBy: 'region',
      aggregate: { n: sum('n') },
      rowKey: row => row.region,
      refresh: 'eager',
    })

    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'mv-union-armjoin-mixed-passphrase-2026',
      materializedViewStrategies: [byRegion],
      aggregateStrategy: withAggregate(),
    })
    const vault = await db.openVault('books')
    vault.collection<Client>('clients')
    vault.collection<Bill>('bills', { refs: { clientId: ref('clients') } })
    vault.collection<Direct>('directs')

    const clients = vault.collection<Client>('clients')
    const bills = vault.collection<Bill>('bills')
    const directs = vault.collection<Direct>('directs')

    await clients.put('c1', { id: 'c1', region: 'north' })
    await bills.put('b1', { id: 'b1', clientId: 'c1', n: 10 })
    await directs.put('d1', { id: 'd1', region: 'north', n: 3 })
    await directs.put('d2', { id: 'd2', region: 'south', n: 8 })

    const out = vault.collection<RegionRow>('byRegionMixed')
    expect((await out.get('north'))?.n).toBe(13) // joined 10 + direct 3
    expect((await out.get('south'))?.n).toBe(8)
  })

  it('adding a join leg changes summarizeUnionPlan (queryHash sensitivity)', async () => {
    const noJoin = withMaterializedView<RegionRow>({
      name: 'h',
      sources: ['clients'],
      unionSources: [
        { collection: 'bills', map: (r: Record<string, unknown>) => ({ region: r.region as string, n: r.n as number }) },
      ],
      groupBy: 'region',
      aggregate: { n: sum('n') },
      rowKey: row => row.region,
      refresh: 'eager',
    })
    const withJoin = withMaterializedView<RegionRow>({
      name: 'h',
      sources: ['clients'],
      unionSources: [
        {
          collection: 'bills',
          join: [{ field: 'clientId', as: 'client' }],
          map: (r: Record<string, unknown>) => {
            const client = r.client as Client | null
            return client ? { region: client.region, n: r.n as number } : null
          },
        },
      ],
      groupBy: 'region',
      aggregate: { n: sum('n') },
      rowKey: row => row.region,
      refresh: 'eager',
    })

    const { summarizeUnionPlan } = await import('../../src/materialized-views/dependency-analyzer.js')
    const planNoJoin = summarizeUnionPlan(noJoin.spec)
    const planWithJoin = summarizeUnionPlan(withJoin.spec)
    expect(planNoJoin).not.toBe(planWithJoin)
    expect(planWithJoin).toContain('clientId→client')
  })
})
