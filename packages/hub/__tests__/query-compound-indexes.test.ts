import { describe, it, expect, beforeEach } from 'vitest'
import { CollectionIndexes } from '../src/with-lookup/indexing/eager-indexes.js'
import { createNoydb } from '../src/kernel/noydb.js'
import { withIndexing } from '../src/with-lookup/indexing/index.js'
import { Query } from '../src/kernel/query/builder.js'
import type { QuerySource } from '../src/kernel/query/builder.js'
import type { Noydb } from '../src/kernel/noydb.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { ConflictError } from '../src/kernel/errors.js'

/** Inline memory adapter — same pattern as `query-sorted-indexes.test.ts`. */
function toMemory(): NoydbStore {
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

const sorted = (set: ReadonlySet<string> | null): string[] => [...(set ?? [])].sort()

// ─── Unit tests for the compound half of CollectionIndexes ─────────

describe('CollectionIndexes — compound (unit)', () => {
  let idx: CollectionIndexes

  const rows = [
    { id: 'a', record: { client: 'C1', date: '2026-01-01', amount: 10 } },
    { id: 'b', record: { client: 'C1', date: '2026-01-05', amount: 20 } },
    { id: 'c', record: { client: 'C1', date: '2026-01-05', amount: 30 } },
    { id: 'd', record: { client: 'C1', date: '2026-02-01', amount: 40 } },
    { id: 'e', record: { client: 'C2', date: '2026-01-03', amount: 50 } },
  ]

  beforeEach(() => {
    idx = new CollectionIndexes()
    idx.declareCompound(['client', 'date'])
    idx.build(rows)
  })

  it('1. declareCompound registers the tuple and indexes every record', () => {
    expect(idx.compoundTuples().map(f => [...f])).toEqual([['client', 'date']])
    expect(idx.compoundSize(['client', 'date'])).toBe(5)
    expect(idx.compoundSize(['client'])).toBe(0)
  })

  it('2. a single-field declaration is not a compound index', () => {
    const one = new CollectionIndexes()
    one.declareCompound(['client'])
    expect(one.compoundTuples()).toEqual([])
  })

  it('3. an equality prefix returns exactly that prefix run', () => {
    expect(sorted(idx.lookupCompound(['client', 'date'], ['C1']))).toEqual(['a', 'b', 'c', 'd'])
    expect(sorted(idx.lookupCompound(['client', 'date'], ['C2']))).toEqual(['e'])
    expect(sorted(idx.lookupCompound(['client', 'date'], ['C9']))).toEqual([])
  })

  it('4. an undeclared tuple returns null (caller falls back to a scan)', () => {
    expect(idx.lookupCompound(['client', 'amount'], ['C1'])).toBeNull()
    expect(idx.compoundOrderedIds(['client', 'amount'], ['C1'], 'asc')).toBeNull()
  })

  it('5. an equality prefix plus a range on the next component', () => {
    const fields = ['client', 'date']
    expect(sorted(idx.lookupCompound(fields, ['C1'], { op: '>=', value: '2026-01-05' }))).toEqual(['b', 'c', 'd'])
    expect(sorted(idx.lookupCompound(fields, ['C1'], { op: '<', value: '2026-01-05' }))).toEqual(['a'])
    expect(sorted(idx.lookupCompound(fields, ['C1'], { op: '<=', value: '2026-01-05' }))).toEqual(['a', 'b', 'c'])
    expect(sorted(idx.lookupCompound(fields, ['C1'], { op: '>', value: '2026-01-05' }))).toEqual(['d'])
    expect(
      sorted(idx.lookupCompound(fields, ['C1'], { op: 'between', value: ['2026-01-02', '2026-01-31'] })),
    ).toEqual(['b', 'c'])
    expect(sorted(idx.lookupCompound(fields, ['C1'], { op: 'startsWith', value: '2026-01' }))).toEqual([
      'a', 'b', 'c',
    ])
    // The range never leaks across the equality prefix.
    expect(sorted(idx.lookupCompound(fields, ['C2'], { op: '<', value: '2026-99' }))).toEqual(['e'])
  })

  it('6. the kind partition holds PER COMPONENT — a string probe cannot reach number entries', () => {
    const mixed = new CollectionIndexes()
    mixed.declareCompound(['client', 'v'])
    mixed.build([
      { id: 'n1', record: { client: 'C1', v: 5 } },
      { id: 'n2', record: { client: 'C1', v: 50 } },
      { id: 's1', record: { client: 'C1', v: '5' } },
      { id: 's2', record: { client: 'C1', v: '50' } },
    ])
    // `>` over a number probe stays inside the number run…
    expect(sorted(mixed.lookupCompound(['client', 'v'], ['C1'], { op: '>', value: 5 }))).toEqual(['n2'])
    // …and a string probe stays inside the string run.
    expect(sorted(mixed.lookupCompound(['client', 'v'], ['C1'], { op: '>=', value: '5' }))).toEqual(['s1', 's2'])
    // Equality on the FIRST component is kind-partitioned too: 1 !== '1'.
    const heads = new CollectionIndexes()
    heads.declareCompound(['k', 'v'])
    heads.build([
      { id: 'x', record: { k: 1, v: 1 } },
      { id: 'y', record: { k: '1', v: 1 } },
    ])
    expect(sorted(heads.lookupCompound(['k', 'v'], [1]))).toEqual(['x'])
    expect(sorted(heads.lookupCompound(['k', 'v'], ['1']))).toEqual(['y'])
  })

  it('7. a record with a nullish or non-orderable component is not indexed', () => {
    const partial = new CollectionIndexes()
    partial.declareCompound(['client', 'date'])
    partial.build([
      { id: 'a', record: { client: 'C1', date: '2026-01-01' } },
      { id: 'b', record: { client: 'C1', date: null } },
      { id: 'c', record: { client: 'C1', date: true } },
      { id: 'd', record: { date: '2026-01-01' } },
    ])
    expect(partial.compoundSize(['client', 'date'])).toBe(1)
  })

  it('8. compoundOrderedIds keeps ties in insertion order in BOTH directions', () => {
    // b and c tie on ('C1', '2026-01-05').
    expect(idx.compoundOrderedIds(['client', 'date'], ['C1'], 'asc')).toEqual(['a', 'b', 'c', 'd'])
    expect(idx.compoundOrderedIds(['client', 'date'], ['C1'], 'desc')).toEqual(['d', 'b', 'c', 'a'])
  })

  it('9. upsert and remove maintain the compound index', () => {
    idx.remove('c', rows[2]!.record)
    expect(idx.compoundSize(['client', 'date'])).toBe(4)
    expect(sorted(idx.lookupCompound(['client', 'date'], ['C1']))).toEqual(['a', 'b', 'd'])
    idx.upsert('a', { client: 'C2', date: '2026-01-01', amount: 10 }, rows[0]!.record)
    expect(sorted(idx.lookupCompound(['client', 'date'], ['C1']))).toEqual(['b', 'd'])
    expect(sorted(idx.lookupCompound(['client', 'date'], ['C2']))).toEqual(['a', 'e'])
  })
})

// ─── Integration against the real Collection pipeline ──────────────

interface Invoice {
  id: string
  status: 'draft' | 'open' | 'paid' | 'overdue'
  amount: number
  client: string
  dueDate: string
}

describe('Collection.query() — compound-index execution', () => {
  const records: Invoice[] = Array.from({ length: 60 }, (_, i) => ({
    id: `inv-${String(i).padStart(3, '0')}`,
    status: (['draft', 'open', 'paid', 'overdue'] as const)[i % 4]!,
    amount: i * 10,
    client: `Client-${String.fromCharCode(65 + (i % 5))}`,
    dueDate: `2026-04-${String((i % 7) + 1).padStart(2, '0')}`,
  }))

  let indexed: Awaited<ReturnType<typeof setup>>['indexed']
  let plain: Awaited<ReturnType<typeof setup>>['plain']

  async function setup() {
    const db: Noydb = await createNoydb({
      store: toMemory(),
      user: 'owner',
      secret: 'compound-index-test-secret-2026',
      indexingStrategy: withIndexing(),
    })
    const vault = await db.openVault('TEST')
    const indexed = vault.collection<Invoice>('indexed', {
      indexes: [
        { fields: ['client', 'dueDate'], kind: 'sorted' },
        { fields: ['status', 'amount'], kind: 'sorted' },
      ],
    })
    const plain = vault.collection<Invoice>('plain')
    for (const r of records) {
      await indexed.put(r.id, r)
      await plain.put(r.id, r)
    }
    return { indexed, plain }
  }

  beforeEach(async () => {
    ;({ indexed, plain } = await setup())
  })

  const byId = (rows: readonly Invoice[]): string[] => rows.map(r => r.id).sort()

  it('10. the headline shape — eq prefix + orderBy + limit matches the linear scan', () => {
    const a = indexed.query().where('client', '==', 'Client-B').orderBy('dueDate').limit(5).toArray()
    const b = plain.query().where('client', '==', 'Client-B').orderBy('dueDate').limit(5).toArray()
    expect(a.length).toBe(5)
    expect(a.map(r => r.id)).toEqual(b.map(r => r.id))
  })

  it('11. eq prefix + orderBy DESC over a tied component matches the linear scan', () => {
    const a = indexed.query().where('client', '==', 'Client-B').orderBy('dueDate', 'desc').limit(6).toArray()
    const b = plain.query().where('client', '==', 'Client-B').orderBy('dueDate', 'desc').limit(6).toArray()
    expect(a.map(r => r.id)).toEqual(b.map(r => r.id))
  })

  it('12. eq prefix + offset + limit matches the linear scan', () => {
    const a = indexed.query().where('client', '==', 'Client-C').orderBy('dueDate').offset(3).limit(4).toArray()
    const b = plain.query().where('client', '==', 'Client-C').orderBy('dueDate').offset(3).limit(4).toArray()
    expect(a.map(r => r.id)).toEqual(b.map(r => r.id))
  })

  it('13. eq prefix + range on the next component matches the linear scan', () => {
    const a = indexed.query().where('status', '==', 'open').where('amount', '>=', 200).toArray()
    const b = plain.query().where('status', '==', 'open').where('amount', '>=', 200).toArray()
    expect(a.length).toBeGreaterThan(0)
    expect(byId(a)).toEqual(byId(b))
  })

  it('14. eq prefix + startsWith on the next component matches the linear scan', () => {
    const a = indexed.query().where('client', '==', 'Client-A').where('dueDate', 'startsWith', '2026-04-0').toArray()
    const b = plain.query().where('client', '==', 'Client-A').where('dueDate', 'startsWith', '2026-04-0').toArray()
    expect(a.length).toBeGreaterThan(0)
    expect(byId(a)).toEqual(byId(b))
  })

  it('15. a full-tuple equality match still applies any leftover clause', () => {
    const a = indexed.query().where('client', '==', 'Client-A').where('dueDate', '==', '2026-04-01')
      .where('status', '==', 'open').toArray()
    const b = plain.query().where('client', '==', 'Client-A').where('dueDate', '==', '2026-04-01')
      .where('status', '==', 'open').toArray()
    expect(byId(a)).toEqual(byId(b))
  })

  it('16. put and delete keep the compound answers in step with the scan', async () => {
    await indexed.delete('inv-005')
    await plain.delete('inv-005')
    await indexed.put('inv-006', { ...records[6]!, client: 'Client-B', dueDate: '2026-04-01' })
    await plain.put('inv-006', { ...records[6]!, client: 'Client-B', dueDate: '2026-04-01' })
    const a = indexed.query().where('client', '==', 'Client-B').orderBy('dueDate').limit(4).toArray()
    const b = plain.query().where('client', '==', 'Client-B').orderBy('dueDate').limit(4).toArray()
    expect(a.map(r => r.id)).toEqual(b.map(r => r.id))
  })
})

// ─── Dispatch proof: the compound index, not a scan, answered ──────

describe('Query — compound-index dispatch (no linear scan)', () => {
  interface Row { id: string; client: string; date: string; amount: number }

  const rows: Row[] = [
    { id: 'r1', client: 'C1', date: '2026-01-01', amount: 10 },
    { id: 'r2', client: 'C1', date: '2026-01-02', amount: 20 },
    { id: 'r3', client: 'C1', date: '2026-01-03', amount: 30 },
    { id: 'r4', client: 'C2', date: '2026-01-01', amount: 40 },
  ]

  function makeSource(data: Row[] = rows, compound = true): { source: QuerySource<Row>; scans: () => number } {
    const indexes = new CollectionIndexes()
    indexes.declare('client')
    if (compound) indexes.declareCompound(['client', 'date'])
    indexes.build(data.map(r => ({ id: r.id, record: r })))
    let scans = 0
    return {
      scans: () => scans,
      source: {
        snapshot: () => { scans++; return data },
        getIndexes: () => indexes,
        lookupById: (id: string) => data.find(r => r.id === id),
      },
    }
  }

  it('17. eq prefix + orderBy + limit is answered from the compound index', () => {
    const { source, scans } = makeSource()
    const out = new Query<Row>(source).where('client', '==', 'C1').orderBy('date', 'desc').limit(2).toArray()
    expect(out.map(r => r.id)).toEqual(['r3', 'r2'])
    // One snapshot() for the coverage guard — not a scan-and-sort.
    expect(scans()).toBe(1)
  })

  it('18. eq prefix + range is answered from the compound index', () => {
    const { source, scans } = makeSource()
    const out = new Query<Row>(source).where('client', '==', 'C1').where('date', '>', '2026-01-01').toArray()
    expect(out.map(r => r.id).sort()).toEqual(['r2', 'r3'])
    expect(scans()).toBe(1)
  })

  it('19. partial index coverage falls back to the scan', () => {
    // r5 has no `date`, so the tuple index omits it — but `sortRecords()`
    // still PLACES it. An index-served page would silently drop it, which is
    // what the coverage guard exists to prevent. The oracle is the same query
    // over a source with no compound index declared.
    const partial: Row[] = [...rows, { id: 'r5', client: 'C1', date: null as unknown as string, amount: 1 }]
    const { source, scans } = makeSource(partial)
    const { source: oracle } = makeSource(partial, false)
    for (const dir of ['asc', 'desc'] as const) {
      const a = new Query<Row>(source).where('client', '==', 'C1').orderBy('date', dir).limit(4).toArray()
      const b = new Query<Row>(oracle).where('client', '==', 'C1').orderBy('date', dir).limit(4).toArray()
      expect(a.map(r => r.id)).toContain('r5')
      expect(a.map(r => r.id)).toEqual(b.map(r => r.id))
    }
    expect(scans()).toBeGreaterThan(0)
  })

  it('19b. an in-place update keeps its rank inside a tie run', () => {
    // Every row ties on `date`, so the whole page is tie-ordered. Rewriting
    // r2 must not move it behind r3 — `snapshot()` order does not change.
    const tied: Row[] = rows.map(r => ({ ...r, client: 'C1', date: '2026-01-01' }))
    const { source } = makeSource(tied)
    const { source: oracle } = makeSource(tied, false)
    const indexes = (source.getIndexes as () => CollectionIndexes)()
    indexes.upsert('r2', { ...tied[1]!, amount: 999 }, tied[1]!)
    const a = new Query<Row>(source).where('client', '==', 'C1').orderBy('date').limit(4).toArray()
    const b = new Query<Row>(oracle).where('client', '==', 'C1').orderBy('date').limit(4).toArray()
    expect(a.map(r => r.id)).toEqual(b.map(r => r.id))
    expect(a.map(r => r.id)).toEqual(['r1', 'r2', 'r3', 'r4'])
  })

  it('20. a single equality clause is left to the hash index (no compound dispatch)', () => {
    const { source } = makeSource()
    const out = new Query<Row>(source).where('client', '==', 'C2').toArray()
    expect(out.map(r => r.id)).toEqual(['r4'])
  })
})
