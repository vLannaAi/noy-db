/**
 * crossShardJoin — co-partitioned + broadcast dimension join.
 * Spec: docs/superpowers/specs/2026-06-09-cross-shard-join-design.md
 * Plan: docs/superpowers/plans/2026-06-09-cross-shard-join.md
 */
import { describe, it, expect } from 'vitest'
import { NoydbError, ConflictError } from '@noy-db/hub'
import { CrossShardJoinError } from '@noy-db/hub/kernel'
import {
  applyBroadcastLegs,
  resetBroadcastWarnings,
  type BroadcastLeg,
  type BroadcastSource,
} from '../src/federation/cross-shard-join.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '@noy-db/hub'
import { createNoydb } from '@noy-db/hub'
import type { Vault } from '@noy-db/hub'
import type { VaultRegistryRow } from '../src/federation/index.js'
import { ref } from '@noy-db/hub'
import { createLobby } from '../src/index.js'

// ─── In-memory adapter + harness (mirrors federation-query-aggregate.test.ts) ───

function memory(): NoydbStore {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function gc(c: string, col: string) {
    let comp = store.get(c); if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col); if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    name: 'memory',
    async get(c, col, id) { return store.get(c)?.get(col)?.get(id) ?? null },
    async put(c, col, id, env, ev) {
      const coll = gc(c, col); const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(c, col, id) { store.get(c)?.get(col)?.delete(id) },
    async list(c, col) { const coll = store.get(c)?.get(col); return coll ? [...coll.keys()] : [] },
    async loadAll(c) {
      const comp = store.get(c); const s: VaultSnapshot = {}
      if (comp) for (const [n, coll] of comp) {
        if (!n.startsWith('_')) {
          const r: Record<string, EncryptedEnvelope> = {}
          for (const [id, e] of coll) r[id] = e
          s[n] = r
        }
      }
      return s
    },
    async saveAll(c, data) {
      for (const [n, recs] of Object.entries(data)) {
        const coll = gc(c, n)
        for (const [id, e] of Object.entries(recs)) coll.set(id, e)
      }
    },
  }
}

interface Invoice { id: string; clientId: string; customerId: string; amount: number; status: string; currencyCode?: string }
interface Customer { id: string; name: string }

/** Operator db + a client template that registers customers + invoices(ref customers). */
async function harness() {
  const adapter = memory()
  const db = await createNoydb({ store: adapter, user: 'operator', secret: 'op-pass' })
  const lobby = createLobby(db)
  lobby.withVaultTemplate('client-template', {
    version: 1,
    configure(vault: Vault) {
      vault.collection<Customer>('customers')
      vault.collection<Invoice>('invoices', { refs: { customerId: ref('customers') } })
    },
  })
  const stateVault = await db.openVault('state')
  const registry = stateVault.collection<VaultRegistryRow>('vault-registry')
  const firm = await lobby.openVaultGroup<Invoice>('firm-clients', {
    registry,
    sharding: { keyOf: (r) => r.clientId, vaultTemplate: 'client-template' },
  })
  return { adapter, db, registry, firm }
}

describe('CrossShardJoinError', () => {
  it('is a NoydbError with the CROSS_SHARD_JOIN code', () => {
    const e = new CrossShardJoinError('nope')
    expect(e).toBeInstanceOf(NoydbError)
    expect(e.code).toBe('CROSS_SHARD_JOIN')
    expect(e.message).toBe('nope')
  })
})

function fakeSource(rows: Record<string, unknown>[]): BroadcastSource & { listCalls: number } {
  let listCalls = 0
  return {
    get listCalls() { return listCalls },
    async list() { listCalls++; return rows },
  } as BroadcastSource & { listCalls: number }
}

describe('applyBroadcastLegs', () => {
  it('attaches the matching dimension record by default on:id', async () => {
    const src = fakeSource([{ id: 'usd', symbol: '$' }, { id: 'eur', symbol: '€' }])
    const leg: BroadcastLeg = { field: 'currencyCode', as: 'fx', from: src, on: 'id', mode: 'warn' }
    const out = await applyBroadcastLegs(
      [{ id: 'i1', currencyCode: 'usd' }, { id: 'i2', currencyCode: 'eur' }],
      [leg],
    )
    expect((out[0] as Record<string, unknown>).fx).toEqual({ id: 'usd', symbol: '$' })
    expect((out[1] as Record<string, unknown>).fx).toEqual({ id: 'eur', symbol: '€' })
  })

  it('matches on a custom key', async () => {
    const src = fakeSource([{ code: 'usd', symbol: '$' }])
    const leg: BroadcastLeg = { field: 'currencyCode', as: 'fx', from: src, on: 'code', mode: 'warn' }
    const out = await applyBroadcastLegs([{ id: 'i1', currencyCode: 'usd' }], [leg])
    expect((out[0] as Record<string, unknown>).fx).toEqual({ code: 'usd', symbol: '$' })
  })

  it('attaches null on a miss', async () => {
    const src = fakeSource([{ id: 'usd' }])
    const leg: BroadcastLeg = { field: 'currencyCode', as: 'fx', from: src, on: 'id', mode: 'cascade' }
    const out = await applyBroadcastLegs([{ id: 'i1', currencyCode: 'gbp' }], [leg])
    expect((out[0] as Record<string, unknown>).fx).toBeNull()
  })

  it('loads the source exactly once regardless of row count', async () => {
    const src = fakeSource([{ id: 'usd' }])
    const leg: BroadcastLeg = { field: 'currencyCode', as: 'fx', from: src, on: 'id', mode: 'cascade' }
    await applyBroadcastLegs(
      Array.from({ length: 50 }, (_, i) => ({ id: `i${i}`, currencyCode: 'usd' })),
      [leg],
    )
    expect(src.listCalls).toBe(1)
  })

  it('applies multiple legs independently', async () => {
    const fx = fakeSource([{ id: 'usd', symbol: '$' }])
    const adv = fakeSource([{ id: 'a1', name: 'Dana' }])
    const out = await applyBroadcastLegs(
      [{ id: 'i1', currencyCode: 'usd', advisorId: 'a1' }],
      [
        { field: 'currencyCode', as: 'fx', from: fx, on: 'id', mode: 'cascade' },
        { field: 'advisorId', as: 'advisor', from: adv, on: 'id', mode: 'cascade' },
      ],
    )
    expect((out[0] as Record<string, unknown>).fx).toEqual({ id: 'usd', symbol: '$' })
    expect((out[0] as Record<string, unknown>).advisor).toEqual({ id: 'a1', name: 'Dana' })
  })

  it('returns rows unchanged when there are no legs', async () => {
    resetBroadcastWarnings()
    const rows = [{ id: 'i1' }]
    const out = await applyBroadcastLegs(rows, [])
    expect(out).toEqual(rows)
  })
})

describe('crossShardJoin (co-partitioned)', () => {
  it('joins each shard against its same-vault right collection and unions', async () => {
    const { firm } = await harness()
    // strict refs enforce integrity at write time → seed the customer (in its
    // shard) BEFORE the invoice that references it.
    const acme = await firm.createShard('acme')
    await acme.collection<Customer>('customers').put('c-acme', { id: 'c-acme', name: 'Acme Co' })
    await firm.collection('invoices').put('i1', { id: 'i1', clientId: 'acme', customerId: 'c-acme', amount: 100, status: 'overdue' })

    const globex = await firm.createShard('globex')
    await globex.collection<Customer>('customers').put('c-glx', { id: 'c-glx', name: 'Globex' })
    await firm.collection('invoices').put('i2', { id: 'i2', clientId: 'globex', customerId: 'c-glx', amount: 200, status: 'overdue' })

    const res = await firm.collection('invoices').query()
      .where('status', '==', 'overdue')
      .crossShardJoin('customerId', { as: 'customer' })
      .toArray()

    expect(res.skippedVaults).toEqual([])
    const byId = Object.fromEntries(res.results.map((r) => [(r as Invoice).id, r])) as Record<string, Record<string, unknown>>
    expect((byId['i1'].customer as Customer).name).toBe('Acme Co')
    expect((byId['i2'].customer as Customer).name).toBe('Globex')
  })
})

describe('broadcastJoin (dimension)', () => {
  it('enriches every merged row from a single shared dimension collection', async () => {
    resetBroadcastWarnings()
    const { db, firm } = await harness()
    const dims = await db.openVault('dimensions')
    const currencies = dims.collection<{ id: string; symbol: string }>('currencies')
    await currencies.put('usd', { id: 'usd', symbol: '$' })
    await currencies.put('eur', { id: 'eur', symbol: '€' })

    // No customer ref here — invoices use a warn-free standalone shard write.
    const acme = await firm.createShard('acme')
    await acme.collection<Customer>('customers').put('c1', { id: 'c1', name: 'A' })
    await firm.collection('invoices').put('i1', { id: 'i1', clientId: 'acme', customerId: 'c1', amount: 100, status: 'paid', currencyCode: 'usd' })
    const glx = await firm.createShard('globex')
    await glx.collection<Customer>('customers').put('c2', { id: 'c2', name: 'G' })
    await firm.collection('invoices').put('i2', { id: 'i2', clientId: 'globex', customerId: 'c2', amount: 200, status: 'paid', currencyCode: 'eur' })

    const res = await firm.collection('invoices').query()
      .broadcastJoin('currencyCode', { as: 'fx', from: currencies })
      .toArray()

    const byId = Object.fromEntries(res.results.map((r) => [(r as Invoice).id, r])) as Record<string, Record<string, unknown>>
    expect((byId['i1'].fx as { symbol: string }).symbol).toBe('$')
    expect((byId['i2'].fx as { symbol: string }).symbol).toBe('€')
  })

  it('combines a co-partitioned join and a broadcast join', async () => {
    resetBroadcastWarnings()
    const { db, firm } = await harness()
    const dims = await db.openVault('dimensions')
    const currencies = dims.collection<{ id: string; symbol: string }>('currencies')
    await currencies.put('usd', { id: 'usd', symbol: '$' })

    const acme = await firm.createShard('acme')
    await acme.collection<Customer>('customers').put('c-acme', { id: 'c-acme', name: 'Acme Co' })
    await firm.collection('invoices').put('i1', { id: 'i1', clientId: 'acme', customerId: 'c-acme', amount: 100, status: 'overdue', currencyCode: 'usd' })

    const res = await firm.collection('invoices').query()
      .crossShardJoin('customerId', { as: 'customer' })
      .broadcastJoin('currencyCode', { as: 'fx', from: currencies })
      .toArray()

    const row = res.results[0] as Record<string, unknown>
    expect((row.customer as Customer).name).toBe('Acme Co')
    expect((row.fx as { symbol: string }).symbol).toBe('$')
  })
})

describe('crossShardJoin failure semantics', () => {
  it('throws a single CrossShardJoinError when the join field has no ref()', async () => {
    const { firm } = await harness()
    const acme = await firm.createShard('acme')
    await acme.collection<Customer>('customers').put('c1', { id: 'c1', name: 'A' })
    await firm.collection('invoices').put('i1', { id: 'i1', clientId: 'acme', customerId: 'c1', amount: 1, status: 'open' })
    await expect(
      firm.collection('invoices').query().crossShardJoin('amount', { as: 'x' }).toArray(),
    ).rejects.toBeInstanceOf(CrossShardJoinError)
  })

  it('attaches null for a dangling ref in warn mode (per-shard RefMode)', async () => {
    const adapter = memory()
    const db = await createNoydb({ store: adapter, user: 'operator', secret: 'op-pass' })
    const lobby = createLobby(db)
    lobby.withVaultTemplate('warn-template', {
      version: 1,
      configure(vault: Vault) {
        vault.collection<Customer>('customers')
        vault.collection<Invoice>('invoices', { refs: { customerId: ref('customers', 'warn') } })
      },
    })
    const sv = await db.openVault('state')
    const registry = sv.collection<VaultRegistryRow>('vault-registry')
    const firm = await lobby.openVaultGroup<Invoice>('warn-firm', {
      registry,
      sharding: { keyOf: (r) => r.clientId, vaultTemplate: 'warn-template' },
    })
    await firm.collection('invoices').put('i1', { id: 'i1', clientId: 'acme', customerId: 'ghost', amount: 1, status: 'open' })

    const res = await firm.collection('invoices').query()
      .crossShardJoin('customerId', { as: 'customer' })
      .toArray()
    expect(res.results).toHaveLength(1)
    expect((res.results[0] as Record<string, unknown>).customer).toBeNull()
  })
})

describe('broadcastJoin miss', () => {
  it('attaches null on a miss without throwing', async () => {
    resetBroadcastWarnings()
    const { db, firm } = await harness()
    const dims = await db.openVault('dimensions')
    const currencies = dims.collection<{ id: string }>('currencies')
    await currencies.put('usd', { id: 'usd' })
    const acme = await firm.createShard('acme')
    await acme.collection<Customer>('customers').put('c1', { id: 'c1', name: 'A' })
    await firm.collection('invoices').put('i1', { id: 'i1', clientId: 'acme', customerId: 'c1', amount: 1, status: 'paid', currencyCode: 'gbp' })

    const res = await firm.collection('invoices').query()
      .broadcastJoin('currencyCode', { as: 'fx', from: currencies, mode: 'cascade' })
      .toArray()
    expect((res.results[0] as Record<string, unknown>).fx).toBeNull()
  })
})

describe('deferred surfaces throw when join legs are present', () => {
  it('live() throws CrossShardJoinError with a co-partitioned leg', async () => {
    const { firm } = await harness()
    expect(() =>
      firm.collection('invoices').query().crossShardJoin('customerId', { as: 'c' }).live(),
    ).toThrow(CrossShardJoinError)
  })

  it('aggregate() throws CrossShardJoinError with a broadcast leg', async () => {
    const { db, firm } = await harness()
    const dims = await db.openVault('dimensions')
    const cur = dims.collection<{ id: string }>('currencies')
    expect(() =>
      firm.collection('invoices').query().broadcastJoin('currencyCode', { as: 'fx', from: cur }).aggregate({ total: 'count' } as never),
    ).toThrow(CrossShardJoinError)
  })

  it('groupBy() throws CrossShardJoinError with a join leg', async () => {
    const { firm } = await harness()
    expect(() =>
      firm.collection('invoices').query().crossShardJoin('customerId', { as: 'c' }).groupBy('status'),
    ).toThrow(CrossShardJoinError)
  })
})
