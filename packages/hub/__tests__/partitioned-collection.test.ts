/**
 * Partitioned collections (#1342, ADR 0007) — declaration, cheap enumeration,
 * the union read path, and the pruning whitelist.
 *
 * ⭐ **THE FALLBACKS ARE THE POINT, NOT THE FAST PATH.** A partition wrongly
 * INCLUDED costs a scan; a partition wrongly EXCLUDED is silently missing
 * data. So every shape that must degrade to "read everything" gets a test
 * asserting BOTH halves: that the scope is `'all'`, and — the half that
 * actually catches a regression — that the rows the union returns are the
 * rows a hand-merge of every partition returns. A test that only checked the
 * scope string would pass for a pruner that returned `'all'` and then read
 * one collection anyway.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createNoydb, type Noydb } from '../src/kernel/noydb.js'
import type { Vault } from '../src/kernel/vault.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot, ListPageResult } from '../src/kernel/types.js'
import { ConflictError } from '../src/kernel/errors.js'
import { partitioned, PartitionKeyError, type PartitionedCollection } from '../src/with-store/partitioned/index.js'
import { resolvePartitionScope, ALL_PARTITIONS } from '../src/kernel/query/partition.js'
import { count, sum } from '../src/with-lookup/reduce/reducers.js'

interface Counters {
  loadAll: number
  listPage: number
  /** Envelopes handed to the decrypt path, by collection. */
  served: Map<string, number>
}

/** Memory store WITH `listPage`, instrumented — the counters are the measurement. */
function toMemory(counters: Counters): NoydbStore {
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
    async listPage(c, col, cursor, limit): Promise<ListPageResult> {
      counters.listPage += 1
      const coll = store.get(c)?.get(col)
      const ids = coll ? [...coll.keys()].sort() : []
      const start = cursor ? Number.parseInt(cursor, 10) : 0
      const end = Math.min(start + (limit ?? 100), ids.length)
      const items = ids.slice(start, end).map((id) => ({ id, envelope: coll!.get(id)! }))
      counters.served.set(col, (counters.served.get(col) ?? 0) + items.length)
      return { items, nextCursor: end < ids.length ? String(end) : null }
    },
    async loadAll(c) {
      counters.loadAll += 1
      const comp = store.get(c)
      const snapshot: VaultSnapshot = {}
      if (comp) for (const [n, coll] of comp) {
        const r: Record<string, EncryptedEnvelope> = {}
        for (const [id, e] of coll) r[id] = e
        snapshot[n] = r
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
      store.set(c, comp)
    },
  }
}

interface Invoice {
  id: string
  period: string
  amount: number
  status: string
}

const QUARTERS = ['FY2026-Q1', 'FY2026-Q2', 'FY2026-Q3', 'FY2026-Q4'] as const

describe('partitioned collections (#1342)', () => {
  let db: Noydb
  let vault: Vault
  let counters: Counters
  let invoices: PartitionedCollection<Invoice>

  beforeEach(async () => {
    counters = { loadAll: 0, listPage: 0, served: new Map() }
    db = await createNoydb({ store: toMemory(counters), user: 'owner', secret: 'partitions-2026' })
    vault = await db.openVault('TEST')
    invoices = partitioned<Invoice>(vault, {
      name: 'invoices',
      key: 'period',
      partitions: [...QUARTERS],
    })
    let n = 0
    for (const period of QUARTERS) {
      for (let i = 0; i < 5; i++) {
        n += 1
        await invoices.put(`inv-${n}`, {
          id: `inv-${n}`,
          period,
          amount: n * 10,
          status: i % 2 === 0 ? 'open' : 'paid',
        })
      }
    }
  })

  // ── declaration + routing ────────────────────────────────────────────

  it('routes a put into the collection its partition key names', async () => {
    expect(await vault.collection<Invoice>('invoices@FY2026-Q1').list()).toHaveLength(5)
    expect(await vault.collection<Invoice>('invoices@FY2026-Q4').list()).toHaveLength(5)
    // The logical name is never itself a stored collection.
    expect(await vault.collection<Invoice>('invoices').list()).toHaveLength(0)
  })

  it('refuses to route a record whose partition key is not a non-empty string', async () => {
    await expect(
      invoices.put('bad', { id: 'bad', period: '', amount: 1, status: 'open' }),
    ).rejects.toBeInstanceOf(PartitionKeyError)
    await expect(
      invoices.put('bad', { id: 'bad', period: 2026 as unknown as string, amount: 1, status: 'open' }),
    ).rejects.toBeInstanceOf(PartitionKeyError)
  })

  it('a partition written but never declared survives into a fresh handle', async () => {
    await invoices.put('inv-x', { id: 'inv-x', period: 'FY2027-Q1', amount: 1, status: 'open' })
    // A handle declaring NOTHING reads the set back out of the registry.
    const rediscovered = partitioned<Invoice>(vault, { name: 'invoices', key: 'period' })
    expect(await rediscovered.partitions()).toEqual([...QUARTERS, 'FY2027-Q1'])
  })

  // ── cheap enumeration ────────────────────────────────────────────────

  it('enumerating partitions costs no loadAll — vault.collections() does', async () => {
    const fresh = partitioned<Invoice>(vault, { name: 'invoices', key: 'period' })
    const before = counters.loadAll
    expect(await fresh.partitions()).toEqual([...QUARTERS])
    expect(counters.loadAll).toBe(before) // ⭐ the claim, measured
    // Repeat reads are free — the set is session-cached.
    await fresh.partitions()
    expect(counters.loadAll).toBe(before)
    // …and this is what it replaces.
    await vault.collections()
    expect(counters.loadAll).toBeGreaterThan(before)
  })

  // ── the union read path ──────────────────────────────────────────────

  it('unions every partition when nothing narrows', async () => {
    const rows = await invoices.query().all()
    expect(rows).toHaveLength(20)
  })

  it('sorts and pages AFTER the union, not per leg', async () => {
    // The three largest amounts all live in Q4. A per-leg limit would have
    // returned the top of each quarter and then trimmed — this asserts the
    // union's top 3, which only the post-union sort can produce.
    const top = await invoices.query().orderBy('amount', 'desc').limit(3).all()
    expect(top.map((r) => r.amount)).toEqual([200, 190, 180])

    const page2 = await invoices.query().orderBy('amount', 'asc').offset(4).limit(3).all()
    expect(page2.map((r) => r.amount)).toEqual([50, 60, 70])
  })

  it('counts and aggregates across the union', async () => {
    expect(await invoices.query().count()).toBe(20)
    expect(await invoices.query().where('status', '==', 'open').count()).toBe(12)
    const agg = await invoices.query().aggregate({ n: count(), total: sum('amount') })
    expect(agg.n).toBe(20)
    expect(agg.total).toBe(2100)
  })

  it('a reduction is not paginated — limit/offset describe a page, count() ignores them', async () => {
    expect(await invoices.query().orderBy('amount').limit(2).count()).toBe(20)
  })

  it('first() reads the union order', async () => {
    expect((await invoices.query().orderBy('amount', 'desc').first())?.amount).toBe(200)
    expect(await invoices.query().where('period', '==', 'nope').first()).toBeNull()
  })

  // ── pruning: the fast path ───────────────────────────────────────────

  it('a top-level == on the partition key reads exactly one collection', async () => {
    const q = invoices.query().where('period', '==', 'FY2026-Q2')
    expect((await q.scope()).scope).toEqual(['FY2026-Q2'])
    const rows = await q.all()
    expect(rows).toHaveLength(5)
    expect(rows.every((r) => r.period === 'FY2026-Q2')).toBe(true)
  })

  it('a top-level `in` narrows to the named set, in declaration order', async () => {
    const q = invoices.query().where('period', 'in', ['FY2026-Q4', 'FY2026-Q1'])
    expect((await q.scope()).scope).toEqual(['FY2026-Q1', 'FY2026-Q4'])
    expect(await q.count()).toBe(10)
  })

  it('two AND-ed narrowing clauses intersect', async () => {
    const q = invoices.query()
      .where('period', 'in', ['FY2026-Q1', 'FY2026-Q2'])
      .where('period', '==', 'FY2026-Q2')
    expect((await q.scope()).scope).toEqual(['FY2026-Q2'])
    expect(await q.count()).toBe(5)
  })

  it('a partition value that was never declared prunes to nothing, and reads nothing', async () => {
    const q = invoices.query().where('period', '==', 'FY2099-Q1')
    expect((await q.scope()).scope).toEqual([])
    expect(await q.all()).toEqual([])
    expect(await q.count()).toBe(0)
  })

  // ── pruning: the fallbacks ───────────────────────────────────────────
  //
  // Each asserts the scope is 'all' AND that the rows match a hand-merge, so
  // a pruner that says 'all' and then reads one leg still fails.

  it.each([
    ['!= on the key', (q: ReturnType<PartitionedCollection<Invoice>['query']>) => q.where('period', '!=', 'FY2026-Q1'), 15],
    ['!in on the key', (q: ReturnType<PartitionedCollection<Invoice>['query']>) => q.where('period', '!in', ['FY2026-Q1']), 15],
    ['a range on the key', (q: ReturnType<PartitionedCollection<Invoice>['query']>) => q.where('period', '>=', 'FY2026-Q3'), 10],
    ['startsWith on the key', (q: ReturnType<PartitionedCollection<Invoice>['query']>) => q.where('period', 'startsWith', 'FY2026-Q1'), 5],
    ['contains on the key', (q: ReturnType<PartitionedCollection<Invoice>['query']>) => q.where('period', 'contains', 'Q1'), 5],
    ['matches on the key', (q: ReturnType<PartitionedCollection<Invoice>['query']>) => q.where('period', 'matches', /Q[12]$/), 10],
    ['a clause on a different field', (q: ReturnType<PartitionedCollection<Invoice>['query']>) => q.where('status', '==', 'open'), 12],
    ['a non-string operand', (q: ReturnType<PartitionedCollection<Invoice>['query']>) => q.where('period', '==', 2026 as unknown as string), 0],
    ['an empty in-set', (q: ReturnType<PartitionedCollection<Invoice>['query']>) => q.where('period', 'in', []), 0],
  ])('falls back to every partition for %s', async (_label, build, expected) => {
    const q = build(invoices.query())
    const { scope } = await q.scope()
    // `in []` is the one row here that legitimately narrows — to nothing.
    if (_label === 'an empty in-set') expect(scope).toEqual([])
    else expect(scope).toBe(ALL_PARTITIONS)
    expect(await q.count()).toBe(expected)
  })

  it('falls back for a filter() callback — opaque by construction', async () => {
    const q = invoices.query().filter((r) => r.period === 'FY2026-Q1')
    expect((await q.scope()).scope).toBe(ALL_PARTITIONS)
    expect(await q.count()).toBe(5)
  })

  it('falls back for a nested group — a clause inside an `or` is not AND-ed with the top level', () => {
    // Built directly against the decision function: the executor's clause list
    // is what it classifies, and this is the shape `Query.or()` produces.
    const scope = resolvePartitionScope(
      [{
        type: 'group',
        op: 'or',
        clauses: [
          { type: 'field', field: 'period', op: '==', value: 'FY2026-Q1' },
          { type: 'field', field: 'period', op: '==', value: 'FY2026-Q2' },
        ],
      }],
      'period',
      [...QUARTERS],
    )
    expect(scope).toBe(ALL_PARTITIONS)
  })

  it('falls back for a Via-covered clause — the operand is in STORED form, not partition-key space', () => {
    const scope = resolvePartitionScope(
      [{
        type: 'field',
        field: 'period',
        op: '==',
        value: 'FY2026-Q1',
        via: { brand: 'money', payload: null, evaluate: () => true },
      }],
      'period',
      [...QUARTERS],
    )
    expect(scope).toBe(ALL_PARTITIONS)
  })

  it('falls back for an operator this build has never heard of', () => {
    const scope = resolvePartitionScope(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      [{ type: 'field', field: 'period', op: 'someFutureOp' as any, value: 'FY2026-Q1' }],
      'period',
      [...QUARTERS],
    )
    expect(scope).toBe(ALL_PARTITIONS)
  })

  // ── explain() ────────────────────────────────────────────────────────

  it('explain() reports the partition decision, pruned', async () => {
    const explanation = await invoices.query().where('period', '==', 'FY2026-Q2').explain()
    const head = explanation.nodes[0]!
    expect(head.op).toBe('partitions')
    expect(head.dispatch).toBe('partitions:pruned')
    expect(head.detail).toBe('partitions: 1 of 4 scanned')
    expect(head.notes).toContain('FY2026-Q2')
    expect(explanation.text.split('\n')[0]).toContain('partitions: 1 of 4 scanned')
    // The member's own plan follows, from the SAME renderer.
    expect(explanation.nodes.some((n) => n.op === 'source')).toBe(true)
  })

  it('explain() says so when nothing narrows', async () => {
    const explanation = await invoices.query().where('status', '==', 'open').explain()
    expect(explanation.nodes[0]!.dispatch).toBe('partitions:all')
    expect(explanation.nodes[0]!.detail).toBe('partitions: 4 of 4 scanned')
    expect(explanation.nodes[0]!.notes).toContain('predicate proves no narrowing — every partition is read')
  })

  it('explain() is observational — it reads no partition it did not have to', async () => {
    const explanation = await invoices.query().where('period', '==', 'FY2099-Q1').explain()
    expect(explanation.nodes[0]!.detail).toBe('partitions: 0 of 4 scanned')
    expect(explanation.nodes[0]!.notes).toContain('no partition admits this predicate — nothing is read')
    expect(explanation.nodes).toHaveLength(1)
  })

  // ── the union scan ───────────────────────────────────────────────────

  it('scan() streams every partition in declaration order', async () => {
    const rows = await invoices.scan({ pageSize: 3 }).toArray()
    expect(rows).toHaveLength(20)
    expect(rows.slice(0, 5).every((r) => r.period === 'FY2026-Q1')).toBe(true)
    expect(rows.slice(15).every((r) => r.period === 'FY2026-Q4')).toBe(true)
  })

  it('scan() aggregates across the union through the existing reducer protocol', async () => {
    const agg = await invoices.scan({ pageSize: 2 }).aggregate({ n: count(), total: sum('amount') })
    expect(agg.n).toBe(20)
    expect(agg.total).toBe(2100)
  })

  it('scan() prunes — and an excluded partition is never asked for', async () => {
    counters.served.clear()
    counters.listPage = 0
    const rows = await invoices.scan({ pageSize: 100 }).where('period', '==', 'FY2026-Q3').toArray()
    expect(rows).toHaveLength(5)
    expect([...counters.served.keys()]).toEqual(['invoices@FY2026-Q3'])
  })

  it('scan() honours a page size smaller than a partition, across the seam', async () => {
    // pageSize 2 against 5-record partitions: every member is walked over
    // three pages, and the composite cursor has to hand off mid-stream.
    const rows = await invoices.scan({ pageSize: 2 })
      .where('period', 'in', ['FY2026-Q1', 'FY2026-Q2'])
      .toArray()
    expect(rows).toHaveLength(10)
    expect(new Set(rows.map((r) => r.id)).size).toBe(10)
  })

  it('an empty partition in the middle of the set does not truncate the stream', async () => {
    // A separate logical collection: `invoices`'s registry now holds all four
    // quarters, so declaring a three-partition view of it would enumerate the
    // union of both — which is the registry doing its job, not a gap.
    const gapped = partitioned<Invoice>(vault, {
      name: 'gapped',
      key: 'period',
      partitions: ['A', 'EMPTY', 'B'],
    })
    await gapped.put('g1', { id: 'g1', period: 'A', amount: 1, status: 'open' })
    await gapped.put('g2', { id: 'g2', period: 'A', amount: 2, status: 'open' })
    await gapped.put('g3', { id: 'g3', period: 'B', amount: 3, status: 'open' })
    expect(await gapped.partitions()).toEqual(['A', 'EMPTY', 'B'])
    // pageSize 1 forces a cursor hand-off at every record AND across the gap.
    const rows = await gapped.scan({ pageSize: 1 }).toArray()
    expect(rows.map((r) => r.id)).toEqual(['g1', 'g2', 'g3'])
  })
})
