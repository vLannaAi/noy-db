/**
 * #1351 — a `Query` as the operand of `in` / `!in` (semi-join / anti-semi-join).
 *
 * Two properties carry the feature and both are witnessed by COUNTERS, not by
 * inspection:
 *   - the inner query is evaluated ONCE (at `where()` time), never per record;
 *   - the outer `in` still takes the hash-index fast path, so the executor
 *     never touches the outer snapshot.
 */
import { describe, it, expect } from 'vitest'
import { Query, type QuerySource } from '../src/kernel/query/index.js'
import { CollectionIndexes } from '../src/with-lookup/indexing/eager-indexes.js'
import { summarizeQueryPlan } from '../src/with-formula/materialized-views/dependency-analyzer.js'

interface Invoice {
  id: string
  clientId?: string
  amount: number
}

interface Client {
  id: string
  region: string
}

const INVOICES: Invoice[] = [
  { id: 'i1', clientId: 'c1', amount: 100 },
  { id: 'i2', clientId: 'c2', amount: 200 },
  { id: 'i3', clientId: 'c3', amount: 300 },
  { id: 'i4', amount: 400 }, // no clientId at all — the nullish case
]

const CLIENTS: Client[] = [
  { id: 'c1', region: 'north' },
  { id: 'c2', region: 'south' },
  { id: 'c3', region: 'north' },
]

/** Outer source: hash-indexed on `clientId`, snapshot() reads counted. */
function indexedInvoices(records: Invoice[] = INVOICES) {
  const indexes = new CollectionIndexes()
  indexes.declare('clientId')
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
    identity: 'v/invoices',
  }
  return { source, calls: () => snapshotCalls }
}

/**
 * Inner source: collection-shaped (`snapshotEntries`). Every id projection
 * goes through `snapshotEntries()` exactly once, so counting that call counts
 * inner-query EVALUATIONS.
 */
function clientsSource(records: Client[] = CLIENTS) {
  const entries = records.map(r => ({ id: r.id, record: r }))
  let evals = 0
  const source: QuerySource<Client> = {
    snapshot: () => records,
    snapshotEntries: () => {
      evals++
      return entries
    },
    identity: 'v/clients',
  }
  return { source, evals: () => evals }
}

function invoiceQuery(source: QuerySource<Invoice>): Query<Invoice> {
  return new Query<Invoice>(source)
}

describe('#1351 subquery as an `in` operand', () => {
  it('selects the rows whose field is in the inner query result', () => {
    const inner = new Query<Client>(clientsSource().source).where('region', '==', 'north')
    const rows = invoiceQuery(indexedInvoices().source).where('clientId', 'in', inner).toArray()
    expect(rows.map(r => r.id).sort()).toEqual(['i1', 'i3'])
  })

  it('anti-semi-joins with `!in`', () => {
    const inner = new Query<Client>(clientsSource().source).where('region', '==', 'north')
    const rows = invoiceQuery(indexedInvoices().source).where('clientId', '!in', inner).toArray()
    // i2 (c2, south) plus i4, whose clientId is absent — see the nullish test.
    expect(rows.map(r => r.id)).toEqual(['i2', 'i4'])
  })

  it('an EMPTY inner result yields no rows for `in`', () => {
    const inner = new Query<Client>(clientsSource().source).where('region', '==', 'atlantis')
    const rows = invoiceQuery(indexedInvoices().source).where('clientId', 'in', inner).toArray()
    expect(rows).toEqual([])
  })

  it('an EMPTY inner result yields ALL rows for `!in`', () => {
    const inner = new Query<Client>(clientsSource().source).where('region', '==', 'atlantis')
    const rows = invoiceQuery(indexedInvoices().source).where('clientId', '!in', inner).toArray()
    expect(rows.map(r => r.id)).toEqual(['i1', 'i2', 'i3', 'i4'])
  })

  it('`!in` INCLUDES a row whose field is nullish — `!=` semantics, not SQL', () => {
    const rows = invoiceQuery(indexedInvoices().source).where('clientId', '!in', ['c1']).toArray()
    expect(rows.map(r => r.id)).toEqual(['i2', 'i3', 'i4'])
  })

  it('evaluates the inner query exactly ONCE, however often the outer runs', () => {
    const clients = clientsSource()
    const inner = new Query<Client>(clients.source).where('region', '==', 'north')
    expect(clients.evals()).toBe(0)
    const outer = invoiceQuery(indexedInvoices().source).where('clientId', 'in', inner)
    expect(clients.evals()).toBe(1)
    outer.toArray()
    outer.toArray()
    outer.count()
    expect(clients.evals()).toBe(1)
  })

  it('keeps the hash-index fast path — the outer snapshot is never read', () => {
    const invoices = indexedInvoices()
    const inner = new Query<Client>(clientsSource().source).where('region', '==', 'north')
    const rows = invoiceQuery(invoices.source).where('clientId', 'in', inner).toArray()
    expect(rows.map(r => r.id).sort()).toEqual(['i1', 'i3'])
    expect(invoices.calls()).toBe(0)
  })

  it('a literal array operand still behaves identically', () => {
    const invoices = indexedInvoices()
    const rows = invoiceQuery(invoices.source).where('clientId', 'in', ['c1', 'c3']).toArray()
    expect(rows.map(r => r.id).sort()).toEqual(['i1', 'i3'])
    expect(invoices.calls()).toBe(0)
  })

  it('explain() names the subquery and still reports index:hash', () => {
    const inner = new Query<Client>(clientsSource().source).where('region', '==', 'north')
    const ex = invoiceQuery(indexedInvoices().source).where('clientId', 'in', inner).explain()
    const node = ex.nodes.find(n => n.op === 'where')
    expect(node?.dispatch).toBe('index:hash')
    expect(node?.detail).toContain('subquery')
    expect(node?.detail).toContain('v/clients')
    expect(node?.detail).toContain('2 ids')
  })

  it('`.ids()` is the eager spelling and produces the same rows', () => {
    const inner = new Query<Client>(clientsSource().source).where('region', '==', 'north')
    expect(inner.ids()).toEqual(['c1', 'c3'])
    const rows = invoiceQuery(indexedInvoices().source).where('clientId', 'in', inner.ids()).toArray()
    expect(rows.map(r => r.id).sort()).toEqual(['i1', 'i3'])
  })

  it('folds the resolved id set into the MV query-plan summary', () => {
    const north = new Query<Client>(clientsSource().source).where('region', '==', 'north')
    const south = new Query<Client>(clientsSource().source).where('region', '==', 'south')
    const a = summarizeQueryPlan(invoiceQuery(indexedInvoices().source).where('clientId', 'in', north))
    const b = summarizeQueryPlan(invoiceQuery(indexedInvoices().source).where('clientId', 'in', south))
    expect(a).not.toBe(b)
    expect(a).toContain('c1')
  })

  it('refuses a subquery whose source is not collection-backed', () => {
    const bare = new Query<Client>({ snapshot: () => CLIENTS })
    expect(() => invoiceQuery(indexedInvoices().source).where('clientId', 'in', bare)).toThrow(
      /collection-backed/,
    )
  })
})
