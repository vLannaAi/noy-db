import { describe, it, expect, beforeEach } from 'vitest'
import { CollectionIndexes } from '../src/with-lookup/indexing/eager-indexes.js'
import { createNoydb } from '../src/kernel/noydb.js'
import { withIndexing } from '../src/with-lookup/indexing/index.js'
import { Query } from '../src/kernel/query/builder.js'
import type { QuerySource } from '../src/kernel/query/builder.js'
import type { Noydb } from '../src/kernel/noydb.js'
import type { NoydbStore, EncryptedEnvelope, VaultSnapshot } from '../src/kernel/types.js'
import { ConflictError } from '../src/kernel/errors.js'

/** Inline memory adapter — same pattern as `query-indexes.test.ts`. */
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

interface Invoice {
  id: string
  status: 'draft' | 'open' | 'paid' | 'overdue'
  amount: number
  client: string
  dueDate: string
}

const ids = (set: ReadonlySet<string> | null): string[] => [...(set ?? [])].sort()

// ─── Unit tests for the sorted half of CollectionIndexes ───────────

describe('CollectionIndexes — sorted (unit)', () => {
  let idx: CollectionIndexes

  beforeEach(() => {
    idx = new CollectionIndexes()
    idx.declareSorted('amount')
  })

  const nums = [
    { id: 'a', record: { amount: 10 } },
    { id: 'b', record: { amount: 20 } },
    { id: 'c', record: { amount: 20 } },
    { id: 'd', record: { amount: 30 } },
  ]

  it('1. declareSorted registers a sorted field', () => {
    expect(idx.hasSorted('amount')).toBe(true)
    expect(idx.hasSorted('client')).toBe(false)
    expect(idx.sortedFields()).toEqual(['amount'])
  })

  it('2. declareSorted is idempotent', () => {
    idx.declareSorted('amount')
    expect(idx.sortedFields()).toEqual(['amount'])
  })

  it('3. lookupRange returns null for an undeclared field', () => {
    idx.build(nums)
    expect(idx.lookupRange('client', '>', 'x')).toBeNull()
  })

  it('4. > and >= on numbers', () => {
    idx.build(nums)
    expect(ids(idx.lookupRange('amount', '>', 20))).toEqual(['d'])
    expect(ids(idx.lookupRange('amount', '>=', 20))).toEqual(['b', 'c', 'd'])
  })

  it('5. < and <= on numbers', () => {
    idx.build(nums)
    expect(ids(idx.lookupRange('amount', '<', 20))).toEqual(['a'])
    expect(ids(idx.lookupRange('amount', '<=', 20))).toEqual(['a', 'b', 'c'])
  })

  it('6. between is inclusive at both ends', () => {
    idx.build(nums)
    expect(ids(idx.lookupRange('amount', 'between', [20, 30]))).toEqual(['b', 'c', 'd'])
    expect(ids(idx.lookupRange('amount', 'between', [11, 19]))).toEqual([])
  })

  it('7. startsWith over string keys', () => {
    const s = new CollectionIndexes()
    s.declareSorted('client')
    s.build([
      { id: 'a', record: { client: 'Acme' } },
      { id: 'b', record: { client: 'Acorn' } },
      { id: 'c', record: { client: 'Beta' } },
      { id: 'd', record: { client: 'Ac' } },
    ])
    expect(ids(s.lookupRange('client', 'startsWith', 'Ac'))).toEqual(['a', 'b', 'd'])
    expect(ids(s.lookupRange('client', 'startsWith', 'Z'))).toEqual([])
  })

  it('8. upsert moves an id and remove drops it', () => {
    idx.build(nums)
    idx.upsert('a', { amount: 40 }, { amount: 10 })
    expect(ids(idx.lookupRange('amount', '>', 30))).toEqual(['a'])
    expect(ids(idx.lookupRange('amount', '<', 20))).toEqual([])
    idx.remove('a', { amount: 40 })
    expect(ids(idx.lookupRange('amount', '>', 30))).toEqual([])
  })

  it('9. nullish and non-orderable values are not indexed', () => {
    const s = new CollectionIndexes()
    s.declareSorted('amount')
    s.build([
      { id: 'a', record: { amount: 10 } },
      { id: 'b', record: { amount: null } },
      { id: 'c', record: {} },
      { id: 'd', record: { amount: { nested: 1 } } },
    ])
    expect(ids(s.lookupRange('amount', '>=', 0))).toEqual(['a'])
    expect(s.sortedSize('amount')).toBe(1)
  })

  it('10. a probe of a different runtime type matches nothing (mirrors isComparable)', () => {
    idx.build(nums)
    expect(ids(idx.lookupRange('amount', '>', '5'))).toEqual([])
  })

  it('11. Date keys order chronologically', () => {
    const s = new CollectionIndexes()
    s.declareSorted('at')
    s.build([
      { id: 'a', record: { at: new Date('2026-01-01T00:00:00.000Z') } },
      { id: 'b', record: { at: new Date('2026-06-01T00:00:00.000Z') } },
    ])
    expect(ids(s.lookupRange('at', '>', new Date('2026-03-01T00:00:00.000Z')))).toEqual(['b'])
  })

  it('12. orderedIds walks the index in key order, both directions', () => {
    idx.build(nums)
    expect(idx.orderedIds('amount', 'asc')).toEqual(['a', 'b', 'c', 'd'])
    // b and c tie at 20 and keep INSERTION order in both directions —
    // `sortRecords` negates its comparator over a *stable* sort, so it
    // reverses the key order, never the order within a key.
    expect(idx.orderedIds('amount', 'desc')).toEqual(['d', 'b', 'c', 'a'])
    expect(idx.orderedIds('client', 'asc')).toBeNull()
  })

  it('13. clear() drops sorted entries but keeps the declaration', () => {
    idx.build(nums)
    idx.clear()
    expect(idx.hasSorted('amount')).toBe(true)
    expect(idx.sortedSize('amount')).toBe(0)
  })

  it('14. numbers sort numerically, not lexicographically', () => {
    const s = new CollectionIndexes()
    s.declareSorted('n')
    s.build([
      { id: 'a', record: { n: 9 } },
      { id: 'b', record: { n: 10 } },
      { id: 'c', record: { n: 100 } },
    ])
    expect(s.orderedIds('n', 'asc')).toEqual(['a', 'b', 'c'])
    expect(ids(s.lookupRange('n', '>', 9))).toEqual(['b', 'c'])
  })
})

// ─── Integration against the real Collection pipeline ──────────────

describe('Collection.query() — sorted-index execution', () => {
  const records: Invoice[] = Array.from({ length: 60 }, (_, i) => ({
    id: `inv-${String(i).padStart(3, '0')}`,
    status: (['draft', 'open', 'paid', 'overdue'] as const)[i % 4]!,
    amount: i * 10,
    client: `Client-${String.fromCharCode(65 + (i % 5))}`,
    dueDate: `2026-04-${String((i % 28) + 1).padStart(2, '0')}`,
  }))

  let indexed: Awaited<ReturnType<typeof setup>>['indexed']
  let plain: Awaited<ReturnType<typeof setup>>['plain']

  async function setup() {
    const db: Noydb = await createNoydb({
      store: toMemory(),
      user: 'owner',
      secret: 'sorted-index-test-secret-2026',
      indexingStrategy: withIndexing(),
    })
    const vault = await db.openVault('TEST')
    const indexed = vault.collection<Invoice>('indexed', {
      indexes: [
        { fields: ['amount'], kind: 'sorted' },
        { fields: ['dueDate'], kind: 'sorted' },
        { fields: ['client'], kind: 'sorted' },
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

  it('15. `>` matches the linear scan', () => {
    const a = indexed.query().where('amount', '>', 300).toArray()
    const b = plain.query().where('amount', '>', 300).toArray()
    expect(a.length).toBeGreaterThan(0)
    expect(byId(a)).toEqual(byId(b))
  })

  it('16. `between` matches the linear scan', () => {
    const a = indexed.query().where('dueDate', 'between', ['2026-04-05', '2026-04-12']).toArray()
    const b = plain.query().where('dueDate', 'between', ['2026-04-05', '2026-04-12']).toArray()
    expect(a.length).toBeGreaterThan(0)
    expect(byId(a)).toEqual(byId(b))
  })

  it('17. `startsWith` matches the linear scan', () => {
    const a = indexed.query().where('client', 'startsWith', 'Client-B').toArray()
    const b = plain.query().where('client', 'startsWith', 'Client-B').toArray()
    expect(a.length).toBeGreaterThan(0)
    expect(byId(a)).toEqual(byId(b))
  })

  it('18. a range clause combined with another clause still filters correctly', () => {
    const a = indexed.query().where('amount', '>=', 200).where('status', '==', 'open').toArray()
    const b = plain.query().where('amount', '>=', 200).where('status', '==', 'open').toArray()
    expect(a.length).toBeGreaterThan(0)
    expect(byId(a)).toEqual(byId(b))
  })

  it('19. orderBy + limit matches the linear scan', () => {
    for (const dir of ['asc', 'desc'] as const) {
      const a = indexed.query().orderBy('amount', dir).limit(5).toArray()
      const b = plain.query().orderBy('amount', dir).limit(5).toArray()
      expect(a.map(r => r.id)).toEqual(b.map(r => r.id))
    }
  })

  it('20. orderBy + offset + limit matches the linear scan', () => {
    const a = indexed.query().orderBy('dueDate', 'asc').offset(7).limit(4).toArray()
    const b = plain.query().orderBy('dueDate', 'asc').offset(7).limit(4).toArray()
    expect(a.map(r => r.id)).toEqual(b.map(r => r.id))
  })

  it('20b. orderBy desc over a field WITH TIES matches the linear scan', () => {
    // dueDate repeats every 28 records, so the top page is all ties —
    // the case a naive `reverse()` of the index would get wrong.
    const a = indexed.query().orderBy('dueDate', 'desc').limit(6).toArray()
    const b = plain.query().orderBy('dueDate', 'desc').limit(6).toArray()
    expect(a.map(r => r.id)).toEqual(b.map(r => r.id))
  })

  it('21. the sorted index tracks put and delete', async () => {
    await indexed.delete('inv-059') // amount 590, the max
    expect(indexed.query().where('amount', '>', 570).toArray().map(r => r.id)).toEqual(['inv-058'])
    await indexed.put('inv-058', { ...records[58]!, amount: 5 })
    expect(indexed.query().where('amount', '>', 570).toArray()).toEqual([])
    expect(indexed.query().where('amount', '<', 10).toArray().map(r => r.id).sort()).toEqual(['inv-000', 'inv-058'])
  })
})

// ─── Dispatch proof: the index, not a scan, answered the query ─────
//
// `candidateRecords()` / the ordered fast path only touch `snapshot()`
// when they FALL BACK to a linear scan, so a source that counts
// snapshot() calls witnesses which path ran.

describe('Query — sorted-index dispatch (no linear scan)', () => {
  interface Row { id: string; amount: number; name: string }

  function makeSource(): { source: QuerySource<Row>; scans: () => number } {
    const rows: Row[] = [
      { id: 'r1', amount: 10, name: 'alpha' },
      { id: 'r2', amount: 20, name: 'alfa' },
      { id: 'r3', amount: 30, name: 'beta' },
      { id: 'r4', amount: 40, name: 'gamma' },
    ]
    const indexes = new CollectionIndexes()
    indexes.declareSorted('amount')
    indexes.declareSorted('name')
    indexes.build(rows.map(r => ({ id: r.id, record: r })))
    let scans = 0
    return {
      scans: () => scans,
      source: {
        snapshot: () => { scans++; return rows },
        getIndexes: () => indexes,
        lookupById: (id: string) => rows.find(r => r.id === id),
      },
    }
  }

  it('22. a lone range clause is answered from the index', () => {
    const { source, scans } = makeSource()
    const out = new Query<Row>(source).where('amount', '>=', 30).toArray()
    expect(out.map(r => r.id).sort()).toEqual(['r3', 'r4'])
    expect(scans()).toBe(0)
  })

  it('23. a lone startsWith clause is answered from the index', () => {
    const { source, scans } = makeSource()
    const out = new Query<Row>(source).where('name', 'startsWith', 'al').toArray()
    expect(out.map(r => r.id).sort()).toEqual(['r1', 'r2'])
    expect(scans()).toBe(0)
  })

  it('24. orderBy + limit is answered from the index', () => {
    const { source, scans } = makeSource()
    const out = new Query<Row>(source).orderBy('amount', 'desc').limit(2).toArray()
    expect(out.map(r => r.id)).toEqual(['r4', 'r3'])
    // The ordered fast path checks index coverage against the snapshot
    // size, so exactly one snapshot() call is expected — not a scan+sort.
    expect(scans()).toBe(1)
  })

  it('25. an unindexed range clause still falls back to the scan', () => {
    const { source, scans } = makeSource()
    const out = new Query<Row>(source).where('id', '>', 'r2').toArray()
    expect(out.map(r => r.id).sort()).toEqual(['r3', 'r4'])
    expect(scans()).toBeGreaterThan(0)
  })
})
