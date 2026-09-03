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
