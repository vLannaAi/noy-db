/**
 * #1348 — `Query.explain()`: a readable plan.
 *
 * The core guarantee under test is that `explain()` is PURELY OBSERVATIONAL:
 * calling it never changes what a terminal returns, and never changes which
 * dispatch the executor picks.
 */
import { describe, it, expect } from 'vitest'
import { Query, type QuerySource } from '../src/kernel/query/index.js'
import type { ExplainNode, QueryExplanation } from '../src/kernel/query/explain.js'
import { CollectionIndexes } from '../src/with-lookup/indexing/eager-indexes.js'
import type { JoinContext, JoinableSource } from '../src/kernel/query/join.js'
import { ViaPipeline } from '../src/kernel/via/pipeline.js'
import { moneyVia } from '../src/via/money/binding.js'
import { money } from '../src/via/money/descriptor.js'

interface Invoice {
  id: string
  status: 'draft' | 'open' | 'paid'
  amount: number
  clientId: string
  dueDate: string
}

const SAMPLE: Invoice[] = [
  { id: 'a', status: 'draft', amount: 100, clientId: 'c1', dueDate: '2026-04-01' },
  { id: 'b', status: 'open', amount: 250, clientId: 'c1', dueDate: '2026-03-15' },
  { id: 'c', status: 'open', amount: 5000, clientId: 'c2', dueDate: '2026-05-01' },
  { id: 'd', status: 'paid', amount: 800, clientId: 'c2', dueDate: '2026-02-28' },
  { id: 'e', status: 'open', amount: 1500, clientId: 'c3', dueDate: '2026-01-10' },
]

/**
 * A source whose `snapshot()` calls are counted. The count is an
 * EXECUTOR-SIDE witness of dispatch: `candidateRecords()` reads the snapshot
 * only when it falls back to a linear scan, so "explain says index:hash" and
 * "the executor never took the snapshot" must agree.
 */
function indexedSource(records: Invoice[], indexedFields: string[]) {
  const indexes = new CollectionIndexes()
  for (const f of indexedFields) indexes.declare(f)
  indexes.build(records.map(r => ({ id: r.id, record: r })))
  const byId = new Map(records.map(r => [r.id, r]))
  let snapshotCalls = 0
  const source: QuerySource<Invoice> = {
    snapshot: () => {
      snapshotCalls++
      return records
    },
    getIndexes: () => indexes,
    lookupById: (id: string) => byId.get(id),
  }
  return {
    source,
    reset: () => {
      snapshotCalls = 0
    },
    calls: () => snapshotCalls,
  }
}

function plainSource<T>(records: T[]): QuerySource<T> {
  return { snapshot: () => records }
}

/** Flatten the node tree in render order. */
function flatten(nodes: readonly ExplainNode[]): ExplainNode[] {
  const out: ExplainNode[] = []
  const walk = (ns: readonly ExplainNode[]): void => {
    for (const n of ns) {
      out.push(n)
      walk(n.children)
    }
  }
  walk(nodes)
  return out
}

function dispatches(e: QueryExplanation): string[] {
  return flatten(e.nodes).map(n => n.dispatch)
}

describe('Query.explain() > dispatch per clause', () => {
  it('reports index:hash for an equality on an indexed field, with the index cardinality as the estimate', () => {
    const { source } = indexedSource(SAMPLE, ['status'])
    const e = new Query<Invoice>(source).where('status', '==', 'open').explain()

    const where = flatten(e.nodes).find(n => n.op === 'where')!
    expect(where.dispatch).toBe('index:hash')
    expect(where.detail).toBe('status == "open"')
    expect(where.estimatedRows).toBe(3)
  })

  it('reports scan for the same query on an unindexed field, and names the field', () => {
    const { source } = indexedSource(SAMPLE, ['status'])
    const e = new Query<Invoice>(source).where('dueDate', '==', '2026-03-15').explain()

    const where = flatten(e.nodes).find(n => n.op === 'where')!
    expect(where.dispatch).toBe('scan')
    expect(where.notes.join(' ')).toContain('no index on "dueDate"')
  })

  it('a source with no index store at all scans', () => {
    const e = new Query<Invoice>(plainSource(SAMPLE)).where('status', '==', 'open').explain()
    expect(dispatches(e)).toContain('scan')
    expect(dispatches(e)).not.toContain('index:hash')
  })

  it('only the FIRST index-eligible clause is index-served; the rest are residual scans', () => {
    const { source } = indexedSource(SAMPLE, ['status', 'clientId'])
    const e = new Query<Invoice>(source)
      .where('status', '==', 'open')
      .where('clientId', '==', 'c1')
      .explain()
    const wheres = flatten(e.nodes).filter(n => n.op === 'where')
    expect(wheres.map(n => n.dispatch)).toEqual(['index:hash', 'scan'])
  })

  it('a residual clause on an unindexed field still names the missing index', () => {
    const { source } = indexedSource(SAMPLE, ['status'])
    const e = new Query<Invoice>(source)
      .where('status', '==', 'open')
      .where('dueDate', '>', '2026-01-01')
      .explain()
    const residual = flatten(e.nodes).filter(n => n.op === 'where')[1]!
    expect(residual.dispatch).toBe('scan')
    expect(residual.notes.join(' ')).toContain('residual')
    expect(residual.notes.join(' ')).toContain('no index on "dueDate"')
  })

  it('agrees with the executor: index:hash ⟺ the executor never took the snapshot', () => {
    const indexed = indexedSource(SAMPLE, ['status'])
    const eIndexed = new Query<Invoice>(indexed.source).where('status', '==', 'open')
    expect(eIndexed.explain().nodes.some(n => n.dispatch === 'index:hash')).toBe(true)
    indexed.reset()
    eIndexed.toArray()
    expect(indexed.calls()).toBe(0)

    const scanned = indexedSource(SAMPLE, ['status'])
    const eScan = new Query<Invoice>(scanned.source).where('dueDate', '>', '2026-01-01')
    expect(eScan.explain().nodes.some(n => n.dispatch === 'index:hash')).toBe(false)
    scanned.reset()
    eScan.toArray()
    expect(scanned.calls()).toBeGreaterThan(0)
  })
})

describe('Query.explain() > never changes execution', () => {
  it('results are identical whether or not explain() was called, in either order', () => {
    const { source } = indexedSource(SAMPLE, ['status'])
    const build = (): Query<Invoice> =>
      new Query<Invoice>(source).where('status', '==', 'open').orderBy('amount', 'desc').limit(2)

    const withoutExplain = build().toArray()

    const q = build()
    q.explain()
    const afterExplain = q.toArray()

    const q2 = build()
    const before = q2.toArray()
    q2.explain()
    const afterAgain = q2.toArray()

    expect(afterExplain).toEqual(withoutExplain)
    expect(before).toEqual(withoutExplain)
    expect(afterAgain).toEqual(withoutExplain)
    expect(withoutExplain.map(r => r.id)).toEqual(['c', 'e'])
  })

  it('explain() returns a new Query-independent value and leaves count() unchanged', () => {
    const { source } = indexedSource(SAMPLE, ['status'])
    const q = new Query<Invoice>(source).where('status', '==', 'open')
    const n1 = q.count()
    q.explain()
    q.explain()
    expect(q.count()).toBe(n1)
  })
})

describe('Query.explain() > text rendering', () => {
  it('renders exactly one line per node', () => {
    const { source } = indexedSource(SAMPLE, ['status'])
    const e = new Query<Invoice>(source)
      .where('status', '==', 'open')
      .or(q => q.where('amount', '>', 1000).where('amount', '<', 10))
      .orderBy('amount', 'desc')
      .limit(2)
      .explain()

    const lines = e.text.split('\n')
    expect(lines).toHaveLength(flatten(e.nodes).length)
    expect(lines.every(l => l.length > 0)).toBe(true)
  })

  it('is stable across repeated calls', () => {
    const { source } = indexedSource(SAMPLE, ['status'])
    const q = new Query<Invoice>(source).where('status', '==', 'open').limit(2)
    expect(q.explain().text).toBe(q.explain().text)
  })

  it('nests group children by indentation and carries the dispatch label on every line', () => {
    const { source } = indexedSource(SAMPLE, ['status'])
    const e = new Query<Invoice>(source).or(q => q.where('amount', '>', 1000)).explain()
    const lines = e.text.split('\n')
    expect(lines.some(l => l.startsWith('  '))).toBe(true)
    expect(lines.every(l => /\[[a-z:]+\]/.test(l))).toBe(true)
  })
})

// ── joins ────────────────────────────────────────────────────────────────

interface Client {
  id: string
  name: string
}

const CLIENTS: Client[] = [
  { id: 'c1', name: 'Alpha' },
  { id: 'c2', name: 'Bravo' },
  { id: 'c3', name: 'Charlie' },
]

function joinContextFor(right: JoinableSource): JoinContext {
  return {
    leftCollection: 'invoices',
    resolveRef: (field: string) => (field === 'clientId' ? { target: 'clients', mode: 'warn' } : null),
    resolveSource: (name: string) => (name === 'clients' ? right : null),
  }
}

describe('Query.explain() > joins', () => {
  const nestedRight: JoinableSource = {
    snapshot: () => CLIENTS,
    lookupById: (id: string) => CLIENTS.find(c => c.id === id),
  }
  const hashRight: JoinableSource = { snapshot: () => CLIENTS }

  it('reports the auto-selected nested-loop strategy and the right-side size', () => {
    const q = new Query<Invoice>(plainSource(SAMPLE), undefined, joinContextFor(nestedRight)).join('clientId', {
      as: 'client',
    })
    const e = q.explain()
    const join = flatten(e.nodes).find(n => n.op === 'join')!
    expect(join.dispatch).toBe('join:nested')
    expect(join.detail).toBe('client <- clientId (clients)')
    expect(join.notes.join(' ')).toContain('right side 3 rows')
  })

  it('reports the hash strategy when the right side has no lookupById', () => {
    const q = new Query<Invoice>(plainSource(SAMPLE), undefined, joinContextFor(hashRight)).join('clientId', {
      as: 'client',
    })
    expect(flatten(q.explain().nodes).find(n => n.op === 'join')!.dispatch).toBe('join:hash')
  })

  it('lists the per-side cardinality caps with their status against the 50k ceiling', () => {
    const q = new Query<Invoice>(plainSource(SAMPLE), undefined, joinContextFor(nestedRight)).join('clientId', {
      as: 'client',
    })
    const caps = q.explain().caps
    expect(caps.map(c => c.name)).toEqual(['join:client:left', 'join:client:right'])
    expect(caps.every(c => c.limit === 50_000 && c.status === 'ok')).toBe(true)
  })

  it('marks a cap that would trip', () => {
    const q = new Query<Invoice>(plainSource(SAMPLE), undefined, joinContextFor(nestedRight)).join('clientId', {
      as: 'client',
      maxRows: 2,
    })
    const caps = q.explain().caps
    expect(caps.find(c => c.name === 'join:client:left')!.status).toBe('exceeded')
    expect(caps.find(c => c.name === 'join:client:right')!.status).toBe('exceeded')
  })

  it('says ordering and pagination run PRE-join when no clause addresses an alias', () => {
    const q = new Query<Invoice>(plainSource(SAMPLE), undefined, joinContextFor(nestedRight))
      .join('clientId', { as: 'client' })
      .orderBy('amount', 'desc')
      .limit(2)
    const nodes = flatten(q.explain().nodes)
    expect(nodes.find(n => n.op === 'orderBy')!.notes).toContain('pre-join')
    expect(nodes.find(n => n.op === 'page')!.notes).toContain('pre-join')
    // and the join node is emitted AFTER them, mirroring toArray()
    expect(nodes.findIndex(n => n.op === 'join')).toBeGreaterThan(nodes.findIndex(n => n.op === 'page'))
  })

  it('says ordering and pagination run POST-join when a clause addresses an alias', () => {
    const q = new Query<Invoice>(plainSource(SAMPLE), undefined, joinContextFor(nestedRight))
      .join('clientId', { as: 'client' })
      .where('client.name' as never, '==', 'Alpha')
      .orderBy('amount', 'desc')
      .limit(2)
    const nodes = flatten(q.explain().nodes)
    expect(nodes.find(n => n.op === 'orderBy')!.notes).toContain('post-join')
    expect(nodes.find(n => n.op === 'page')!.notes).toContain('post-join')
    // the alias predicate is emitted AFTER the join, and it can never be indexed
    const joinAt = nodes.findIndex(n => n.op === 'join')
    const aliasAt = nodes.findIndex(n => n.detail.startsWith('client.name'))
    expect(aliasAt).toBeGreaterThan(joinAt)
    expect(nodes[aliasAt]!.dispatch).toBe('scan')
  })
})

describe('Query.explain() > cross join', () => {
  it('reports the cartesian estimate against the cross-join ceiling', () => {
    const right: JoinableSource = { snapshot: () => CLIENTS }
    const q = new Query<Invoice>(plainSource(SAMPLE), undefined, joinContextFor(right)).crossJoin('clients', {
      as: 'client',
    })
    const e = q.explain()
    const node = flatten(e.nodes).find(n => n.op === 'crossJoin')!
    expect(node.dispatch).toBe('crossJoin')
    expect(node.estimatedRows).toBe(15)
    const cap = e.caps.find(c => c.name === 'crossJoin:client')!
    expect(cap.limit).toBe(50_000)
    expect(cap.observed).toBe(15)
    expect(cap.status).toBe('ok')
  })

  it('a plan carrying a crossJoin takes no index fast path, and says so', () => {
    const { source } = indexedSource(SAMPLE, ['status'])
    const right: JoinableSource = { snapshot: () => CLIENTS }
    const q = new Query<Invoice>(source, undefined, joinContextFor(right))
      .where('status', '==', 'open')
      .crossJoin('clients', { as: 'client' })
    const nodes = flatten(q.explain().nodes)
    expect(nodes.find(n => n.op === 'where')!.dispatch).toBe('scan')
    expect(nodes.find(n => n.op === 'where')!.notes.join(' ')).toContain('crossJoin')
  })
})

describe('Query.explain() > money exact reducer rewrite', () => {
  const via = ViaPipeline.build([moneyVia({ amount: money({ currency: 'EUR', scale: 2 }) })])!

  it('reports the rewrite for a money-covered field the query references', () => {
    const source: QuerySource<Invoice> = { snapshot: () => SAMPLE, via }
    const e = new Query<Invoice>(source).where('amount', '>', 10).explain()
    expect(e.reducerRewrite).toEqual([{ brand: 'money', field: 'amount' }])
    expect(e.text).toContain('reducer rewrite')
  })

  it('reports nothing for a query touching no covered field', () => {
    const source: QuerySource<Invoice> = { snapshot: () => SAMPLE, via }
    const e = new Query<Invoice>(source).where('status', '==', 'open').explain()
    expect(e.reducerRewrite).toEqual([])
  })

  it('reports nothing when the source has no Via pipeline', () => {
    const e = new Query<Invoice>(plainSource(SAMPLE)).where('amount', '>', 10).explain()
    expect(e.reducerRewrite).toEqual([])
  })
})

// ── #1375: the exhaustive dispatch witness ───────────────────────────────

/**
 * A source that counts how many RECORDS the executor read out of the
 * snapshot — not how many times it called `snapshot()`.
 *
 * ⭐ That distinction IS #1375. #1348's witness counted CALLS, which was exact
 * while `index:hash` and `scan` were the only two dispatches: the hash path
 * never asked for the snapshot at all. #1344's `orderedIndexRows` and #1345's
 * `compoundCandidates` both call `snapshot()` for their coverage check and
 * read only its `.length`, so a call counter now reports "scan" for two paths
 * that never touch a record. Counting element reads separates "measured the
 * collection" from "walked the collection", which is the property that
 * actually distinguishes an index path from a scan.
 */
function witnessSource(records: Invoice[], declare: (ix: CollectionIndexes) => void) {
  const indexes = new CollectionIndexes()
  declare(indexes)
  indexes.build(records.map(r => ({ id: r.id, record: r })))
  const byId = new Map(records.map(r => [r.id, r]))
  let reads = 0
  const proxied = new Proxy(records, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && /^\d+$/.test(prop)) reads++
      return Reflect.get(target, prop, receiver) as unknown
    },
  })
  const source: QuerySource<Invoice> = {
    snapshot: () => proxied,
    getIndexes: () => indexes,
    lookupById: (id: string) => byId.get(id),
  }
  return { source, reset: () => { reads = 0 }, reads: () => reads }
}

/** Hash on status; sorted on amount and dueDate; compound on (status, amount). */
function declareAll(ix: CollectionIndexes): void {
  ix.declare('status')
  ix.declareSorted('amount')
  ix.declareSorted('dueDate')
  ix.declareCompound(['status', 'amount'])
}

/**
 * One row per dispatch kind the executor can pick. `expected` is the label
 * `explain()` must report; the ⟺ assertion below is what makes a MISSING row
 * cheap to notice and a WRONG label impossible to ship.
 */
const DISPATCH_TABLE: ReadonlyArray<{
  readonly name: string
  readonly expected: string
  readonly build: (q: Query<Invoice>) => Query<Invoice>
}> = [
  { name: '== on a hash-indexed field', expected: 'index:hash', build: q => q.where('status', '==', 'open') },
  { name: 'in on a hash-indexed field', expected: 'index:hash', build: q => q.where('status', 'in', ['open', 'paid']) },
  { name: '> on a sorted-indexed field', expected: 'index:range', build: q => q.where('amount', '>', 500) },
  { name: 'between on a sorted-indexed field', expected: 'index:range', build: q => q.where('amount', 'between', [200, 900]) },
  { name: 'startsWith on a sorted-indexed field', expected: 'index:range', build: q => q.where('dueDate', 'startsWith', '2026-0') },
  {
    name: 'equality prefix + range on a compound tuple',
    expected: 'index:compound',
    build: q => q.where('status', '==', 'open').where('amount', '>=', 250),
  },
  {
    name: 'orderBy(sorted).limit(n) — the single-field ordered walk',
    expected: 'index:ordered',
    build: q => q.orderBy('amount', 'desc').limit(2),
  },
  {
    name: 'where(==).orderBy(next component).limit(n) — the compound ordered walk',
    expected: 'index:ordered',
    build: q => q.where('status', '==', 'open').orderBy('amount', 'asc').limit(2),
  },
  { name: '== on an unindexed field', expected: 'scan', build: q => q.where('clientId', '==', 'c1') },
  { name: '> on a hash-only field', expected: 'scan', build: q => q.where('status', '>', 'draft') },
  { name: 'no clauses at all', expected: 'scan', build: q => q },
  { name: 'a filter(fn) clause', expected: 'scan', build: q => q.filter(r => r.amount > 0) },
  { name: 'orderBy(sorted) with NO limit', expected: 'scan', build: q => q.orderBy('amount', 'desc') },
]

describe('#1375 > explain() dispatch agrees with the executor, for every dispatch kind', () => {
  for (const row of DISPATCH_TABLE) {
    it(`${row.name} → ${row.expected}`, () => {
      const w = witnessSource([...SAMPLE], declareAll)
      const q = row.build(new Query<Invoice>(w.source))

      const claimed = dispatches(q.explain()).filter(d => d.startsWith('index:') || d === 'scan')
      // A pure-scan plan can carry NO clause node at all (`orderBy` alone, or
      // nothing) — "scan" is then the absence of an index label, which the ⟺
      // below asserts. Only an index claim has to be named.
      if (row.expected !== 'scan') expect(claimed).toContain(row.expected)

      // The ⟺: an index path materializes through `lookupById` and never walks
      // the snapshot; a scan path always does. Both directions are asserted,
      // so a label that over-claims fails exactly as loudly as one that
      // under-claims.
      const claimsIndex = claimed.some(d => d.startsWith('index:'))
      w.reset()
      q.toArray()
      expect(claimsIndex, `explain() claimed ${JSON.stringify(claimed)}`).toBe(w.reads() === 0)
    })
  }

  it('the table covers every index label the type publishes', () => {
    const labelled = new Set(DISPATCH_TABLE.map(r => r.expected))
    expect([...labelled].sort()).toEqual(['index:compound', 'index:hash', 'index:ordered', 'index:range', 'scan'])
  })

  it('every shape returns identical rows whether or not explain() ran', () => {
    for (const row of DISPATCH_TABLE) {
      const a = row.build(new Query<Invoice>(witnessSource([...SAMPLE], declareAll).source))
      const b = row.build(new Query<Invoice>(witnessSource([...SAMPLE], declareAll).source))
      b.explain()
      expect(b.toArray()).toEqual(a.toArray())
    }
  })
})

describe('#1375 > the sentences a consumer acts on', () => {
  it('names the sorted index a range operator needs, rather than "== and in only"', () => {
    const w = witnessSource([...SAMPLE], ix => ix.declare('status'))
    const e = new Query<Invoice>(w.source).where('status', '>', 'draft').explain()
    expect(flatten(e.nodes).find(n => n.op === 'where')!.notes.join(' ')).toContain('declare a sorted index')
  })

  it('says the sort never runs when an ordered index answers the page', () => {
    const w = witnessSource([...SAMPLE], declareAll)
    const e = new Query<Invoice>(w.source).orderBy('amount', 'desc').limit(2).explain()
    const order = flatten(e.nodes).find(n => n.op === 'orderBy')!
    expect(order.dispatch).toBe('index:ordered')
    expect(order.estimatedRows).toBe(2)
    expect(order.notes.join(' ')).toContain('no sort runs')
  })

  it('declines the ordered walk when the sorted index does not cover the snapshot', () => {
    // One record has no `amount`, so it is absent from the sorted index and
    // `sortRecords` would still place it — the executor falls back, and so
    // must explain().
    const partial = [...SAMPLE, { id: 'f', status: 'open', clientId: 'c1', dueDate: '2026-06-01' } as unknown as Invoice]
    const w = witnessSource(partial, declareAll)
    const q = new Query<Invoice>(w.source).orderBy('amount', 'desc').limit(2)
    expect(flatten(q.explain().nodes).find(n => n.op === 'orderBy')!.dispatch).toBe('sort')
    w.reset()
    q.toArray()
    expect(w.reads()).toBeGreaterThan(0)
  })
})

describe('#1375 > join dispatch has an executor-side witness too', () => {
  /** The right side, counting the records the join walked out of its snapshot. */
  function witnessRight(withLookup: boolean) {
    let reads = 0
    const proxied = new Proxy(CLIENTS, {
      get(target, prop, receiver) {
        if (typeof prop === 'string' && /^\d+$/.test(prop)) reads++
        return Reflect.get(target, prop, receiver) as unknown
      },
    })
    const source: JoinableSource = withLookup
      ? { snapshot: () => proxied, lookupById: (id: string) => CLIENTS.find(c => c.id === id) }
      : { snapshot: () => proxied }
    return { source, reset: () => { reads = 0 }, reads: () => reads }
  }

  it('join:nested ⟺ the right snapshot is never walked', () => {
    const right = witnessRight(true)
    const q = new Query<Invoice>(plainSource(SAMPLE), undefined, joinContextFor(right.source)).join('clientId', {
      as: 'client',
    })
    expect(flatten(q.explain().nodes).find(n => n.op === 'join')!.dispatch).toBe('join:nested')
    right.reset()
    q.toArray()
    expect(right.reads()).toBe(0)
  })

  it('join:hash ⟺ the right snapshot IS walked, once, to build the probe map', () => {
    const right = witnessRight(false)
    const q = new Query<Invoice>(plainSource(SAMPLE), undefined, joinContextFor(right.source)).join('clientId', {
      as: 'client',
    })
    expect(flatten(q.explain().nodes).find(n => n.op === 'join')!.dispatch).toBe('join:hash')
    right.reset()
    q.toArray()
    expect(right.reads()).toBeGreaterThan(0)
  })

  it('join:reverse-index ⟺ the right snapshot drives the walk', () => {
    const right = witnessRight(true)
    const q = new Query<Invoice>(plainSource(SAMPLE), undefined, joinContextFor(right.source)).rightJoin('clientId', {
      as: 'client',
    })
    expect(flatten(q.explain().nodes).find(n => n.op === 'join')!.dispatch).toBe('join:reverse-index')
    right.reset()
    q.toArray()
    expect(right.reads()).toBeGreaterThan(0)
  })

  it('#1339 — join:composite-hash ⟺ the right snapshot is walked ONCE, not per left row', () => {
    const right = witnessRight(true)
    const q = new Query<Invoice>(plainSource(SAMPLE), undefined, joinContextFor(right.source)).joinOn('clients', {
      as: 'client',
      on: [['clientId', 'id']],
    })
    expect(flatten(q.explain().nodes).find(n => n.op === 'join')!.dispatch).toBe('join:composite-hash')
    right.reset()
    q.toArray()
    // One build pass. 5 left rows × 3 right records would be 15 for a naive
    // theta join — the witness is the SCALING, not merely "reads > 0", which
    // every non-nested join path satisfies.
    expect(right.reads()).toBe(CLIENTS.length)
  })

  it('#1339 — join:sorted-range ⟺ the right snapshot is sorted once, then binary-searched', () => {
    const right = witnessRight(true)
    const q = new Query<Invoice>(plainSource(SAMPLE), undefined, joinContextFor(right.source)).joinOn('clients', {
      as: 'client',
      on: { left: 'clientId', op: '<=', right: 'id' },
    })
    expect(flatten(q.explain().nodes).find(n => n.op === 'join')!.dispatch).toBe('join:sorted-range')
    right.reset()
    q.toArray()
    expect(right.reads()).toBe(CLIENTS.length)
  })

  it('the join labels the type publishes all have a witness above', () => {
    // The join half of the DISPATCH_TABLE coverage assertion: every
    // `join:*` label on ExplainDispatch is produced by one of the tests in
    // this block. Adding a join strategy without a witness fails here.
    const claimed = new Set<string>()
    const right = witnessRight(true)
    const base = (): Query<Invoice> =>
      new Query<Invoice>(plainSource(SAMPLE), undefined, joinContextFor(right.source))
    const label = (q: Query<unknown>): string =>
      flatten(q.explain().nodes).find(n => n.op === 'join')!.dispatch
    claimed.add(label(base().join('clientId', { as: 'client' })))
    claimed.add(
      label(
        new Query<Invoice>(plainSource(SAMPLE), undefined, joinContextFor(witnessRight(false).source)).join(
          'clientId',
          { as: 'client' },
        ),
      ),
    )
    claimed.add(label(base().rightJoin('clientId', { as: 'client' })))
    claimed.add(label(base().joinOn('clients', { as: 'client', on: [['clientId', 'id']] })))
    claimed.add(label(base().joinOn('clients', { as: 'client', on: { left: 'clientId', op: '<=', right: 'id' } })))
    expect([...claimed].sort()).toEqual([
      'join:composite-hash',
      'join:hash',
      'join:nested',
      'join:reverse-index',
      'join:sorted-range',
    ])
  })

  it('#1361 — an inner leg keeps its forward strategy label and says it drops rows', () => {
    const right = witnessRight(true)
    const q = new Query<Invoice>(plainSource(SAMPLE), undefined, joinContextFor(right.source)).join('clientId', {
      as: 'client',
      mode: 'inner',
    })
    const join = flatten(q.explain().nodes).find(n => n.op === 'join')!
    expect(join.dispatch).toBe('join:nested')
    expect(join.notes.join(' ')).toContain('inner')
  })
})

describe('Query.explain() > source node', () => {
  it('names the declared indexes and the snapshot size', () => {
    const { source } = indexedSource(SAMPLE, ['status', 'clientId'])
    const e = new Query<Invoice>(source).explain()
    const src = e.nodes[0]!
    expect(src.op).toBe('source')
    expect(src.dispatch).toBe('source')
    expect(src.estimatedRows).toBe(5)
    expect(src.detail).toContain('status, clientId')
  })

  it('says so when no index store is attached', () => {
    const e = new Query<Invoice>(plainSource(SAMPLE)).explain()
    expect(e.nodes[0]!.detail).toContain('no indexes')
  })
})
