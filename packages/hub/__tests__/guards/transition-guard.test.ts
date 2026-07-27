import { describe, it, expect } from 'vitest'
import { createNoydb, IllegalTransitionError, ValidationError } from '../../src/index.js'
import { transitionGuard } from '../../src/with-audit/guards/transition-guard.js'
import { withTransactions } from '../../src/with-commit/tx/index.js'
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
        if (vname === v && cname && id) { out[cname] = out[cname] ?? {}; out[cname]![id] = env }
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

interface Sale extends Record<string, unknown> { id: string; status: string; total: number }

const SALE_TRANSITIONS = {
  draft: ['to_verify', 'cancelled'],
  to_verify: ['proforma', 'draft', 'cancelled'],
  proforma: ['invoiced', 'cancelled'],
  invoiced: ['paid'],
  paid: [],
  cancelled: [],
} as const

function saleGuard(extra: Partial<Parameters<typeof transitionGuard<Sale>>[0]> = {}) {
  return transitionGuard<Sale>({
    collection: 'sales',
    field: 'status',
    transitions: SALE_TRANSITIONS,
    initial: ['draft', 'to_verify'],
    ...extra,
  })
}

describe('transitionGuard — factory validation', () => {
  it('rejects a missing field', () => {
    expect(() =>
      transitionGuard<Sale>({ collection: 'sales', field: '' as 'status', transitions: SALE_TRANSITIONS }),
    ).toThrow(ValidationError)
  })
  it('rejects a missing transitions map', () => {
    expect(() =>
      transitionGuard<Sale>({ collection: 'sales', field: 'status', transitions: undefined as never }),
    ).toThrow(ValidationError)
  })
  it('produces a guard handle for the named collection with default amendment roles', () => {
    const h = saleGuard()
    expect(h.spec.collection).toBe('sales')
    expect(h.spec.amendment?.roles).toEqual(['admin', 'owner'])
  })
})

async function vaultWith(...guards: ReturnType<typeof saleGuard>[]) {
  const db = await createNoydb({
    store: memory(), user: 'alice', secret: 'transition-guard-secret-2026-pilot2',
    guardStrategies: guards, transactionsStrategy: withTransactions(),
  })
  const vault = await db.openVault('books')
  return { db, vault }
}

describe('transitionGuard — inserts (initial set)', () => {
  it('allows an insert whose status is in `initial`', async () => {
    const { vault } = await vaultWith(saleGuard())
    const sales = vault.collection<Sale>('sales')
    await sales.put('s1', { id: 's1', status: 'draft', total: 100 })
    expect((await sales.get('s1'))?.status).toBe('draft')
  })

  it('rejects an insert whose status is not in `initial` (from: "(none)")', async () => {
    const { vault } = await vaultWith(saleGuard())
    const sales = vault.collection<Sale>('sales')
    await expect(sales.put('s1', { id: 's1', status: 'paid', total: 100 }))
      .rejects.toBeInstanceOf(IllegalTransitionError)
    expect(await sales.get('s1')).toBeNull()
  })

  it('allows any insert status when `initial` is omitted', async () => {
    const { vault } = await vaultWith(
      transitionGuard<Sale>({ collection: 'sales', field: 'status', transitions: SALE_TRANSITIONS }),
    )
    const sales = vault.collection<Sale>('sales')
    await sales.put('s1', { id: 's1', status: 'invoiced', total: 100 })
    expect((await sales.get('s1'))?.status).toBe('invoiced')
  })
})

describe('transitionGuard — updates (declared arcs)', () => {
  it('allows a declared transition', async () => {
    const { vault } = await vaultWith(saleGuard())
    const sales = vault.collection<Sale>('sales')
    await sales.put('s1', { id: 's1', status: 'draft', total: 100 })
    await sales.put('s1', { id: 's1', status: 'to_verify', total: 100 })
    await sales.put('s1', { id: 's1', status: 'proforma', total: 100 })
    expect((await sales.get('s1'))?.status).toBe('proforma')
  })

  it('rejects an undeclared transition and leaves the record unchanged', async () => {
    const { vault } = await vaultWith(saleGuard())
    const sales = vault.collection<Sale>('sales')
    await sales.put('s1', { id: 's1', status: 'draft', total: 100 })
    // draft → paid is not a declared arc
    await expect(sales.put('s1', { id: 's1', status: 'paid', total: 100 }))
      .rejects.toBeInstanceOf(IllegalTransitionError)
    expect((await sales.get('s1'))?.status).toBe('draft')
  })

  it('rejects any outgoing transition from a terminal state', async () => {
    const { vault } = await vaultWith(saleGuard())
    const sales = vault.collection<Sale>('sales')
    // Walk to the terminal state via the legal path.
    await sales.put('s2', { id: 's2', status: 'draft', total: 100 })
    await sales.put('s2', { id: 's2', status: 'to_verify', total: 100 })
    await sales.put('s2', { id: 's2', status: 'proforma', total: 100 })
    await sales.put('s2', { id: 's2', status: 'invoiced', total: 100 })
    await sales.put('s2', { id: 's2', status: 'paid', total: 100 })
    // paid is terminal (paid: [])
    await expect(sales.put('s2', { id: 's2', status: 'draft', total: 100 }))
      .rejects.toBeInstanceOf(IllegalTransitionError)
    expect((await sales.get('s2'))?.status).toBe('paid')
  })

  it('the IllegalTransitionError carries from/to', async () => {
    const { vault } = await vaultWith(saleGuard())
    const sales = vault.collection<Sale>('sales')
    await sales.put('s1', { id: 's1', status: 'draft', total: 100 })
    try {
      await sales.put('s1', { id: 's1', status: 'invoiced', total: 100 })
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(IllegalTransitionError)
      const err = e as IllegalTransitionError
      expect(err.from).toBe('draft')
      expect(err.to).toBe('invoiced')
      expect(err.collection).toBe('sales')
      expect(err.id).toBe('s1')
    }
  })
})

describe('transitionGuard — idempotent writes', () => {
  it('allows a same-state write by default (other fields may change)', async () => {
    const { vault } = await vaultWith(saleGuard())
    const sales = vault.collection<Sale>('sales')
    await sales.put('s1', { id: 's1', status: 'draft', total: 100 })
    await sales.put('s1', { id: 's1', status: 'draft', total: 250 }) // same status, new total
    expect((await sales.get('s1'))?.total).toBe(250)
  })

  it('rejects a same-state write when allowIdempotent: false', async () => {
    const { vault } = await vaultWith(saleGuard({ allowIdempotent: false }))
    const sales = vault.collection<Sale>('sales')
    await sales.put('s1', { id: 's1', status: 'draft', total: 100 })
    await expect(sales.put('s1', { id: 's1', status: 'draft', total: 250 }))
      .rejects.toBeInstanceOf(IllegalTransitionError)
  })
})

describe('transitionGuard — amendment override', () => {
  it('an admin/owner amendment transaction overrides an illegal transition and is committed', async () => {
    const { db, vault } = await vaultWith(saleGuard())
    const sales = vault.collection<Sale>('sales')
    await sales.put('s1', { id: 's1', status: 'draft', total: 100 })

    // draft → paid blocked normally
    await expect(sales.put('s1', { id: 's1', status: 'paid', total: 100 }))
      .rejects.toBeInstanceOf(IllegalTransitionError)

    // amendment overrides
    await db.transaction({ amendment: true, reason: 'manual correction' }, async (tx) => {
      tx.vault('books').collection<Sale>('sales').put('s1', { id: 's1', status: 'paid', total: 100 })
    })
    expect((await sales.get('s1'))?.status).toBe('paid')
  })
})
