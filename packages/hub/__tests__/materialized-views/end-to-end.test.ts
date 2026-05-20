import { describe, it, expect } from 'vitest'
import { createNoydb, withMaterializedView, MaterializedViewCycleError } from '../../src/index.js'
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

interface Invoice extends Record<string, unknown> {
  id: string
  clientId: string
  amount: number
  status: 'open' | 'paid'
}

describe('MV foundation (#150) — end-to-end', () => {
  it('eager MV: source writes trigger re-materialization with _materializedFrom stamp', async () => {
    // Foundation MV: non-aggregate query that filters invoices to
    // `status === 'open'` and writes them through to `open-invoices`.
    // The id is preserved from the source row.
    const openInvoicesMV = withMaterializedView<Invoice>({
      name: 'open-invoices',
      query: (db) => db.collection<Invoice>('invoices').query().where('status', '==', 'open'),
      rowKey: (r) => r.id,
      refresh: 'eager',
    })

    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'mv-foundation-eager-passphrase-2026',
      materializedViewStrategies: [openInvoicesMV],
    })
    const vault = await db.openVault('demo')

    // Seed two invoices; one open, one paid. MV should emit only the open one.
    await vault.collection<Invoice>('invoices').put('inv-1', {
      id: 'inv-1', clientId: 'acme', amount: 100, status: 'open',
    })
    await vault.collection<Invoice>('invoices').put('inv-2', {
      id: 'inv-2', clientId: 'acme', amount: 50, status: 'paid',
    })

    const openRow = await vault
      .collection<Invoice & { _materializedFrom?: { mvName: string; queryHash: string } }>('open-invoices')
      .get('inv-1')
    expect(openRow).not.toBeNull()
    expect(openRow?.amount).toBe(100)
    expect(openRow?._materializedFrom?.mvName).toBe('open-invoices')
    expect(openRow?._materializedFrom?.queryHash).toMatch(/^[0-9a-f]{64}$/)

    const paidRow = await vault.collection<Invoice>('open-invoices').get('inv-2')
    // Paid invoice was filtered out by the query — should not be in MV
    expect(paidRow).toBeNull()
  })

  it('MV output defaults to the collection named after `name`', async () => {
    interface Item extends Record<string, unknown> { id: string; x: number }
    const mv = withMaterializedView<Item>({
      name: 'big-items',
      query: (db) => db.collection<Item>('items').query().where('x', '>', 10),
      rowKey: (r) => r.id,
      refresh: 'eager',
      // No output.collection → writes to 'big-items'
    })
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'mv-foundation-default-output-passphrase-2026',
      materializedViewStrategies: [mv],
    })
    const vault = await db.openVault('demo')
    await vault.collection<Item>('items').put('a', { id: 'a', x: 5 })
    await vault.collection<Item>('items').put('b', { id: 'b', x: 20 })
    expect(await vault.collection<Item>('big-items').get('a')).toBeNull()
    expect(await vault.collection<Item>('big-items').get('b')).not.toBeNull()
  })

  it('cycle detection: MV whose output writes to its own source throws MaterializedViewCycleError', async () => {
    interface Loopy extends Record<string, unknown> { id: string; n: number }
    const cyclic = withMaterializedView<Loopy>({
      name: 'self-feedback',
      query: (db) => db.collection<Loopy>('self-feedback').query(),
      rowKey: (r) => String(r.id),
      refresh: 'eager',
      // No output.collection → defaults to 'self-feedback' (same as
      // root source) → cycle.
    })

    await expect(
      (async () => {
        const db = await createNoydb({
          store: memory(),
          user: 'alice',
          secret: 'mv-foundation-cycle-passphrase-2026',
          materializedViewStrategies: [cyclic],
        })
        await db.openVault('demo')
      })(),
    ).rejects.toBeInstanceOf(MaterializedViewCycleError)
  })

  it('explicit output collection routes correctly', async () => {
    interface Item extends Record<string, unknown> { id: string; tag: string }
    const mv = withMaterializedView<Item>({
      name: 'mv-redtags',
      query: (db) => db.collection<Item>('items').query().where('tag', '==', 'red'),
      rowKey: (r) => r.id,
      refresh: 'eager',
      output: { collection: 'red-items' },
    })
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'mv-foundation-explicit-output-passphrase-2026',
      materializedViewStrategies: [mv],
    })
    const vault = await db.openVault('demo')
    await vault.collection<Item>('items').put('a', { id: 'a', tag: 'red' })
    await vault.collection<Item>('items').put('b', { id: 'b', tag: 'blue' })

    // The MV writes to `red-items` (not to its name `mv-redtags`)
    expect(await vault.collection<Item>('red-items').get('a')).not.toBeNull()
    expect(await vault.collection<Item>('red-items').get('b')).toBeNull()
    // The `mv-redtags` name is just an identity; nothing written there
    expect(await vault.collection<Item>('mv-redtags').get('a')).toBeNull()
  })

  it('lazy and manual MV strategies register but do not eagerly materialize (foundation no-op)', async () => {
    interface Item extends Record<string, unknown> { id: string }
    const lazyMV = withMaterializedView<Item>({
      name: 'lazy-mv',
      query: (db) => db.collection<Item>('items').query(),
      rowKey: (r) => r.id,
      refresh: 'lazy',
    })
    const manualMV = withMaterializedView<Item>({
      name: 'manual-mv',
      query: (db) => db.collection<Item>('items').query(),
      rowKey: (r) => r.id,
      refresh: 'manual',
    })
    const db = await createNoydb({
      store: memory(),
      user: 'alice',
      secret: 'mv-foundation-lazy-manual-passphrase-2026',
      materializedViewStrategies: [lazyMV, manualMV],
    })
    const vault = await db.openVault('demo')
    await vault.collection<Item>('items').put('a', { id: 'a' })
    // Foundation: lazy + manual do not materialize. Subtask #151 wires
    // them. This test pins the no-op behavior so #151 has a clear
    // delta to write against.
    expect(await vault.collection<Item>('lazy-mv').get('a')).toBeNull()
    expect(await vault.collection<Item>('manual-mv').get('a')).toBeNull()
  })
})
