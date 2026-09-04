/**
 * #1389 — `summarizeQueryPlan()` dropped `JoinLeg.direction` and `.inner`, so a
 * materialized view over a right / full / inner join carried the SAME
 * `queryHash` as one over a plain left join. Drift detection was blind: the MV
 * kept serving rows computed under join semantics the hash never captured, and
 * nothing reported it.
 *
 * Three properties are pinned here, and they are not interchangeable:
 *
 *  1. **Byte-identity.** A plain `.join()` summary is unchanged. That is what
 *     bounds the blast radius of the fix to MVs genuinely using the new modes.
 *  2. **Distinctness.** The four join shapes summarise — and hash — four ways.
 *  3. **The CLASS, not the instance.** Every enumerable key of a normalised
 *     `JoinLeg` either appears in the summary or is on the explicit exclusion
 *     list below. Growing `JoinLeg` without deciding this question fails here.
 *     Both fields #1389 fixed were added by recent work, which is the tell that
 *     the summary was not being updated as a matter of course.
 */
import { describe, it, expect } from 'vitest'
import { Query } from '../src/kernel/query/index.js'
import type { QuerySource } from '../src/kernel/query/index.js'
import type { JoinContext, JoinableSource, JoinLeg } from '../src/kernel/query/join.js'
import { summarizeQueryPlan } from '../src/with-formula/materialized-views/dependency-analyzer.js'
import { computeQueryHash } from '../src/with-formula/materialized-views/query-hash.js'

interface Invoice {
  id: string
  clientId: string
  dept: string
  amount: number
}

interface Client {
  id: string
  name: string
}

const INVOICES: Invoice[] = [
  { id: 'i1', clientId: 'c1', dept: 'ops', amount: 10 },
  { id: 'i2', clientId: 'c9', dept: 'eng', amount: 20 },
]

const CLIENTS: Client[] = [
  { id: 'c1', name: 'Acme' },
  { id: 'c2', name: 'Beta' },
]

function plainSource<T>(records: T[]): QuerySource<T> {
  return { snapshot: () => records }
}

const clientSource: JoinableSource = {
  snapshot: () => CLIENTS,
  lookupById: (id: string) => CLIENTS.find(c => c.id === id),
  snapshotEntries: () => CLIENTS.map(record => ({ id: record.id, record })),
}

const deptDictSource: JoinableSource = {
  snapshot: () => [{ key: 'ops', label: 'Operations' }],
  lookupById: (key: string) => (key === 'ops' ? { key, label: 'Operations' } : undefined),
}

const ctx: JoinContext = {
  leftCollection: 'invoices',
  resolveRef: (field: string) =>
    field === 'clientId' ? { target: 'clients', mode: 'warn' } : null,
  resolveSource: (name: string) => (name === 'clients' || name === 'rates' ? clientSource : null),
  resolveDictSource: (field: string) => (field === 'dept' ? deptDictSource : null),
} as unknown as JoinContext

function q(): Query<Invoice> {
  return new Query<Invoice>(plainSource(INVOICES), undefined, ctx)
}

/** `summarizeQueryPlan` is the exact string `computeQueryHash` consumes. */
function summary(build: (base: Query<Invoice>) => Query<unknown>): string {
  return summarizeQueryPlan(build(q()) as Query<Record<string, unknown>>)
}

const SHAPES = {
  left: (b: Query<Invoice>) => b.join('clientId', { as: 'client' }),
  right: (b: Query<Invoice>) => b.rightJoin('clientId', { as: 'client' }),
  full: (b: Query<Invoice>) => b.fullOuterJoin('clientId', { as: 'client' }),
  inner: (b: Query<Invoice>) => b.join('clientId', { as: 'client', mode: 'inner' }),
} as const

describe('#1389 > byte-identity: the fix must not move an existing left-join hash', () => {
  it('a plain `.join()` summary carries NO direction / inner / isDictJoin key', () => {
    // The whole blast-radius argument. `JSON.stringify` drops an undefined
    // value, so a leg that uses none of the three features summarises exactly
    // as it did before #1389 and its stored queryHash does not move.
    const s = summary(SHAPES.left)
    expect(s).not.toContain('"direction"')
    expect(s).not.toContain('"inner"')
    expect(s).not.toContain('"isDictJoin"')
  })

  it('is byte-identical to the pre-#1389 summary of the same plan', () => {
    // The literal string the pre-#1389 code produced for this plan, pinned so
    // a future edit to the leg summary cannot move it without failing here.
    expect(summary(SHAPES.left)).toBe(
      JSON.stringify({
        root: 'invoices',
        clauses: [],
        orderBy: [],
        limit: null,
        offset: 0,
        joins: [{ field: 'clientId', as: 'client', target: 'clients', mode: 'warn' }],
      }),
    )
  })

  it('a plan with no joins at all is untouched', () => {
    expect(summarizeQueryPlan(q().where('amount', '>', 5) as unknown as Query<Record<string, unknown>>))
      .not.toContain('"joins":[{')
  })
})

describe('#1389 > the four join shapes are four distinct summaries and four distinct hashes', () => {
  it('produces four distinct summaries', () => {
    const summaries = Object.values(SHAPES).map(summary)
    expect(new Set(summaries).size).toBe(4)
  })

  it('produces four distinct queryHashes', async () => {
    const deps = new Set(['invoices', 'clients'])
    const hashes = await Promise.all(
      Object.values(SHAPES).map(shape => computeQueryHash('mv', deps, summary(shape))),
    )
    expect(new Set(hashes).size).toBe(4)
  })

  it('names the direction it actually used', () => {
    expect(summary(SHAPES.right)).toContain('"direction":"right"')
    expect(summary(SHAPES.full)).toContain('"direction":"full"')
    expect(summary(SHAPES.inner)).toContain('"inner":true')
  })

  it('a dict join and a like-named ref join no longer collide', () => {
    // A dict leg's `target` IS its `field`, so the four base keys alone cannot
    // separate it from a ref join to a collection of the same name.
    const dict = summary(b => b.join('dept', { as: 'd' }))
    expect(dict).toContain('"isDictJoin":true')
    expect(dict).not.toBe(
      JSON.stringify({
        root: 'invoices',
        clauses: [],
        orderBy: [],
        limit: null,
        offset: 0,
        joins: [{ field: 'dept', as: 'd', target: 'dept', mode: 'strict' }],
      }),
    )
  })
})

describe('#1389 > the CLASS: every JoinLeg key is summarised or explicitly excluded', () => {
  /**
   * Fields deliberately kept OUT of the leg summary. Each entry must state a
   * reason that survives review — "it did not seem to matter" is not one.
   * Mirrors the comment block in `summarizeJoinLeg`.
   */
  const EXCLUDED: Record<string, string> = {
    // Always `'all'`, never read by the executor (#1342), and — unlike every
    // key added since — present unconditionally rather than omitted at its
    // default, so emitting it would move EVERY joined MV's hash for no
    // semantic gain.
    partitionScope: 'derived/inert plan seam; emitting it moves every stored hash',
    // Picks HOW the same rows are produced (hash vs lookup), never which.
    strategy: 'execution hint, not row identity',
    // A ceiling that throws when crossed; a query that succeeds returns the
    // same rows at any ceiling above its size.
    maxRows: 'guardrail, not row identity',
  }

  /**
   * Every normalised leg shape the builder can produce. If a new leg kind is
   * added, add it here — the union of these legs' keys is what the property
   * is measured over.
   */
  function everyLegShape(): JoinLeg[] {
    const plans = [
      q().join('clientId', { as: 'client' }),
      q().rightJoin('clientId', { as: 'client' }),
      q().fullOuterJoin('clientId', { as: 'client' }),
      q().join('clientId', { as: 'client', mode: 'inner' }),
      q().join('clientId', { as: 'client', strategy: 'hash', maxRows: 10 }),
      q().join('dept', { as: 'd' }),
      q().joinOn('rates', { as: 'rate', on: [['clientId', 'id']] }),
      q().joinOn('rates', { as: 'rate', mode: 'inner', on: { left: 'amount', op: '>=', right: 'id' } }),
    ] as unknown as Array<Query<Record<string, unknown>>>
    return plans.flatMap(p => [...(p._plan().joins as readonly JoinLeg[])])
  }

  it('covers every enumerable key of every normalised leg shape', () => {
    const legKeys = new Set<string>()
    for (const leg of everyLegShape()) {
      for (const k of Object.keys(leg)) legKeys.add(k)
    }
    // Sanity: the shapes above really do exercise the optional keys, so this
    // property cannot pass vacuously.
    for (const k of ['direction', 'inner', 'on', 'isDictJoin', 'strategy', 'maxRows', 'partitionScope']) {
      expect(legKeys.has(k), `leg shape coverage lost the "${k}" key`).toBe(true)
    }

    // The keys the summary actually emits, read off a real summarised leg
    // rather than restated — a restated list can drift from the code.
    const summarised = new Set<string>()
    for (const leg of everyLegShape()) {
      const one = JSON.parse(
        summarizeQueryPlan(
          new Query<Invoice>(plainSource(INVOICES), { clauses: [], orderBy: [], joins: [leg], offset: 0 } as never, ctx) as unknown as Query<Record<string, unknown>>,
        ),
      ) as { joins: Array<Record<string, unknown>> }
      for (const k of Object.keys(one.joins[0]!)) summarised.add(k)
    }

    const unaccounted = [...legKeys].filter(k => !summarised.has(k) && !(k in EXCLUDED))
    expect(
      unaccounted,
      `JoinLeg grew ${JSON.stringify(unaccounted)} without a decision. Either emit it from ` +
        `summarizeJoinLeg() — OMITTED AT ITS DEFAULT, or every stored MV queryHash moves — or ` +
        `add it to EXCLUDED here with the reason it cannot change which rows the leg produces.`,
    ).toEqual([])
  })

  it('the exclusion list names only keys that really exist on a leg', () => {
    // Keeps the list from rotting into a set of names nothing checks.
    const legKeys = new Set<string>()
    for (const leg of everyLegShape()) for (const k of Object.keys(leg)) legKeys.add(k)
    expect(Object.keys(EXCLUDED).filter(k => !legKeys.has(k))).toEqual([])
  })

  it('an excluded key does not change the summary', () => {
    // The exclusion list is a claim about behaviour, so assert the behaviour.
    expect(summary(b => b.join('clientId', { as: 'client', strategy: 'hash', maxRows: 10 })))
      .toBe(summary(SHAPES.left))
  })
})
