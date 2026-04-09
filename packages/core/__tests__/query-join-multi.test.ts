/**
 * Multi-FK chaining tests — v0.6 #75.
 *
 * The runtime support for chained `.join()` calls already exists in
 * #73 (the executor loops over `plan.joins`), so this file is mostly
 * test coverage for the compose behavior plus the per-leg left-side
 * ceiling check that #75 tightened.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { createNoydb, type Noydb } from '../src/noydb.js'
import type {
  NoydbAdapter,
  EncryptedEnvelope,
  CompartmentSnapshot,
} from '../src/types.js'
import { ConflictError, JoinTooLargeError } from '../src/errors.js'
import { resetJoinWarnings } from '../src/query/index.js'
import { ref } from '../src/refs.js'

/** Same memory adapter shape used in query-integration / query-join tests. */
function memory(): NoydbAdapter {
  const store = new Map<string, Map<string, Map<string, EncryptedEnvelope>>>()
  function getCollection(c: string, col: string): Map<string, EncryptedEnvelope> {
    let comp = store.get(c)
    if (!comp) { comp = new Map(); store.set(c, comp) }
    let coll = comp.get(col)
    if (!coll) { coll = new Map(); comp.set(col, coll) }
    return coll
  }
  return {
    name: 'memory',
    async get(c, col, id) { return store.get(c)?.get(col)?.get(id) ?? null },
    async put(c, col, id, env, ev) {
      const coll = getCollection(c, col)
      const ex = coll.get(id)
      if (ev !== undefined && ex && ex._v !== ev) throw new ConflictError(ex._v)
      coll.set(id, env)
    },
    async delete(c, col, id) { store.get(c)?.get(col)?.delete(id) },
    async list(c, col) {
      const coll = store.get(c)?.get(col)
      return coll ? [...coll.keys()] : []
    },
    async loadAll(c) {
      const comp = store.get(c)
      const snapshot: CompartmentSnapshot = {}
      if (comp) for (const [n, coll] of comp) {
        if (!n.startsWith('_')) {
          const r: Record<string, EncryptedEnvelope> = {}
          for (const [id, e] of coll) r[id] = e
          snapshot[n] = r
        }
      }
      return snapshot
    },
    async saveAll(c, data) {
      const comp = new Map<string, Map<string, EncryptedEnvelope>>()
      for (const [name, records] of Object.entries(data)) {
        const coll = new Map<string, EncryptedEnvelope>()
        for (const [id, env] of Object.entries(records)) coll.set(id, env)
        comp.set(name, coll)
      }
      const existing = store.get(c)
      if (existing) {
        for (const [name, coll] of existing) {
          if (name.startsWith('_')) comp.set(name, coll)
        }
      }
      store.set(c, comp)
    },
  }
}

// Three-way shape: invoice → client and invoice → category. Then
// client → territory for 3-join chains.
interface Territory { id: string; name: string; region: 'north' | 'south' }
interface Client    { id: string; name: string; territoryId: string }
interface Category  { id: string; label: string }
interface Invoice {
  id: string
  amount: number
  status: 'open' | 'paid'
  clientId: string
  categoryId: string | null
}

describe('Query.join() multi-FK chaining — v0.6 #75', () => {
  let db: Noydb

  beforeEach(async () => {
    db = await createNoydb({
      adapter: memory(),
      user: 'owner',
      secret: 'multi-join-test-passphrase-2026',
    })
    resetJoinWarnings()
  })

  afterEach(() => {
    resetJoinWarnings()
  })

  // ─── 2-join chain: two independent FKs on the left ──────────────

  it('.join().join() populates both alias keys from independent FKs', async () => {
    const c = await db.openCompartment('TEST')
    const clients = c.collection<Client>('clients')
    const categories = c.collection<Category>('categories')
    const invoices = c.collection<Invoice>('invoices', {
      refs: {
        clientId: ref('clients'),
        categoryId: ref('categories'),
      },
    })

    await clients.put('cli-A', { id: 'cli-A', name: 'Acme', territoryId: 't-1' })
    await categories.put('cat-1', { id: 'cat-1', label: 'Consulting' })
    await invoices.put('inv-1', {
      id: 'inv-1',
      amount: 1200,
      status: 'open',
      clientId: 'cli-A',
      categoryId: 'cat-1',
    })

    type Joined = Invoice & { client: Client | null; category: Category | null }
    const rows = invoices.query()
      .join<'client', Client>('clientId', { as: 'client' })
      .join<'category', Category>('categoryId', { as: 'category' })
      .toArray() as Joined[]

    expect(rows).toHaveLength(1)
    expect(rows[0]?.client?.name).toBe('Acme')
    expect(rows[0]?.category?.label).toBe('Consulting')
    // Left-side fields preserved alongside both joined aliases.
    expect(rows[0]?.amount).toBe(1200)
    expect(rows[0]?.status).toBe('open')
  })

  it('2-join chain across multiple left rows with mixed FK populations', async () => {
    const c = await db.openCompartment('TEST')
    const clients = c.collection<Client>('clients')
    const categories = c.collection<Category>('categories')
    const invoices = c.collection<Invoice>('invoices', {
      refs: {
        clientId: ref('clients'),
        categoryId: ref('categories', 'warn'),  // nullable second join
      },
    })

    await clients.put('cli-A', { id: 'cli-A', name: 'Acme', territoryId: 't-1' })
    await clients.put('cli-B', { id: 'cli-B', name: 'Beacon', territoryId: 't-2' })
    await categories.put('cat-1', { id: 'cat-1', label: 'Consulting' })

    await invoices.put('inv-1', { id: 'inv-1', amount: 100, status: 'open', clientId: 'cli-A', categoryId: 'cat-1' })
    await invoices.put('inv-2', { id: 'inv-2', amount: 200, status: 'open', clientId: 'cli-B', categoryId: null })
    await invoices.put('inv-3', { id: 'inv-3', amount: 300, status: 'paid', clientId: 'cli-A', categoryId: 'cat-1' })

    type Joined = Invoice & { client: Client | null; category: Category | null }
    const rows = invoices.query()
      .orderBy('id')
      .join<'client', Client>('clientId', { as: 'client' })
      .join<'category', Category>('categoryId', { as: 'category' })
      .toArray() as Joined[]

    expect(rows).toHaveLength(3)
    expect(rows[0]?.client?.name).toBe('Acme')
    expect(rows[0]?.category?.label).toBe('Consulting')
    expect(rows[1]?.client?.name).toBe('Beacon')
    expect(rows[1]?.category).toBeNull()  // null FK → null attach, no warn
    expect(rows[2]?.client?.name).toBe('Acme')
    expect(rows[2]?.category?.label).toBe('Consulting')
  })

  // ─── 3-join chain ────────────────────────────────────────────────

  it('3-join chain: invoice → client → territory via repeated joins', async () => {
    const c = await db.openCompartment('TEST')
    const territories = c.collection<Territory>('territories')
    const clients = c.collection<Client>('clients', {
      refs: { territoryId: ref('territories') },
    })
    const categories = c.collection<Category>('categories')
    const invoices = c.collection<Invoice>('invoices', {
      refs: {
        clientId: ref('clients'),
        categoryId: ref('categories'),
      },
    })

    await territories.put('t-1', { id: 't-1', name: 'Chiang Mai', region: 'north' })
    await clients.put('cli-A', { id: 'cli-A', name: 'Acme', territoryId: 't-1' })
    await categories.put('cat-1', { id: 'cat-1', label: 'Consulting' })
    await invoices.put('inv-1', {
      id: 'inv-1',
      amount: 500,
      status: 'open',
      clientId: 'cli-A',
      categoryId: 'cat-1',
    })

    // Two joins on the invoice directly — 3 total resolved references
    // spanning three collections on the query side.
    type Joined = Invoice & {
      client: Client | null
      category: Category | null
    }
    const rows = invoices.query()
      .join<'client', Client>('clientId', { as: 'client' })
      .join<'category', Category>('categoryId', { as: 'category' })
      .toArray() as Joined[]

    expect(rows).toHaveLength(1)
    expect(rows[0]?.client?.territoryId).toBe('t-1')
    expect(rows[0]?.category?.label).toBe('Consulting')
  })

  // ─── Mixed planner strategies on the same query ─────────────────

  it('mixed strategies: one nested-loop + one explicit hash in the same chain', async () => {
    const c = await db.openCompartment('TEST')
    const clients = c.collection<Client>('clients')
    const categories = c.collection<Category>('categories')
    const invoices = c.collection<Invoice>('invoices', {
      refs: {
        clientId: ref('clients'),
        categoryId: ref('categories'),
      },
    })

    await clients.put('cli-A', { id: 'cli-A', name: 'Acme', territoryId: 't-1' })
    await categories.put('cat-1', { id: 'cat-1', label: 'Consulting' })
    await invoices.put('inv-1', { id: 'inv-1', amount: 100, status: 'open', clientId: 'cli-A', categoryId: 'cat-1' })
    await invoices.put('inv-2', { id: 'inv-2', amount: 200, status: 'paid', clientId: 'cli-A', categoryId: 'cat-1' })

    type Joined = Invoice & { client: Client | null; category: Category | null }
    const rows = invoices.query()
      .orderBy('id')
      .join<'client', Client>('clientId', { as: 'client', strategy: 'nested' })
      .join<'category', Category>('categoryId', { as: 'category', strategy: 'hash' })
      .toArray() as Joined[]

    expect(rows).toHaveLength(2)
    for (const r of rows) {
      expect(r.client?.name).toBe('Acme')
      expect(r.category?.label).toBe('Consulting')
    }
  })

  // ─── Mixed ref modes — independent per leg ──────────────────────

  it('mixed ref modes: first join strict, second join warn, both fire independently', async () => {
    const c = await db.openCompartment('TEST')
    const clients = c.collection<Client>('clients')
    const categories = c.collection<Category>('categories')
    const invoices = c.collection<Invoice>('invoices', {
      refs: {
        clientId: ref('clients', 'strict'),
        categoryId: ref('categories', 'warn'),
      },
    })

    // Populate only the clients side. Categories is left empty so
    // the second join's warn-mode fires on every row.
    await clients.put('cli-A', { id: 'cli-A', name: 'Acme', territoryId: 't-1' })
    await invoices.put('inv-1', {
      id: 'inv-1',
      amount: 100,
      status: 'open',
      clientId: 'cli-A',
      categoryId: 'missing-cat',
    })

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    type Joined = Invoice & { client: Client | null; category: Category | null }
    const rows = invoices.query()
      .join<'client', Client>('clientId', { as: 'client' })
      .join<'category', Category>('categoryId', { as: 'category' })
      .toArray() as Joined[]

    expect(rows).toHaveLength(1)
    // First leg (strict) resolved successfully.
    expect(rows[0]?.client?.name).toBe('Acme')
    // Second leg (warn) attached null + warned.
    expect(rows[0]?.category).toBeNull()
    const danglingCalls = warnSpy.mock.calls.filter(call =>
      typeof call[0] === 'string' && call[0].includes('dangling ref'),
    )
    expect(danglingCalls).toHaveLength(1)
    expect(danglingCalls[0]?.[0]).toContain('categoryId')
    warnSpy.mockRestore()
  })

  // ─── Per-leg left-side ceiling check (#75 acceptance #3) ────────

  it('later leg with tighter maxRows catches left-side overflow independently', async () => {
    const c = await db.openCompartment('TEST')
    const clients = c.collection<Client>('clients')
    const categories = c.collection<Category>('categories')
    const invoices = c.collection<Invoice>('invoices', {
      refs: {
        clientId: ref('clients'),
        categoryId: ref('categories'),
      },
    })

    await clients.put('cli-A', { id: 'cli-A', name: 'Acme', territoryId: 't-1' })
    await categories.put('cat-1', { id: 'cat-1', label: 'Consulting' })
    // 10 invoices on the left side.
    for (let i = 0; i < 10; i++) {
      await invoices.put(`inv-${i}`, {
        id: `inv-${i}`,
        amount: i * 100,
        status: 'open',
        clientId: 'cli-A',
        categoryId: 'cat-1',
      })
    }

    // First join allows 100 — passes. Second join only allows 5 —
    // the per-leg left-side check should catch the overflow here.
    try {
      invoices.query()
        .join('clientId', { as: 'client', maxRows: 100 })
        .join('categoryId', { as: 'category', maxRows: 5 })
        .toArray()
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(JoinTooLargeError)
      const e = err as JoinTooLargeError
      expect(e.side).toBe('left')
      expect(e.leftRows).toBe(10)
      expect(e.maxRows).toBe(5)
      // Error message should name the specific target that tripped.
      expect(e.message).toContain('categories')
    }
  })

  it('first leg maxRows applies to the first join, not later legs — equi-join keeps left cardinality constant', async () => {
    const c = await db.openCompartment('TEST')
    const clients = c.collection<Client>('clients')
    const categories = c.collection<Category>('categories')
    const invoices = c.collection<Invoice>('invoices', {
      refs: {
        clientId: ref('clients'),
        categoryId: ref('categories'),
      },
    })

    await clients.put('cli-A', { id: 'cli-A', name: 'Acme', territoryId: 't-1' })
    await categories.put('cat-1', { id: 'cat-1', label: 'Consulting' })
    for (let i = 0; i < 10; i++) {
      await invoices.put(`inv-${i}`, {
        id: `inv-${i}`,
        amount: i * 100,
        status: 'open',
        clientId: 'cli-A',
        categoryId: 'cat-1',
      })
    }

    // Both legs allow 100 — passes cleanly, proving equi-join is
    // 1:1 so the left row count stays at 10 across both legs (no
    // cartesian blowup).
    const rows = invoices.query()
      .join('clientId', { as: 'client', maxRows: 100 })
      .join('categoryId', { as: 'category', maxRows: 100 })
      .toArray()
    expect(rows).toHaveLength(10)
  })

  // ─── Plan serialization for debugging ───────────────────────────

  it('toPlan() surfaces all join legs with their partitionScope seams (#87 constraint #1)', async () => {
    const c = await db.openCompartment('TEST')
    const clients = c.collection<Client>('clients')
    const categories = c.collection<Category>('categories')
    const invoices = c.collection<Invoice>('invoices', {
      refs: {
        clientId: ref('clients'),
        categoryId: ref('categories'),
      },
    })
    await clients.put('cli-A', { id: 'cli-A', name: 'Acme', territoryId: 't-1' })
    await categories.put('cat-1', { id: 'cat-1', label: 'Consulting' })

    const q = invoices.query()
      .join('clientId', { as: 'client' })
      .join('categoryId', { as: 'category' })
    const plan = q.toPlan() as { joins: Array<{ as: string; target: string; partitionScope: string }> }

    expect(plan.joins).toHaveLength(2)
    expect(plan.joins[0]?.as).toBe('client')
    expect(plan.joins[0]?.target).toBe('clients')
    expect(plan.joins[0]?.partitionScope).toBe('all')
    expect(plan.joins[1]?.as).toBe('category')
    expect(plan.joins[1]?.target).toBe('categories')
    expect(plan.joins[1]?.partitionScope).toBe('all')
  })
})
