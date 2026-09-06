/**
 * #1458 — the Find-only surface of `@noy-db/hub/query`.
 *
 * ⛔ THIS FILE MUST NEVER IMPORT THE ROOT BARREL, `../src/kernel/collection.js`,
 * or any of `query/{live,reduce,relate}`. All four load the extensions, which
 * patch `Query.prototype` for the whole module registry — and a stub that has
 * been overwritten cannot be observed. Vitest isolates per FILE, not per test,
 * so the isolation this file needs is the import list above the fold.
 *
 * The property: a Find-only consumer that calls an extension method gets a
 * named, actionable error rather than `TypeError: q.join is not a function`.
 * The compile-time signal is the real one (the method's type arrives with the
 * subpath, so the call does not typecheck) — this is the runtime backstop for
 * JavaScript consumers and for a `never`-cast that slipped past tsc.
 */
import { describe, it, expect } from 'vitest'
import { Query } from '../src/kernel/query/index.js'
import { QueryExtensionMissingError } from '../src/kernel/errors.js'

interface Row { id: string; status: string; amount: number }

const ROWS: Row[] = [
  { id: 'a', status: 'paid', amount: 10 },
  { id: 'b', status: 'draft', amount: 20 },
  { id: 'c', status: 'paid', amount: 30 },
]

const source = {
  snapshot: () => ROWS,
  lookupById: (id: string) => ROWS.find(r => r.id === id),
  snapshotEntries: () => ROWS.map(r => ({ id: r.id, record: r })),
  identity: 'v/rows',
}

const q = (): Query<Row> => new Query<Row>(source)

/** Every extension method, with the subpath its error must name. */
const EXTENSIONS: readonly (readonly [string, string])[] = [
  ['subscribe', '@noy-db/hub/query/live'],
  ['live', '@noy-db/hub/query/live'],
  ['aggregate', '@noy-db/hub/query/reduce'],
  ['groupBy', '@noy-db/hub/query/reduce'],
  ['window', '@noy-db/hub/query/reduce'],
  ['distinct', '@noy-db/hub/query/reduce'],
  ['join', '@noy-db/hub/query/relate'],
  ['joinOn', '@noy-db/hub/query/relate'],
  ['rightJoin', '@noy-db/hub/query/relate'],
  ['fullOuterJoin', '@noy-db/hub/query/relate'],
  ['crossJoin', '@noy-db/hub/query/relate'],
  ['crossJoinWith', '@noy-db/hub/query/relate'],
  ['traverse', '@noy-db/hub/query/relate'],
  ['ancestorsOf', '@noy-db/hub/query/relate'],
  ['descendantsOf', '@noy-db/hub/query/relate'],
  ['explain', '@noy-db/hub/query/relate'],
]

describe('#1458 — Find alone answers the Find questions', () => {
  it('runs a predicate → sort → slice → hydrate chain with no extension loaded', () => {
    expect(q().where('status', '==', 'paid').orderBy('amount', 'desc').toArray().map(r => r.id))
      .toEqual(['c', 'a'])
    expect(q().where('status', '==', 'paid').count()).toBe(2)
    expect(q().where('status', '==', 'nope').exists()).toBe(false)
    expect(q().orderBy('amount').first()?.id).toBe('a')
    expect(q().where('status', '==', 'paid').ids()).toEqual(['a', 'c'])
    expect(q().limit(2).offset(1).toArray().map(r => r.id)).toEqual(['b', 'c'])
    expect(q().orderBy('id').page().rows.length).toBe(3)
    expect(q().where('amount', '>', 15).toPlan()).toBeDefined()
  })
})

describe('#1458 — every extension method is a stub that names its subpath', () => {
  for (const [method, subpath] of EXTENSIONS) {
    it(`${method}() throws QueryExtensionMissingError naming ${subpath}`, () => {
      const call = (): unknown => (q() as unknown as Record<string, () => unknown>)[method]!()
      expect(call).toThrow(QueryExtensionMissingError)
      // The message must carry BOTH halves: what was called, and the one line
      // that fixes it. A message naming only the method sends the reader to
      // the changelog; naming only the subpath does not say which call failed.
      try { call() } catch (e) {
        expect((e as Error).message).toContain(method)
        expect((e as Error).message).toContain(subpath)
      }
    })
  }

  it('carries the method and subpath as structured fields, not just prose', () => {
    try {
      ;(q() as unknown as { join: () => unknown }).join()
      expect.unreachable('join() must throw without @noy-db/hub/query/relate')
    } catch (e) {
      const err = e as QueryExtensionMissingError
      expect(err.code).toBe('QUERY_EXTENSION_MISSING')
      expect(err.method).toBe('join')
      expect(err.subpath).toBe('@noy-db/hub/query/relate')
    }
  })

  it('leaves no extension symbol reachable from the Find barrel', async () => {
    // The barrel is Find's public surface. `explainPlan`, `applyJoins`,
    // `runTraversal`, `buildLiveQuery` and `dateTrunc` moved to their groups'
    // subpaths; a re-export left behind here would keep the module in every
    // Find bundle no matter what the class does.
    const barrel = await import('../src/kernel/query/index.js')
    for (const gone of ['explainPlan', 'renderExplainText', 'applyJoins', 'runTraversal', 'buildLiveQuery', 'dateTrunc', 'truncateDate']) {
      expect(Object.keys(barrel)).not.toContain(gone)
    }
  })
})
