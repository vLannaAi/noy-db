/**
 * Chainable, immutable query builder.
 *
 * Each builder operation returns a NEW Query — the underlying plan is never
 * mutated. This makes plans safe to share, cache, and serialize.
 */

import type { QueryField } from '../types.js'
import type { DateTruncKey, GroupKey } from './date-trunc.js'
import { groupKeyName, isDateTruncKey, projectDateTruncKeys } from './date-trunc.js'
import type { Clause, CrossJoinClause, FieldClause, FilterClause, GroupClause, Operator, WherePredicateClause } from './predicate.js'
import { evaluateClause, hasFnClause, normalizeMatches, normalizeSubqueryOperand, readPath } from './predicate.js'
import { distinctKeyOf } from './distinct-key.js'
import type { CollectionIndexes } from '../../with-lookup/indexing/eager-indexes.js'
import type { JoinableSource, JoinContext, JoinDirection, JoinLeg, JoinStrategy } from './join.js'
import { applyJoins, joinsDropLeftRows, orderReferencesJoinAlias, splitAroundJoins } from './join.js'
import { reduceViaFor, refuseAliasReduceVia } from './join-reduce.js'
import { normalizeJoinOn, type JoinOnSpec } from './join-on.js'
import { CrossJoinTooLargeError, CrossJoinSourceUnknownError, FieldNotQueryableError, RefNotDeclaredError } from '../errors.js'
import { gateTerminal } from './hydration.js'
import type { HydrationGate } from './hydration.js'
import type { LiveQuery, LiveUpstream } from './live.js'
import { buildLiveQuery } from './live.js'
import type { GroupMaintenanceSource, SourceChange } from './incremental.js'
import { LiveMaintainer, canMaintainIncrementally } from './incremental.js'
import type { ReduceSpec, ReduceResult, ReductionUpstream, Reduction } from '../../with-lookup/reduce/reduction.js'
import type { ReducerBuilder } from '../../with-lookup/reduce/reducers.js'
import { bindDistinctReducers, reducerBuilder } from '../../with-lookup/reduce/reducers.js'
import type { GroupedQuery, GroupedQueryN } from '../../with-lookup/reduce/groupby.js'
import { NO_REDUCE, type ReduceStrategy } from '../../with-lookup/reduce/strategy.js'
import type { WindowSpec, WindowedQuery } from '../../with-lookup/reduce/strategy.js'
import type { ViaPipeline } from '../via/pipeline.js'
import { isViaPrefixProbe } from '../via/index.js'
import { decodeCursor, encodeCursor, keysetShape } from './cursor.js'
import type { QueryExplanation } from './explain.js'
import { explainPlan } from './explain.js'
import type { CyclePolicy, TraversalRow, TraverseDirection, TraverseOptions } from './traverse.js'
import { runTraversal } from './traverse.js'

export interface OrderBy {
  readonly field: string
  readonly direction: 'asc' | 'desc'
  /**
   * Sort key for a `dictKey`/`staticDict` field: `'value'` (default)
   * sorts by the stored code; `'label'` sorts by the code's resolved label at
   * the query locale (`toArray({ locale })`, or a `staticDict` `displayLocale`).
   * Falls back to the code when no label resolves.
   */
  readonly by?: 'value' | 'label'
}

/**
 * A complete query plan: zero-or-more clauses, optional ordering, pagination,
 * and optional joins.
 *
 * Plans are JSON-serializable as long as no FilterClause is present and no
 * join leg carries a manual `strategy` override (JoinLeg itself is plain
 * data, so it serializes cleanly).
 *
 * Plans are intentionally NOT parametric on T — see `predicate.ts` FilterClause
 * for the variance reasoning. The public `Query<T>` API attaches the type tag.
 */
export interface QueryPlan {
  readonly clauses: readonly Clause[]
  readonly orderBy: readonly OrderBy[]
  readonly limit: number | undefined
  readonly offset: number
  /**
   * Opaque keyset cursor from `.after(cursor)` (#1346). When present, the
   * window starts strictly after the `(sortKey, id)` the cursor names,
   * instead of at a positional offset.
   *
   * OPTIONAL, unlike its `limit`/`offset` neighbours: `QueryPlan` is an
   * exported type that consumers construct, so a required new property would
   * be a breaking change where an optional one is additive.
   */
  readonly after?: string | undefined
  /**
   * Zero-or-more join legs to apply after where/orderBy/limit/offset.
   * Each leg attaches a resolved right-side record (or null) under its
   * alias. See `query/join.ts` for the full semantics.
   */
  readonly joins: readonly JoinLeg[]
}

const EMPTY_PLAN: QueryPlan = {
  clauses: [],
  orderBy: [],
  limit: undefined,
  offset: 0,
  after: undefined,
  joins: [],
}

/** Default row ceiling for cross-join expansion. Matches JoinTooLargeError's ceiling. */
export const DEFAULT_CROSS_JOIN_MAX_ROWS = 50_000

/**
 * Guard for the terminals that reduce rather than project (#1030). Grouping
 * or aggregating over a joined alias silently bucketed every row under
 * `undefined`, because these terminals never apply join legs at all.
 *
 * ⭐ **`aggregate()` and `groupBy()` NO LONGER CALL THIS — #1338 supplied the
 * work the analysis below specifies, and they route instead of refusing.**
 * The remaining caller is `distinct()`, whose Via question is a different one
 * (`distinctKeyOf` canonicalises through the LEFT pipeline's index key, so an
 * aliased value would dedup on the wrong canonicaliser) and which no issue has
 * asked for. Everything below is the analysis #1338 was built from; it is kept
 * because it names WHICH properties had to hold, and `join-reduce.ts` is where
 * each one is now discharged:
 *
 *   - the right side's reducer rewrite AND its posture gate, in one call —
 *     `joinAliasBinding` hands each aliased reducer to the right collection's
 *     own `wrapReducers` under its bare field name;
 *   - right-side change streams merged into the live upstreams —
 *     `Query.rightSideUpstreams()`, shared with `live()`;
 *   - and the case the analysis could not see, because the grouped terminal
 *     is one object further along the chain than `Query.aggregate()`: a
 *     reducer over an alias under a LEFT group key, which returned a confident
 *     `0`. `refuseAliasBinding` refuses it.
 *
 * Refusing rather than reordering was a DELIBERATE, REVIEWED DECISION
 * (2026-08-10), not an oversight. What follows is why, so it is not
 * re-litigated from scratch — and so nobody "fixes" it for the wrong reason.
 *
 * It is NOT a cardinality problem. A ref join is an equi-join on the target's
 * PRIMARY KEY, so every left row matches at most one right record and the row
 * count is constant across legs (see `join.ts`). Aggregating over joined rows
 * is perfectly well-defined; `count()` is unambiguous. Anyone who reads this
 * guard as "the semantics are unclear" has the wrong model.
 *
 * The actual blocker is that the Via pipeline is LEFT-SCOPED. `aggregate()`
 * runs `this.source.via.wrapReducers(spec)`, which resolves `postureFor(field)`
 * against the LEFT collection's field map. For `sum('client.balance')` that map
 * has no entry, so two things silently do not happen:
 *
 *   - money's exact-BigInt reducer rewrite is skipped, and a generic sum runs
 *     over stored scaled-integer strings — silently wrong numbers;
 *   - `refuseUnqueryableReducers` does not fire, so the `queryable: 'none'`
 *     gate that would refuse the field never applies.
 *
 * A gate that silently does not apply is worse than a missing feature, which
 * is why this refuses instead of guessing. Supporting joined aggregation means
 * resolving a joined field's posture and reducers from the RIGHT collection's
 * Via pipeline (via `joinContext.resolveSource`), plus merging right-side
 * change streams into the live-reduction upstreams the way `Query.live()`
 * already does — otherwise a live joined aggregate silently stops updating.
 * That is the work. It is not "apply the legs here".
 *
 * Two things that are already handled, so they are not reasons to defer: the
 * MV dependency analyzer already treats `plan.joins` targets as sources and
 * folds them into the queryHash, and `.crossJoin()` — whose clause lives in
 * the clause list — already aggregates correctly today. The error below points
 * there because it is a real answer, not a consolation.
 *
 * Deliberately NOT tracked as an issue: no consumer has asked, and #984 is the
 * cautionary tale — a speculative deferral whose premises had drifted out of
 * sync with the code by the time anyone re-read it. Build this when a real
 * query needs it, and design it against that query.
 * ⭐ It was tracked as one three weeks later (#1338, the accounting-report
 * shape) and built against that query — which is the paragraph above working,
 * not failing.
 */
function assertNoJoinAliasField(
  fields: readonly string[],
  joins: readonly JoinLeg[],
  terminal: string,
): void {
  if (joins.length === 0) return
  const aliases = new Set(joins.map(leg => leg.as))
  for (const field of fields) {
    const head = field.split('.')[0]!
    if (!aliases.has(head)) continue
    throw new Error(
      `Query.${terminal}(): field "${field}" addresses the join alias "${head}", but ` +
        `${terminal}() does not apply join legs — it would silently group every row ` +
        `under undefined. Joined aggregation is not supported. Either aggregate over ` +
        `the left collection's own fields, or use .crossJoin("${head}", { as: … }), ` +
        `whose expansion IS visible to ${terminal}().`,
    )
  }
}

/**
 * Source of records that a query executes against.
 *
 * The interface is non-parametric to keep variance friendly: callers cast
 * their typed source (e.g. `QuerySource<Invoice>`) into this opaque shape.
 *
 * `getIndexes` and `lookupById` are optional fast-path hooks. When both are
 * present and a where clause matches an indexed field, the executor uses
 * the index to skip a linear scan. Sources without these methods (or with
 * `getIndexes` returning `null`) always fall back to a linear scan.
 */
export interface QuerySource<T> {
  /** Snapshot of all current records. The query never mutates this array. */
  snapshot(): readonly T[]
  /**
   * Subscribe to mutations; returns an unsubscribe function.
   *
   * A source that knows WHICH record changed passes the delta (#1341) so
   * `.live()` can patch its result set rather than re-run the plan. Calling
   * `cb()` with no argument stays valid — it means "something changed", and
   * the live query answers with a full re-run.
   */
  subscribe?(cb: (change?: SourceChange) => void): () => void
  /** Index store for the indexed-fast-path. Optional. */
  getIndexes?(): CollectionIndexes | null
  /** O(1) record lookup by id, used to materialize index hits. */
  lookupById?(id: string): T | undefined
  /**
   * The backing collection's compiled Via pipeline (money now; more Via
   * features later), used to rewrite `where()` operands, decode results,
   * order, and rewrite aggregate reducers for covered fields.
   */
  via?: ViaPipeline
  /**
   * Id-paired snapshot for `Query._idArray()` (the `retrieve({within})`
   * id projection). Optional: only collection-backed queries supply it.
   */
  snapshotEntries?(): readonly { id: string; record: T }[]
  /**
   * #1414 — cold-collection gate. Present only on collection-backed eager
   * sources. While `isHydrated()` is false the collection's snapshot is empty
   * by ABSENCE, not by content, so every terminal returns a pending result
   * (awaitable, and throwing on synchronous use) instead of a confident empty.
   * See `query/hydration.ts`.
   */
  hydration?: HydrationGate
  /**
   * Stable name for this source (`<vault>/<collection>`), used to bind a
   * keyset cursor to the query that minted it (#1346) so a cursor replayed
   * against another collection is refused rather than silently mis-paged.
   */
  identity?: string
  /**
   * #1417 — monotonic mutation counter for the backing cache. Two reads
   * returning the same number means nothing changed between them, which is
   * what lets `page()`/`after()` reuse one sort across a page walk instead of
   * re-sorting the whole collection per page.
   *
   * Optional, and absence is safe: a source that does not supply it simply
   * gets no memo. It is a CHANGE COUNTER, never a content hash — see
   * `kernel/generation-map.ts` for why it is maintained by the container
   * rather than at the mutation sites.
   */
  snapshotVersion?(): number
}

interface InternalSource {
  snapshot(): readonly unknown[]
  subscribe?(cb: (change?: SourceChange) => void): () => void
  getIndexes?(): CollectionIndexes | null
  lookupById?(id: string): unknown
  via?: ViaPipeline
  snapshotEntries?(): readonly { id: string; record: unknown }[]
  hydration?: HydrationGate
  identity?: string
  snapshotVersion?(): number
}

/**
 * Declared deterministic predicate. Carries the consumer's
 * stable `hash` (for function-body identity), the function itself,
 * and is keyed by name when registered on a `Query<T>` via
 * `_withPredicates()`.
 */
export interface DeclaredPredicate {
  hash: string
  fn: (record: unknown, ctx?: unknown) => boolean
}

/**
 * The chainable query builder over an eager collection's decrypted cache.
 *
 * ## Its terminals are SYNCHRONOUS (#1413)
 *
 * `toArray()`, `ids()`, `page()`, `first()`, `count()` and `exists()` return
 * their value directly — `T[]`, `string[]`, `{ rows, nextCursor }`, `T | null`,
 * `number`, `boolean` — **not** a `Promise` of it. That is the architecture
 * showing through, not an oversight: `Query` runs over `source.snapshot()`, an
 * already-decrypted in-memory view. Decryption happened at hydration, so by the
 * time a plan executes there is nothing left to await. Making these async would
 * break every call site and erase the one property that distinguishes a cached
 * query from a fetch.
 *
 * ⚠️ **So `.catch()` / `.then()` on a terminal's result is not part of the
 * contract.** `query().toArray().catch(fn)` fails with *"catch is not a
 * function"* on a loaded collection. Handle errors with `try` / `catch` around
 * the call.
 *
 * `await` is always safe, though — awaiting a plain array yields the array —
 * and on an unhydrated collection it is REQUIRED. See below.
 *
 * ## The one exception, and it is not an async terminal (#1414)
 *
 * On a collection that has never been loaded, a terminal cannot answer: the
 * snapshot is empty by ABSENCE, not by content. Rather than return a confident
 * `[]` / `0` / `false`, it returns a **pending result** — a thenable that
 * hydrates and re-runs the terminal when awaited, and throws
 * {@link CollectionNotHydratedError} on any other use. It is deliberately NOT a
 * promise-shaped array: the moment the collection is hydrated the very same
 * call returns the plain synchronous value again. Write
 * `await collection.query().toArray()` — correct in both states — or
 * `await collection.list()` first and then read synchronously.
 * See `query/hydration.ts`.
 *
 * ## Where the same name IS async
 *
 * `PartitionedQuery.toArray()` (`with-store/partitioned/index.ts`) and the lazy
 * builder's `LazyQuery.toArray()` (`with-lookup/indexing/lazy-builder.ts`)
 * return `Promise<T[]>`. Both genuinely fetch — across partition legs, or
 * through the persisted `_idx/` side-car — so both genuinely await. Same
 * method name, different contract, because the surface underneath differs.
 *
 * ---
 *
 * All non-terminal methods return a NEW Query — the original is unchanged.
 * Type parameter T flows through the public API for ergonomics, but the
 * internal storage uses `unknown` so `Collection<T>` stays covariant.
 *
 * The optional `joinContext` is attached when the Query is constructed via
 * `Collection.query()` (Collection passes in a context built from the Vault's
 * join resolver). A Query constructed via `new Query` directly — e.g. from
 * tests with a plain-object source — has no joinContext, and calling `.join()`
 * on it throws with an actionable error. See `query/join.ts` for the full
 * design.
 */
export class Query<T, S extends keyof T = never, Q extends keyof T & string = never, M extends keyof T & string = never> {
  private readonly source: InternalSource
  private readonly plan: QueryPlan
  private readonly joinContext: JoinContext | undefined
  private readonly reduceStrategy: ReduceStrategy
  private readonly predicates: ReadonlyMap<string, DeclaredPredicate> | undefined

  constructor(
    source: QuerySource<T>,
    plan: QueryPlan = EMPTY_PLAN,
    joinContext?: JoinContext,
    reduceStrategy: ReduceStrategy = NO_REDUCE,
    predicates?: ReadonlyMap<string, DeclaredPredicate>,
  ) {
    this.source = source as InternalSource
    this.plan = plan
    this.joinContext = joinContext
    this.reduceStrategy = reduceStrategy
    this.predicates = predicates
  }

  /**
   * @internal — accessor for the materialized-view dependency
   * analyzer. Not part of the public API; consumers should use the
   * builder methods, not inspect the plan directly.
   */
  _plan(): QueryPlan {
    return this.plan
  }

  /**
   * @internal — accessor for the materialized-view dependency
   * analyzer. Returns the join resolution context (or `undefined` for
   * queries constructed without a Collection backing).
   */
  _joinContext(): JoinContext | undefined {
    return this.joinContext
  }

  /**
   * @internal #1414 — clone this Query with the cold-collection gate REMOVED.
   *
   * For engine-internal readers only. The materialized-view engine reads its
   * source collections through the public `collection.query()` on paths that
   * are synchronous by construction (registration inspects the plan; the
   * executor's row scan is called from inside a write commit), and it has
   * always read whatever the in-memory cache held. Gating those would turn a
   * pre-existing read into a throw for consumers who never asked a question —
   * so this preserves that behaviour EXACTLY, and confines #1414's change to
   * the surface a consumer or a guard actually calls.
   *
   * ⚠️ It does not make an unhydrated read correct — an MV computed over a
   * cold source is the same defect wearing a different hat. That is tracked
   * separately; do not reach for this to silence the gate in new code.
   */
  _ungated(): Query<T, S, Q, M> {
    if (this.source.hydration === undefined) return this
    const rest: InternalSource = { ...this.source }
    delete rest.hydration
    return new Query<T, S, Q, M>(rest as QuerySource<T>, this.plan, this.joinContext, this.reduceStrategy, this.predicates)
  }

  /**
   * @internal — clone this Query with a declared-predicate map
   * attached. Used by the materialized-view registry to enable
   * `.wherePredicate(name, ctx?)` for the MV's query callback.
   * Consumers don't call this directly.
   */
  _withPredicates(predicates: ReadonlyMap<string, DeclaredPredicate>): Query<T, S, Q, M> {
    return new Query<T, S, Q, M>(
      this.source as QuerySource<T>,
      this.plan,
      this.joinContext,
      this.reduceStrategy,
      predicates,
    )
  }

  /**
   * @internal — the ids of records matching this query's plan,
   * recovered by reference identity: `executePlanWithSource` returns the
   * ORIGINAL snapshot record references (money-decode and joins are applied
   * later, in `toArray`), so each matched record is found in the id-paired
   * `snapshotEntries()` map. Used by `collection.retrieve({ within })`.
   * Throws if the source is not collection-backed (no `snapshotEntries`).
   */
  _idArray(): string[] {
    const entries = this.source.snapshotEntries?.()
    if (entries === undefined) {
      throw new Error(
        'Query._idArray(): the query source has no snapshotEntries(); ' +
          'retrieve({ within }) requires a collection-backed query (collection.query()).',
      )
    }
    if (this.plan.clauses.some(c => c.type === 'crossJoin')) {
      throw new Error(
        'Query._idArray(): retrieve({ within }) does not support crossJoin queries ' +
          '(cross-join produces new row objects, breaking id recovery). ' +
          'Use where/filter/and/or, or a projection .join().',
      )
    }
    const refToId = new Map<unknown, string>()
    for (const { id, record } of entries) refToId.set(record, id)
    const matched = executePlanWithSource(this.source, this.plan, this.joinContext)
    const ids: string[] = []
    for (const r of matched) {
      const id = refToId.get(r)
      if (id !== undefined) ids.push(id)
    }
    return ids
  }

  /**
   * The ids of the records this query matches (#1351) — the public spelling
   * of {@link _idArray}, and the eager half of the subquery operand:
   * `where(f, 'in', inner.ids())` and `where(f, 'in', inner)` build the SAME
   * clause. Reach for the explicit form when you want to reuse the id set, or
   * to see it.
   *
   * Requires a collection-backed query (`collection.query()`); a `crossJoin`
   * plan is refused, because it produces new row objects and there is no id
   * to recover.
   *
   * **Synchronous** (#1413) — returns `string[]`, not a promise; the cache it reads is
   * already decrypted. `await` is safe and is REQUIRED on an unhydrated collection
   * (#1414); `.catch()` is not available. See the {@link Query} class doc.
   */
  ids(): string[] {
    const _h = this.source.hydration
    if (_h !== undefined && !_h.isHydrated()) return gateTerminal(_h, 'ids', () => this.ids())
    return this._idArray()
  }

  /**
   * @internal — the id-operand contract `normalizeSubqueryOperand()`
   * (`predicate.ts`) duck-types when this Query is passed as the operand of
   * `in`/`!in`. Separate from {@link ids} so the failure a subquery hits is
   * phrased as a subquery failure rather than as a `retrieve({ within })` one.
   */
  _asIdOperand(): { readonly ids: readonly string[]; readonly from: string } {
    if (this.source.snapshotEntries === undefined) {
      throw new Error(
        "where(..., 'in', <subquery>): the inner query's source is not " +
          'collection-backed (no snapshotEntries()). Pass a query obtained from ' +
          'collection.query(), or pass a literal array of values.',
      )
    }
    return { ids: this._idArray(), from: this.source.identity ?? '(unnamed)' }
  }

  /**
   * Filter by a registered deterministic predicate. Requires
   * the Query to have been augmented with a predicates map (typically
   * via the materialized-view registry — bare Queries constructed
   * outside an MV throw on `.wherePredicate()`).
   *
   * `ctx` is an optional opaque value passed verbatim to the predicate
   * function. Both `predicateHash` (from the registration) and a
   * canonical-JSON hash of `ctx` fold into the MV's `queryHash`, so
   * either changing forces refresh on next visit.
   */
  wherePredicate(name: string, ctx?: unknown): Query<T, S, Q, M> {
    if (!this.predicates) {
      throw new Error(
        `.wherePredicate("${name}"): no predicates registered on this Query. ` +
          `Function-based predicates require the Query to be obtained from ` +
          `inside a materialized-view query() callback whose strategy declares ` +
          `\`predicates: { ${name}: { hash, fn } }\`.`,
      )
    }
    const decl = this.predicates.get(name)
    if (!decl) {
      throw new Error(
        `.wherePredicate("${name}"): predicate not registered. ` +
          `Available: ${[...this.predicates.keys()].join(', ') || '(none)'}.`,
      )
    }
    const clause: WherePredicateClause = {
      type: 'wherePredicate',
      name,
      ctx,
      predicateHash: decl.hash,
      ctxHash: canonicalCtxHash(ctx),
      fn: decl.fn,
    }
    return new Query<T, S, Q, M>(
      this.source as QuerySource<T>,
      { ...this.plan, clauses: [...this.plan.clauses, clause] },
      this.joinContext,
      this.reduceStrategy,
      this.predicates,
    )
  }

  /**
   * Add a field comparison. Multiple where() calls are AND-combined.
   *
   * A declared money field compares in MAJOR units: the operand
   * (`10000`, `'10000.00'`, or `{ amount, currency }` in multi mode) is
   * quantized into stored scaled-int space at build time and evaluated
   * BigInt-exact per record. A malformed operand or a string operator
   * (`contains`/`startsWith`) throws here, at the call site.
   *
   * Consults the Via pipeline's posture before building a clause (#629
   * Task 8): a field whose posture is `queryable: 'none'` (e.g. a
   * `blobFields` slot) throws `FieldNotQueryableError` here, at the call
   * site. Every other posture is unaffected — the existing per-binding
   * `buildClause` machinery runs exactly as before.
   */
  where(field: QueryField<T, S, Q>, op: Operator, value: unknown): Query<T, S, Q, M> {
    const via = this.source.via
    if (via?.postureFor(field)?.queryable === 'none') throw new FieldNotQueryableError(field)
    // #1357: a 'matches' operand is refused-or-normalized HERE, at the call
    // site — an anchored literal prefix lowers to `startsWith` (taking the
    // sorted index), anything else serializes to `{ source, flags }` so the
    // pattern folds into an MV's queryHash. Every other operator is identity.
    // #1351: a SUBQUERY operand of `in`/`!in` is resolved to its id array
    // HERE, once, at build time — so everything downstream (the hash-index
    // dispatch in `candidateRecords`, the queryHash fold, `explain()`) sees a
    // literal array and needs no subquery awareness at all. The operand is
    // therefore a SNAPSHOT of the inner result — read
    // `normalizeSubqueryOperand`'s doc for what that costs a `.live()` query
    // (an inner-collection change does not re-fire it).
    const { op: sop, value: sval, subquery } = normalizeSubqueryOperand(op, value)
    const { op: mop, value: mval } = normalizeMatches(sop, sval)
    const viaClause = via?.buildClause(field, mop, mval)
    const clause: FieldClause = viaClause
      ? {
          type: 'field',
          field,
          op: mop,
          value: mval,
          ...(subquery ? { subquery } : {}),
          via: {
            brand: viaClause.brand,
            payload: viaClause.payload,
            evaluate: (actual: unknown, evalOp: string) => via!.evaluateClause(viaClause, actual, evalOp),
            indexValue: via!.indexProbe(viaClause, mop),
          },
        }
      : { type: 'field', field, op: mop, value: mval, ...(subquery ? { subquery } : {}) }
    return new Query<T, S, Q, M>(
      this.source as QuerySource<T>,
      { ...this.plan, clauses: [...this.plan.clauses, clause] },
      this.joinContext,
      this.reduceStrategy,
      this.predicates,
    )
  }

  /**
   * Logical OR group. Pass a callback that builds a sub-query.
   * Each clause inside the callback is OR-combined; the group itself
   * joins the parent plan with AND.
   */
  or(builder: (q: Query<T, S, Q, M>) => Query<T, S, Q, M>): Query<T, S, Q, M> {
    const sub = builder(
      new Query<T, S, Q, M>(this.source as QuerySource<T>, EMPTY_PLAN, this.joinContext, this.reduceStrategy, this.predicates),
    )
    const group: GroupClause = {
      type: 'group',
      op: 'or',
      clauses: sub.plan.clauses,
    }
    return new Query<T, S, Q, M>(
      this.source as QuerySource<T>,
      { ...this.plan, clauses: [...this.plan.clauses, group] },
      this.joinContext,
      this.reduceStrategy,
      this.predicates,
    )
  }

  /**
   * Logical AND group. Same shape as `or()` but every clause inside the group
   * must match. Useful for explicit grouping inside a larger OR.
   */
  and(builder: (q: Query<T, S, Q, M>) => Query<T, S, Q, M>): Query<T, S, Q, M> {
    const sub = builder(
      new Query<T, S, Q, M>(this.source as QuerySource<T>, EMPTY_PLAN, this.joinContext, this.reduceStrategy, this.predicates),
    )
    const group: GroupClause = {
      type: 'group',
      op: 'and',
      clauses: sub.plan.clauses,
    }
    return new Query<T, S, Q, M>(
      this.source as QuerySource<T>,
      { ...this.plan, clauses: [...this.plan.clauses, group] },
      this.joinContext,
      this.reduceStrategy,
      this.predicates,
    )
  }

  /** Escape hatch: add an arbitrary predicate function. Not serializable. */
  filter(fn: (record: T) => boolean): Query<T, S, Q, M> {
    const clause: FilterClause = {
      type: 'filter',
      fn: fn as (record: unknown) => boolean,
    }
    return new Query<T, S, Q, M>(
      this.source as QuerySource<T>,
      { ...this.plan, clauses: [...this.plan.clauses, clause] },
      this.joinContext,
      this.reduceStrategy,
      this.predicates,
    )
  }

  /**
   * Sort by a field. Subsequent calls are tie-breakers. Pass
   * `{ by: 'label' }` to sort a `dictKey`/`staticDict` field by its resolved
   * label at the query locale instead of the stored code.
   *
   * Consults the Via pipeline's posture (#629 Task 8): a field whose posture
   * is `queryable: 'none'` throws `FieldNotQueryableError` here, at the call
   * site — same gate as `where()`.
   */
  orderBy(field: QueryField<T, S>, direction: 'asc' | 'desc' = 'asc', opts?: { by?: 'value' | 'label' }): Query<T, S, Q, M> {
    if (this.source.via?.postureFor(field)?.queryable === 'none') throw new FieldNotQueryableError(field)
    const entry: OrderBy = opts?.by === 'label' ? { field, direction, by: 'label' } : { field, direction }
    return new Query<T, S, Q, M>(
      this.source as QuerySource<T>,
      { ...this.plan, orderBy: [...this.plan.orderBy, entry] },
      this.joinContext,
      this.reduceStrategy,
      this.predicates,
    )
  }

  /** Cap the result size. */
  limit(n: number): Query<T, S, Q, M> {
    return new Query<T, S, Q, M>(
      this.source as QuerySource<T>,
      { ...this.plan, limit: n },
      this.joinContext,
      this.reduceStrategy,
      this.predicates,
    )
  }

  /**
   * Resume strictly after the row an opaque keyset cursor names (#1346).
   *
   * ```ts
   * const first = people.query().orderBy('name').limit(20).page()
   * const next = people.query().orderBy('name').limit(20).after(first.nextCursor!).page()
   * ```
   *
   * Unlike `offset(n)`, the window is anchored to a `(sortKey, id)` position,
   * so a record inserted or deleted before it — including the cursor's own
   * row — cannot re-serve or skip a record.
   *
   * The cursor is OPAQUE: pass back a `nextCursor` from `.page()` verbatim
   * and do not parse it. It is validated when the query executes (not here —
   * the sort spec it is bound to may still be added to the chain), and a
   * cursor from a different collection or a different `orderBy(...)` spec is
   * REFUSED rather than mis-paged.
   *
   * Requires at least one `orderBy(...)`, an id-paired (collection-backed)
   * source, no join legs and no `offset()`; each is a loud error at execution.
   */
  after(cursor: string): Query<T, S, Q, M> {
    if (typeof cursor !== 'string' || cursor.length === 0) {
      throw new Error('Query.after(): a cursor must be a non-empty string — pass back the `nextCursor` from .page().')
    }
    return new Query<T, S, Q, M>(
      this.source as QuerySource<T>,
      { ...this.plan, after: cursor },
      this.joinContext,
      this.reduceStrategy,
      this.predicates,
    )
  }

  /** Skip the first N matching records (after ordering). */
  offset(n: number): Query<T, S, Q, M> {
    return new Query<T, S, Q, M>(
      this.source as QuerySource<T>,
      { ...this.plan, offset: n },
      this.joinContext,
      this.reduceStrategy,
      this.predicates,
    )
  }

  /**
   * Resolve a `ref()`-declared foreign key and attach the right-side
   * record under `opts.as`. — eager, single-FK, intra-
   * vault joins.
   *
   * ```ts
   * const rows = invoices.query()
   *   .where('status', '==', 'open')
   *   .join('clientId', { as: 'client' })
   *   .toArray()
   * // → [{ id, amount, client: { id, name, ... } }, ...]
   * ```
   *
   * Preconditions:
   *   - The Query must have a `joinContext` (constructed via
   *     `Collection.query()`, not `new Query`).
   *   - `field` must have a matching `refs: { [field]: ref('<target>') }`
   *     declaration on the left collection.
   *   - The target collection must be reachable via the vault
   *     (either currently open or openable on demand).
   *
   * Strategy:
   *   - Nested-loop against `lookupById` when the target source
   *     provides it (the common path for Collection targets).
   *   - Hash join otherwise, or when `{ strategy: 'hash' }` is
   *     explicitly passed for test purposes.
   *
   * Ref-mode semantics on dangling refs (left record has a non-null
   * FK value pointing at a right-side id that doesn't exist):
   *   - `strict`  → throws `DanglingReferenceError` with the full
   *     field / target / refId context.
   *   - `warn`    → attaches `null` and emits a one-shot warning per
   *     unique dangling pair.
   *   - `cascade` → attaches `null` silently. Cascade is a
   *     delete-time mode; dangling refs visible at read time are
   *     either mid-flight cascades or pre-existing orphans, not a
   *     DSL-level error.
   *
   * A left-side record whose FK field is `null` / `undefined` is NOT
   * a dangling ref — it's "no reference at all", always allowed
   * regardless of mode.
   *
   * The return type widens `T` with `Record<As, R | null>`. The `R`
   * parameter is optional — supply it explicitly for type-checked
   * access to the joined fields:
   *
   * ```ts
   * invoices.query().join<'client', Client>('clientId', { as: 'client' })
   * //                 ^^^^^^^^^^^^^^^^^^^ alias literal + right-side type
   * ```
   *
   * Without the generic, the joined field is typed as `unknown`, which
   * still works but requires a cast to access its properties.
   *
   * Joins stay intra-vault by construction — cross-vault
   * correlation goes through `Noydb.queryAcross`, not
   * `.join()`.
   */
  /**
   * INNER join (#1361): `{ mode: 'inner' }` drops every left row whose alias
   * resolves to nothing, and types the alias NON-nullable.
   *
   * ```ts
   * invoices.query()
   *   .join<'client', Client>('clientId', { as: 'client', mode: 'inner' })
   *   .orderBy('total', 'desc')
   *   .limit(10)
   * // → the ten largest invoices THAT HAVE a client; `row.client.name` needs
   * //   no null check.
   * ```
   *
   * The long-hand `.join(f, { as }).where(as, '!=', null)` returns the same
   * rows and keeps working unchanged — what it cannot do is keep the sort on
   * the pre-join side. That predicate addresses the alias, so #1030 moves the
   * WHOLE sort and page behind the legs; `mode: 'inner'` moves only the page,
   * because the drop cannot reorder a left-side sort key. `.explain()` says
   * which: `pre-join` on the `orderBy` node, `post-join` on the `page` node.
   *
   * The drop runs after `attachJoin`, so ref-mode semantics are unchanged — a
   * `strict` dangling ref still throws rather than vanishing because the
   * caller asked for an inner join.
   */
  join<As extends string, R = unknown>(
    field: QueryField<T, S>,
    opts: { as: As; mode: 'inner'; strategy?: JoinStrategy; maxRows?: number },
  ): Query<T & Record<As, R>, S, Q, M>
  join<As extends string, R = unknown>(
    field: QueryField<T, S>,
    opts: { as: As; mode?: undefined; strategy?: JoinStrategy; maxRows?: number },
  ): Query<T & Record<As, R | null>, S, Q, M>
  // The implementation signature spans both overloads: the alias is
  // non-nullable only under `mode: 'inner'`, and TS needs a return type both
  // published shapes are assignable to.
  join<As extends string, R = unknown>(
    field: QueryField<T, S>,
    // `| undefined` is load-bearing under `exactOptionalPropertyTypes`: the
    // non-inner overload publishes `mode?: undefined`, and an implementation
    // that omitted it would reject an explicitly-passed `mode: undefined`.
    opts: { as: As; mode?: 'inner' | undefined; strategy?: JoinStrategy; maxRows?: number },
  ): Query<T & Record<As, R>, S, Q, M> | Query<T & Record<As, R | null>, S, Q, M> {
    return this.withJoinLeg(field, opts, 'left') as unknown as Query<T & Record<As, R | null>, S, Q, M>
  }

  /**
   * DECLARED non-equi / non-id join (#1339) — a join whose `on` is data, not
   * a callback.
   *
   * ```ts
   * // composite equality — a hash join over a tuple key
   * entries.query().joinOn<'rate', Rate>('rates', {
   *   as: 'rate',
   *   on: [['clientId', 'clientId'], ['year', 'year']],
   * })
   *
   * // a range — nested loop over a right side sorted once
   * entries.query().joinOn<'rate', Rate>('rates', {
   *   as: 'rate',
   *   on: { left: 'date', op: 'between', right: ['from', 'to'] },
   * })
   * ```
   *
   * ⭐ **Why this exists when `.crossJoin({ on })` already pairs anything.**
   * `crossJoin`'s `on` is a closure. It cannot be serialized, so a
   * materialized view built over one has its drift detection disabled — the
   * plan summary records the sentinel `'[inline]'` and two different
   * predicates hash identically. A `joinOn` predicate is plain JSON: it folds
   * into `toPlan()` and into the MV `queryHash`, so an MV can genuinely
   * DEPEND on it. That, not the pairing, is the feature.
   *
   * **No `ref()` needed** — the predicate names both sides itself, so `target`
   * is the collection name rather than a declared FK field. Dangling is not a
   * concept here: a left row matching nothing gets `null` under the alias (a
   * LEFT outer join, like `.join()`), and `{ mode: 'inner' }` drops it.
   *
   * **⚠️ This join EXPANDS rows.** A ref join is one-to-one, so the left row
   * count is constant; a declared `on` emits one row per MATCH, so a left row
   * matching three right records becomes three rows. The per-side `maxRows`
   * ceilings therefore cannot bound the result, and a third ceiling on the
   * OUTPUT throws `JoinTooLargeError` with `side: 'output'`. Do not remove
   * it: without it an unbounded theta join is a hang, not an error.
   *
   * **Cost.** Composite equality is O(n + m + output). A range is
   * O(m log m) to sort the right side once, then O(log m) per left row for
   * `< <= > >=`; `between` is O(log m + p) per left row, where p is the
   * number of right intervals starting at or before the probe — which
   * degrades to O(n·m) when every interval starts early. `explain()` names
   * which of the two ran. Neither reaches the right collection's declared
   * indexes: a `JoinableSource` does not expose them.
   */
  joinOn<As extends string, R = unknown>(
    target: string,
    opts: { as: As; on: JoinOnSpec; mode: 'inner'; maxRows?: number },
  ): Query<T & Record<As, R>, S, Q, M>
  joinOn<As extends string, R = unknown>(
    target: string,
    opts: { as: As; on: JoinOnSpec; mode?: undefined; maxRows?: number },
  ): Query<T & Record<As, R | null>, S, Q, M>
  joinOn<As extends string, R = unknown>(
    target: string,
    // `| undefined` is load-bearing under `exactOptionalPropertyTypes`, same
    // as `.join()`'s implementation signature.
    opts: { as: As; on: JoinOnSpec; mode?: 'inner' | undefined; maxRows?: number },
  ): Query<T & Record<As, R>, S, Q, M> | Query<T & Record<As, R | null>, S, Q, M> {
    if (!this.joinContext) {
      throw new Error(
        `Query.joinOn() requires a join context. Use collection.query() to construct a ` +
          `join-capable Query instead of the Query constructor directly (the direct ` +
          `constructor is only used for tests with plain-object sources).`,
      )
    }
    // Validated and normalised at PLAN time, never at execution: an `on` that
    // cannot be serialised deterministically must not reach a queryHash.
    const on = normalizeJoinOn(opts.on, target)
    const leg: JoinLeg = {
      // The driving left field. Not a ref — it exists so error messages and
      // `explain()` have something to name, and it is derivable from `on`.
      field: on.kind === 'composite' ? on.pairs[0]![0] : on.left,
      as: opts.as,
      target,
      // There is no ref(), so there is no dangling-ref policy to apply.
      // 'cascade' is the mode that attaches null silently, which is exactly
      // the left-outer behaviour a declared join wants.
      mode: 'cascade',
      strategy: undefined,
      maxRows: opts.maxRows,
      ...(opts.mode === 'inner' ? { inner: true as const } : {}),
      on,
      partitionScope: 'all',
    }
    return new Query<T, S, Q, M>(
      this.source as QuerySource<T>,
      { ...this.plan, joins: [...this.plan.joins, leg] },
      this.joinContext,
      this.reduceStrategy,
      this.predicates,
    ) as unknown as Query<T & Record<As, R | null>, S, Q, M>
  }

  /**
   * RIGHT outer join (#1289): every record of the TARGET collection appears,
   * including one no left row points at. The mirror of `.join()`, which is
   * and always was the left outer join.
   *
   * ```ts
   * invoices.query().rightJoin<'client', Client>('clientId', { as: 'client' })
   * // → one row per invoice/client match, PLUS { client } for every client
   * //   no invoice references. An invoice whose clientId matches nothing is
   * //   dropped — that is what makes it a right join.
   * ```
   *
   * **The row shape is not `T`.** A right-only row carries the alias and
   * nothing else, so the left fields are typed `Partial<T>` — SQL's "the left
   * columns are NULL" in an object language. Read them defensively; a row
   * where `amount` is `undefined` is a real, correct result, not a bug.
   *
   * **Cost.** A forward leg follows the left row's FK and is O(1) per row. A
   * right leg cannot: the rows it must produce are exactly the ones no FK
   * names. It builds a reverse index — the left rows bucketed by FK value —
   * and walks the right snapshot against it. That is one extra pass over the
   * left set and one `Map` the size of the distinct FK values; both sides are
   * fully materialized either way, and both row ceilings still apply.
   *
   * **Ordering.** Like `.join()`, legs run AFTER `orderBy`/`limit`/`offset`
   * unless the ordering addresses the alias (#1337),
   * so those narrow the LEFT side. Rows are emitted in right-snapshot order.
   *
   * A left row whose non-null FK resolves to nothing is dropped, but the
   * ref-mode check still runs on it: `strict` still throws
   * `DanglingReferenceError`. Corruption should not become invisible because
   * the caller changed join direction.
   */
  rightJoin<As extends string, R = unknown>(
    field: QueryField<T, S>,
    opts: { as: As; strategy?: JoinStrategy; maxRows?: number },
  ): Query<Partial<T> & Record<As, R>, S, Q, M> {
    return this.withJoinLeg(field, opts, 'right') as unknown as Query<Partial<T> & Record<As, R>, S, Q, M>
  }

  /**
   * FULL outer join (#1289): the union of `.join()` and `.rightJoin()` —
   * every left row, every right record, matched where they meet.
   *
   * ```ts
   * invoices.query().fullOuterJoin<'client', Client>('clientId', { as: 'client' })
   * // → matched rows, plus { client: null, ...invoice } for an unreferenced
   * //   invoice, plus { client } for a client no invoice points at.
   * ```
   *
   * The alias is `R | null` and the left fields are `Partial<T>`, because a
   * row can be missing either side — never both. Same reverse index, same
   * ordering and same ref-mode semantics as {@link rightJoin}; the only
   * difference is that the unmatched LEFT rows are emitted (after the
   * right-driven ones) instead of dropped.
   */
  fullOuterJoin<As extends string, R = unknown>(
    field: QueryField<T, S>,
    opts: { as: As; strategy?: JoinStrategy; maxRows?: number },
  ): Query<Partial<T> & Record<As, R | null>, S, Q, M> {
    return this.withJoinLeg(field, opts, 'full') as unknown as Query<Partial<T> & Record<As, R | null>, S, Q, M>
  }

  /**
   * The one place a `JoinLeg` is built. `.join()`, `.rightJoin()` and
   * `.fullOuterJoin()` differ ONLY in `direction` and in the type they
   * publish — keeping the plan-time validation (ref declared? dict join?
   * join context?) in a single body is what stops the three from drifting on
   * which errors they raise.
   */
  private withJoinLeg(
    field: string,
    opts: { as: string; mode?: 'inner' | undefined; strategy?: JoinStrategy; maxRows?: number },
    direction: JoinDirection,
  ): Query<T, S, Q, M> {
    if (!this.joinContext) {
      throw new Error(
        `Query.join() requires a join context (same for .rightJoin() and .fullOuterJoin()). Use collection.query() ` +
          `to construct a join-capable Query instead of the Query constructor ` +
          `directly (the direct constructor is only used for tests with ` +
          `plain-object sources).`,
      )
    }
    const descriptor = this.joinContext.resolveRef(field)
    // Check for dictKey join when no ref() is declared
    const isDictJoinField = !descriptor && this.joinContext.resolveDictSource?.(field) != null
    if (!descriptor && !isDictJoinField) {
      // Typed (#1139) so the MV registry can tell "this ref is not declared YET,
      // during openVault" from any other planning failure without matching text.
      throw new RefNotDeclaredError({
        collection: this.joinContext.leftCollection,
        field,
        message:
          `Query.join(): no ref() declared for field "${field}" on collection ` +
          `"${this.joinContext.leftCollection}". Add ` +
          `refs: { ${field}: ref('<target-collection>') } to the collection ` +
          `options, then retry. See the ref() docs for the full list of modes.`,
      })
    }
    // `direction: 'left'` is left OFF the leg rather than written as the
    // default: a plan built by `.join()` must serialize byte-identically to
    // the one it built before #1289, or every stored queryHash moves.
    const directionField = direction === 'left' ? {} : { direction }
    // Same discipline as `directionField` (#1361): a non-inner leg carries no
    // `inner` key at all, so its serialized plan — and its queryHash — is
    // byte-identical to the pre-#1361 one.
    const innerField = opts.mode === 'inner' ? { inner: true as const } : {}
    const leg: JoinLeg = descriptor
      ? {
          field,
          as: opts.as,
          target: descriptor.target,
          mode: descriptor.mode,
          strategy: opts.strategy,
          maxRows: opts.maxRows,
          ...directionField,
          ...innerField,
          // The partition seam — always 'all'. Do not remove, and do not
          // populate without reading JoinLeg.partitionScope's two
          // constraints (#1342): this value is inside every stored MV
          // queryHash. Pinned by __tests__/query-partition-scope.test.ts.
          partitionScope: 'all',
        }
      : {
          // Dict join leg
          field,
          as: opts.as,
          target: field, // dict name = field name for dictKey
          mode: 'strict',
          strategy: opts.strategy,
          maxRows: opts.maxRows,
          partitionScope: 'all',
          ...directionField,
          ...innerField,
          isDictJoin: true,
        }
    return new Query<T, S, Q, M>(
      this.source as QuerySource<T>,
      { ...this.plan, joins: [...this.plan.joins, leg] },
      this.joinContext,
      this.reduceStrategy,
      this.predicates,
    )
  }

  /**
   * Cartesian-product cross-join against `target` collection. Each result row
   * carries the original `T` fields plus `result[as]` populated from every
   * right-side row (or the filtered subset when `on:` is supplied).
   *
   * **⚠️ INNER-join semantics — an empty right subset DROPS the left row.**
   * Each left row is emitted once per matching right row, so when `on:`
   * yields nothing the row vanishes with no error, no warning and no count
   * mismatch. This bites hardest on a reverse FK, where `.join()` (which is
   * forward-only, and already a genuine LEFT outer join) does not apply and
   * `.crossJoin()` is the only tool. To keep the row, return a one-element
   * array holding `null`:
   *
   * ```ts
   * .crossJoin('clients', { as: 'client', on: (b) => byEntity.get(b.entityId) ?? [null] })
   * //                                                                          ^^^^^^^^
   * //                                              the ONLY thing preserving the row
   * ```
   *
   * **Prefer `outer: true`**, which does exactly this and types the alias as
   * `TTarget | null`:
   *
   * ```ts
   * .crossJoin('clients', { as: 'client', outer: true, on: (b) => byEntity.get(b.entityId) ?? [] })
   * ```
   *
   * The `?? [null]` form remains valid and is what `outer` does internally, but
   * it is invisible intent: it types the alias as non-null while the row can
   * hold null, and a later "simplification" that drops it silently
   * reintroduces the row loss.
   *
   * **Order matters:** `.where().crossJoin()` filters BEFORE expanding (cheaper);
   * `.crossJoin().where('alias.field', ...)` filters AFTER (required when the
   * where clause references the aliased fields).
   *
   * **Cost ceiling:** `CrossJoinTooLargeError` fires before allocation when
   * `leftRows × rightRows` (or the cumulative lateral count) exceeds the limit.
   * Default: 50,000 rows. Override per-clause with `{ maxRows: N }`.
   *
   * **`on:` shapes:**
   *   - `on: (left) => TTarget[]`              — subset form (most efficient)
   *   - `on: (left) => (right) => boolean`     — predicate form
   *   - `on: { predicate: 'name' }`            — MV-safe, hash-tracked form
   *     (requires the Query to have been augmented via `_withPredicates`)
   *
   * Requires a JoinContext (constructed via `collection.query()`).
   */
  crossJoin<TTarget = unknown, As extends string = string, TOuter extends boolean = false>(
    target: string,
    opts: {
      as: As
      on?:
        | ((left: T) => unknown[] | ((right: TTarget) => boolean))
        | { readonly predicate: string }
      maxRows?: number
      /**
       * Keep the left row when its right side is empty, with `null` under
       * `as`, instead of dropping it (#1130). Widens the alias to
       * `TTarget | null` — which is why it is a type parameter rather than a
       * plain boolean: `outer: false` must not pay for a null the row can
       * never hold.
       */
      outer?: TOuter
    },
  ): Query<T & { [K in As]: TOuter extends true ? TTarget | null : TTarget }, S, Q, M> {
    if (!this.joinContext) {
      throw new Error(
        `Query.crossJoin("${target}"): requires a join context. ` +
          `Use collection.query() to construct a cross-join-capable Query instead of ` +
          `the Query constructor directly.`,
      )
    }

    let onFn: CrossJoinClause['on']
    let onPredicateName: string | undefined

    if (opts.on !== undefined) {
      if (typeof opts.on === 'function') {
        onFn = opts.on as CrossJoinClause['on']
        if (this.predicates) {
          console.warn(
            `Query.crossJoin("${target}", { on: callback }): inline on: callback inside a ` +
              `withMaterializedView query() disables queryHash drift detection for this cross-join. ` +
              `Use on: { predicate: '<name>' } to enable it.`,
          )
        }
      } else {
        const predName = (opts.on as { predicate: string }).predicate
        if (!this.predicates) {
          throw new Error(
            `Query.crossJoin("${target}", { on: { predicate: "${predName}" } }): ` +
              `the { predicate } form requires a predicates map. ` +
              `Use this form inside a withMaterializedView query() callback that declares ` +
              `predicates: { ${predName}: { hash, fn } }.`,
          )
        }
        const decl = this.predicates.get(predName)
        if (!decl) {
          throw new Error(
            `Query.crossJoin("${target}"): predicate "${predName}" not registered. ` +
              `Available: ${[...this.predicates.keys()].join(', ') || '(none)'}.`,
          )
        }
        const as = opts.as
        const predicateFn = decl.fn
        onFn = (_left: unknown): ((right: unknown) => boolean) =>
          (right: unknown) =>
            predicateFn({ ...(_left as Record<string, unknown>), [as]: right })
        onPredicateName = predName
      }
    }

    const clause: CrossJoinClause = {
      type: 'crossJoin',
      target,
      as: opts.as,
      ...(onFn !== undefined && { on: onFn }),
      ...(onPredicateName !== undefined && { onPredicateName }),
      ...(opts.maxRows !== undefined && { maxRows: opts.maxRows }),
      ...(opts.outer === true && { outer: true as const }),
    }

    type Row = T & { [K in As]: TOuter extends true ? TTarget | null : TTarget }
    return new Query<Row, S, Q, M>(
      this.source as unknown as QuerySource<Row>,
      { ...this.plan, clauses: [...this.plan.clauses, clause] },
      this.joinContext,
      this.reduceStrategy,
      this.predicates,
    )
  }

  /**
   * Self cross-join with BOTH sides aliased (#1289).
   *
   * ```ts
   * const pairs = trades.query()
   *   .crossJoinWith({ leftAs: 'a', rightAs: 'b', on: (t) => laterThan(t) })
   *   .toArray()
   * // → [{ a: Trade, b: Trade }, ...]  — no field at the top level
   * ```
   *
   * `.crossJoin('trades', { as: 'other' })` can already pair a collection
   * with itself, but only ASYMMETRICALLY: the left row's fields stay at the
   * top level and only the right side gets a name. Every comparison then
   * reads `r.amount` against `r.other.amount`, which is exactly the shape
   * that makes an accidentally-transposed pair invisible.
   *
   * ⚠️ **The cost is not the join, it is the Via dressing.** Aliasing the
   * left row moves every field off the top level, and the money / i18n /
   * lookup pipeline keys by BARE FIELD NAME — so the plain top-level decode
   * `toArray()` applies cannot see either side. Both aliases are therefore
   * dressed explicitly, through the source's own Via result decode, before
   * the rows are returned. Silently serving raw money under an alias is the
   * failure this method exists to not have; `dressAliases` is where it is
   * prevented and `__tests__/query-outer-join.test.ts` is what proves it.
   *
   * `on:` takes the same subset / predicate shapes as `.crossJoin()`, and the
   * same `maxRows` ceiling applies to the product. The target is always this
   * query's own collection — a cross-join against a DIFFERENT collection is
   * `.crossJoin()`, which needs no left alias to stay unambiguous.
   *
   * The returned `Query` drops this query's schema / queryable / money field
   * parameters. That is not laziness: those parameters name TOP-LEVEL fields,
   * and after `crossJoinWith` there are no top-level fields — only the two
   * aliases. Carrying them would let `where('amount', ...)` type-check on a
   * row where `amount` does not exist.
   */
  crossJoinWith<LeftAs extends string, RightAs extends string>(
    opts: {
      leftAs: LeftAs
      rightAs: RightAs
      on?: ((left: T) => unknown[] | ((right: T) => boolean)) | { readonly predicate: string }
      maxRows?: number
    },
  ): Query<{ [K in LeftAs]: T } & { [K in RightAs]: T }> {
    if (!this.joinContext) {
      throw new Error(
        `Query.crossJoinWith(): requires a join context. ` +
          `Use collection.query() to construct a cross-join-capable Query instead of ` +
          `the Query constructor directly.`,
      )
    }
    if ((opts.leftAs as string) === (opts.rightAs as string)) {
      throw new Error(
        `Query.crossJoinWith({ leftAs: "${opts.leftAs}", rightAs: "${opts.rightAs}" }): ` +
          `the two aliases must differ — a self cross-join whose sides share a name ` +
          `would emit the right row under both and silently lose the left one.`,
      )
    }
    // Built through `.crossJoin()` so the `on:`-shape validation, the
    // predicate-map lookup and the queryHash-drift warning have exactly one
    // implementation; `leftAs` is then folded into the clause it produced.
    const built = this.crossJoin<T, RightAs, false>(this.joinContext.leftCollection, {
      as: opts.rightAs,
      ...(opts.on !== undefined && { on: opts.on }),
      ...(opts.maxRows !== undefined && { maxRows: opts.maxRows }),
    })
    const plan = built._plan()
    const last = plan.clauses[plan.clauses.length - 1] as CrossJoinClause
    const clauses = [...plan.clauses.slice(0, -1), { ...last, leftAs: opts.leftAs }]
    type Row = { [K in LeftAs]: T } & { [K in RightAs]: T }
    return new Query<T, S, Q, M>(
      this.source as QuerySource<T>,
      { ...plan, clauses },
      this.joinContext,
      this.reduceStrategy,
      this.predicates,
    ) as unknown as Query<Row>
  }

  /**
   * Execute the plan and return the matching records. When the plan
   * carries any join legs, they are applied after `where` / `orderBy`
   * / `limit` / `offset` narrow the left set — UNLESS a clause (#1030) or
   * the ordering (#1337) addresses a join alias, in which case the legs run
   * first and the sort/page observe the joined relation. See the `.join()`
   * doc for the ordering rationale, and `.explain()` for which one a given
   * plan gets.
   *
   * `opts.locale` resolves JOINED right-side i18n fields at the
   * `join` layer to that locale; without it, the owning collection's default
   * locale applies, and a locale-less query leaves joined i18n fields raw.
   * (Left/base i18n fields are resolved by `get`/`list`, not here.)
   *
   * **Synchronous** (#1413) — returns `T[]`, not a promise; the cache it reads is
   * already decrypted. `await` is safe and is REQUIRED on an unhydrated collection
   * (#1414); `.catch()` is not available. See the {@link Query} class doc.
   */
  toArray(opts?: { locale?: string }): T[] {
    const _h = this.source.hydration
    if (_h !== undefined && !_h.isHydrated()) return gateTerminal(_h, 'toArray', () => this.toArray(opts))
    // A cursor was applied: the window is decided by the keyset, not by
    // offset/limit slicing. Same rows `page()` would serve, same signature.
    if (this.plan.after !== undefined) return this.executeKeyset(opts).rows

    const { preJoin, postJoin } = splitAroundJoins(this.plan.clauses, this.plan.joins)
    // #1337 — an ORDERING that addresses an alias moves the sort/page after
    // the legs for exactly the reason #1030's predicate did: the field does
    // not exist yet. The failure was quieter than #1030's, not louder — every
    // sort key read `undefined`, so the sort was a stable no-op and the page
    // came back in insertion order looking merely unlucky.
    const orderPostJoin = orderReferencesJoinAlias(this.plan.orderBy, this.plan.joins)

    // #1361 — an inner leg DROPS left rows, so pagination cannot precede it.
    // The SORT still can: the ordering is on a left-side field (an ordering on
    // the alias is `orderPostJoin` above), and removing rows never reorders the
    // ones that remain. So this path keeps the pre-join sort — index-driven
    // narrowing and all — and moves only offset/limit behind the legs.
    const innerDrops = joinsDropLeftRows(this.plan.joins)

    if (postJoin.length === 0 && !orderPostJoin) {
      // Decode Via-covered fields (e.g. money: stored scaled-int → canonical
      // decimal) so query().toArray() matches get()/sum(), which already
      // apply the same decode. Decode the left/base records before joins
      // (right-side aliased fields belong to other collections and are out
      // of this source's Via scope).
      const pagePlan = innerDrops ? { ...this.plan, offset: 0, limit: undefined } : this.plan
      const base = this.decodeVia(
        executePlanWithSource(this.source, pagePlan, this.joinContext, opts?.locale, this.aliasVia()),
      )
      if (this.plan.joins.length === 0) return this.dressAliases(base) as T[]
      const joined = applyJoins(base, this.plan.joins, this.requireJoinContext('toArray'), opts?.locale)
      if (!innerDrops) return this.dressAliases(joined) as T[]
      const from = this.plan.offset
      return this.dressAliases(
        this.plan.limit === undefined ? joined.slice(from) : joined.slice(from, from + this.plan.limit),
      ) as T[]
    }

    // #1030 — at least one predicate addresses a join alias, so it cannot be
    // evaluated until the legs are attached. Narrow with the pre-join clauses
    // (still index-driven), join, then filter, and only THEN sort/paginate:
    // ordering and limit must observe the post-join predicate, not precede it.
    //
    // The left-side JoinTooLargeError ceiling is now measured against the
    // pre-join set only. That is inherent — a predicate on an alias cannot
    // narrow a set the alias does not exist in yet — and a loud ceiling error
    // beats today's silent empty result.
    const joinContext = this.requireJoinContext('toArray')
    const narrowed = this.decodeVia(
      executePlanWithSource(
        this.source,
        { ...this.plan, clauses: preJoin, orderBy: [], limit: undefined, offset: 0 },
        joinContext,
        opts?.locale,
      ),
    )
    const joined = applyJoins(narrowed, this.plan.joins, joinContext, opts?.locale)
    const filtered = filterRecords(joined, postJoin, fnViewDecoder(this.source))
    return this.dressAliases(
      applyOrderAndPage(filtered, this.plan, this.source, joinContext, opts?.locale, this.aliasVia()),
    ) as T[]
  }

  /**
   * Apply each aliased side's OWN Via result decode, in place of the
   * top-level decode that cannot reach it (#1289, and the fix for #1335).
   *
   * `decodeVia` keys by bare field name, so it dresses exactly the fields
   * sitting at the top of the row. Everything a join puts under an alias —
   * a `.join()`/`.rightJoin()` right record, a `.crossJoin()` right record,
   * and BOTH sides of a `.crossJoinWith()` pair — is therefore invisible to
   * it, and was served raw: a self cross-join returned `"10.00"` on the left
   * and `"1000"` on the right of the same field (#1335).
   *
   * Runs LAST, after every filter, sort and page. That is deliberate: a
   * `where()` operand is built in raw stored space, so dressing earlier would
   * make a post-join predicate compare a decoded string against a raw one.
   * Dressing is presentation; it belongs after the plan has finished.
   *
   * Each alias is decoded by the Via pipeline of the collection the record
   * came FROM — money on the right side is the right side's declaration, not
   * this collection's. A source that declares no result decode returns the
   * record unchanged, so the whole pass is a no-op for the common query and
   * is skipped entirely when the plan has no aliases.
   */
  private dressAliases(rows: readonly unknown[]): unknown[] {
    if (rows.length === 0) return rows as unknown[]
    const ctx = this.joinContext
    if (!ctx) return rows as unknown[]

    const targets: { path: string; decode: (r: unknown) => unknown }[] = []
    const push = (path: string, collection: string): void => {
      const decode = ctx.resolveSource(collection)?.decodeResults
      if (decode) targets.push({ path, decode })
    }
    for (const clause of this.plan.clauses) {
      if (clause.type !== 'crossJoin') continue
      push(clause.as, clause.target)
      // The left half of a `crossJoinWith` pair is THIS collection's record,
      // moved under an alias — its decode is this source's own.
      if (clause.leftAs !== undefined) push(clause.leftAs, ctx.leftCollection)
    }
    for (const leg of this.plan.joins) {
      // A dict join attaches `{ key, ...labels }`, not a collection record —
      // there is no Via pipeline behind it to decode.
      if (leg.isDictJoin === true) continue
      push(leg.as, leg.target)
    }
    if (targets.length === 0) return rows as unknown[]

    return rows.map(row => {
      if (row === null || typeof row !== 'object') return row
      let out: Record<string, unknown> | undefined
      for (const { path, decode } of targets) {
        const value = (row as Record<string, unknown>)[path]
        if (value === null || value === undefined || typeof value !== 'object') continue
        const dressed = decode(value)
        if (dressed === value) continue
        out ??= { ...(row as Record<string, unknown>) }
        out[path] = dressed
      }
      return out ?? row
    })
  }

  /**
   * Alias → the Via pipeline of the collection whose records sit under it
   * (#1337). Every alias this plan can produce: a `.join()`/`.rightJoin()`
   * leg, a `.crossJoin()` right side, and both sides of `.crossJoinWith()`.
   *
   * ⭐ **Ordering compares in RAW STORED SPACE, never in dressed space, and
   * that is what forces this map to exist.** `dressAliases` runs LAST — after
   * every filter, sort and page — because a `where` operand is built raw. So
   * the sort sees money as its stored scaled integer, where a generic compare
   * is lexical and gets `'9882'` vs `'10004'` backwards. The left side has
   * always avoided that by asking `source.via.compareForOrder`; an aliased
   * field needs the same question asked of the RIGHT side's pipeline, keyed
   * by the field name WITHOUT the alias prefix (a pipeline covers bare field
   * names — that is the whole of #1335's shape).
   *
   * Empty when no alias resolves a pipeline, in which case the comparator
   * falls back to exactly what it did before.
   */
  private aliasVia(): ReadonlyMap<string, ViaPipeline> | undefined {
    const ctx = this.joinContext
    if (!ctx) return undefined
    const out = new Map<string, ViaPipeline>()
    const push = (alias: string, collection: string): void => {
      const via = ctx.resolveSource(collection)?.via?.()
      if (via) out.set(alias, via)
    }
    for (const clause of this.plan.clauses) {
      if (clause.type !== 'crossJoin') continue
      push(clause.as, clause.target)
      if (clause.leftAs !== undefined) push(clause.leftAs, ctx.leftCollection)
    }
    for (const leg of this.plan.joins) {
      // A dict join attaches `{ key, ...labels }` — no collection pipeline.
      if (leg.isDictJoin === true) continue
      push(leg.as, leg.target)
    }
    return out.size > 0 ? out : undefined
  }

  /**
   * The right-side change streams a joined query has to merge (#1338), deduped
   * by target the way `live()` does — a chain joining the same collection
   * twice must not double-fire. Extracted so a joined REDUCTION and a joined
   * live query cannot disagree on what "the sources of this result" means.
   */
  private rightSideUpstreams(): ReductionUpstream[] {
    const ctx = this.joinContext
    if (!ctx) return []
    const out: ReductionUpstream[] = []
    const seen = new Set<string>()
    for (const leg of this.plan.joins) {
      if (seen.has(leg.target)) continue
      seen.add(leg.target)
      const right = ctx.resolveSource(leg.target)
      if (!right?.subscribe) continue
      const subscribe = right.subscribe.bind(right)
      out.push({ subscribe: (cb: () => void) => subscribe(cb) })
    }
    return out
  }

  /**
   * Every alias this plan can produce, pipeline or not (#1338).
   *
   * `aliasVia()` above holds only the aliases whose collection compiles a Via
   * pipeline; refusal has to know about ALL of them, or an aliased reducer
   * over a plain right-side collection stays silent.
   */
  private aliasNames(): ReadonlySet<string> {
    const out = new Set<string>()
    for (const clause of this.plan.clauses) {
      if (clause.type !== 'crossJoin') continue
      out.add(clause.as)
      if (clause.leftAs !== undefined) out.add(clause.leftAs)
    }
    for (const leg of this.plan.joins) out.add(leg.as)
    return out
  }

  /** Is `field` rooted at an alias this plan produces? */
  private addressesAlias(field: string, aliases: ReadonlySet<string>): boolean {
    const dot = field.indexOf('.')
    return dot > 0 && aliases.has(field.slice(0, dot))
  }

  /**
   * Joins need a `JoinContext`. Unreachable in practice — `.join()` throws
   * when one is missing — but belt-and-braces for a plan built through the
   * raw `Query` constructor with joins pre-populated.
   */
  private requireJoinContext(terminal: string): JoinContext {
    if (!this.joinContext) {
      throw new Error(
        `Query.${terminal}(): plan carries ${this.plan.joins.length} join leg(s) ` +
          `but no JoinContext is attached. This usually means the Query was ` +
          `constructed via the raw Query constructor with a plan that had joins ` +
          `pre-populated. Use collection.query().join(...) instead.`,
      )
    }
    return this.joinContext
  }

  /**
   * Decode this source's Via-covered fields on read (e.g. money: stored
   * scaled-int → canonical decimal), so `query().toArray()` agrees with
   * `get()`/`sum()` on the value. No-op when the source's Via pipeline
   * declares no result decode.
   *
   * The query layer carries no locale context, so money decodes with
   * `'raw'` — canonical decimal, WITHOUT fabricating locale-formatted
   * `<field>Formatted` / `<field>Number` virtuals. Producing a
   * guessed-locale string here would reintroduce a "two read paths
   * disagree" failure on the virtual field (e.g. it-IT via `get()` vs
   * en-US here). Consumers who need formatted money read through
   * `get()`/`list()` with a locale.
   */
  private decodeVia(records: readonly unknown[]): unknown[] {
    const via = this.source.via
    if (!via || !via.hasResultDecode) return records as unknown[]
    return records.map(r => via.decodeResults(r))
  }

  /**
   * Terminal sibling of `toArray()` that also returns the cursor for the next
   * page (#1346): `{ rows, nextCursor }`, where `nextCursor` is `null` once
   * the last page has been served.
   *
   * ```ts
   * const { rows, nextCursor } = people.query().orderBy('name').limit(20).page()
   * ```
   *
   * Without a sorted index this is still a scan with a keyset filter — stable,
   * not fast. The fast path is a separate concern (#1344).
   *
   * Same requirements as `.after()`: at least one `orderBy(...)`, an id-paired
   * (collection-backed) source, no join legs, no `offset()`.
   *
   * **Synchronous** (#1413) — returns `{ rows, nextCursor }`, not a promise; the cache it reads is
   * already decrypted. `await` is safe and is REQUIRED on an unhydrated collection
   * (#1414); `.catch()` is not available. See the {@link Query} class doc.
   */
  page(opts?: { locale?: string }): { rows: T[]; nextCursor: string | null } {
    const _h = this.source.hydration
    if (_h !== undefined && !_h.isHydrated()) return gateTerminal(_h, 'page', () => this.page(opts))
    return this.executeKeyset(opts)
  }

  /**
   * The keyset engine behind `page()` / `after()`.
   *
   * It deliberately does NOT reuse `applyOrderAndPage`: paging by keyset needs
   * a TOTAL order (the id breaks ties that the ordinary sort leaves to input
   * order) and needs the id alongside each row to mint the cursor. Both are
   * properties of this path only, so the ordinary read path is untouched.
   */
  private executeKeyset(opts?: { locale?: string }): { rows: T[]; nextCursor: string | null } {
    const plan = this.plan
    if (plan.orderBy.length === 0) {
      throw new Error(
        'Query.page()/after(): keyset pagination requires at least one orderBy(...) — ' +
          'a cursor names a position in a sort order, so there must be one to name.',
      )
    }
    if (plan.offset > 0) {
      throw new Error(
        'Query.page()/after(): offset() cannot be combined with a keyset cursor. ' +
          'They are two different pagination strategies — drop offset() and page with after(nextCursor).',
      )
    }
    if (plan.joins.length > 0 || plan.clauses.some(c => c.type === 'crossJoin')) {
      throw new Error(
        'Query.page()/after(): keyset pagination does not support join legs or crossJoin ' +
          '(joined rows are new objects, so the record id the cursor needs is not recoverable). ' +
          'Page the left side, then join per page.',
      )
    }
    // #1417 — the PRESENCE check, not the call. Materializing the id-paired
    // snapshot is O(n) and allocates a fresh array plus an object per row; on
    // a memo hit nothing below needs it, and paying for it here made the fast
    // path linear in the collection again. Arrow-bound so `this` cannot drift
    // (same discipline as `candidateRecords`).
    const source = this.source
    const snapshotEntries = source.snapshotEntries === undefined
      ? undefined
      : (): readonly { id: string; record: unknown }[] => source.snapshotEntries!()
    if (snapshotEntries === undefined) {
      throw new Error(
        'Query.page()/after(): the query source has no snapshotEntries(); keyset pagination ' +
          'requires a collection-backed query (collection.query()).',
      )
    }
    // ⛔ #1417 — EVERY LINE BELOW USED TO RUN PER PAGE. Building `refToId`,
    // re-matching, computing an order key per row, and sorting the whole
    // collection are each O(n) or worse, so a 100-page walk of a 10k
    // collection paid ~100 full sorts: measured 4.4 ms/page against a 0.3 ms
    // first page, which is the opposite of what keyset paging is for. Nothing
    // here was seeking linearly by design — the linear seek below was merely
    // the cheapest of four O(n) passes.
    //
    // The order is a pure function of (matched set, order spec, locale), and
    // the cache tells us when the matched set can have moved, so the whole
    // block is memoized on the source's mutation counter. `after()` then
    // BISECTS a run it already holds.
    const memoKey = keysetMemoKey(this.source, plan, opts?.locale)
    const cached = memoKey === null ? undefined : readKeysetMemo(memoKey)
    let sorted: KeysetRow[]
    let keyPlan: OrderKeyPlan
    if (cached) {
      sorted = cached.sorted
      keyPlan = cached.keyPlan
    } else {
      const refToId = new Map<unknown, string>()
      for (const { id, record } of snapshotEntries()) refToId.set(record, id)

      // Match without ordering or paging — this path owns both.
      const matched = executePlanWithSource(
        this.source,
        { ...plan, orderBy: [], limit: undefined, offset: 0, after: undefined },
        this.joinContext,
        opts?.locale,
      )

      const labelMaps = buildOrderLabelMaps(plan.orderBy, this.joinContext, opts?.locale, this.source.via)
      keyPlan = buildOrderKeyPlan(plan.orderBy, this.source.via, labelMaps)
      sorted = matched
        .map(record => ({ record, id: refToId.get(record) ?? '', key: orderKeyOf(keyPlan, record) }))
        .sort((a, b) => compareOrderKeys(keyPlan, a.key, b.key) || compareIds(a.id, b.id))
      if (memoKey !== null) writeKeysetMemo(memoKey, { sorted, keyPlan })
    }

    const shape = keysetShape(this.source.identity, plan.orderBy)
    let start = 0
    if (plan.after !== undefined) {
      const cursor = decodeCursor(plan.after, shape)
      // Strictly after the cursor's position. The row itself may be gone —
      // that is exactly the case an offset cannot survive, and a bisect
      // survives it for the same reason a scan did: the predicate is
      // "ordered strictly after this key", not "equals this row".
      //
      // `sorted` is totally ordered by (key, id) — the sort comparator above
      // breaks every tie on the id — so the predicate is monotone and a
      // binary search finds the same index `findIndex` did, in O(log n).
      start = lowerBound(
        sorted,
        r => (compareOrderKeys(keyPlan, r.key, cursor.values) || compareIds(r.id, cursor.id)) > 0,
      )
    }

    const end = plan.limit === undefined ? sorted.length : start + plan.limit
    const window = sorted.slice(start, end)
    const last = window[window.length - 1]
    const nextCursor =
      last !== undefined && end < sorted.length
        ? encodeCursor({ shape, values: last.key, id: last.id })
        : null
    return { rows: this.decodeVia(window.map(r => r.record)) as T[], nextCursor }
  }

  /**
   * Return the first matching record, or null. Joins are applied. `opts.locale`
   * resolves joined i18n fields.
   *
   * **Synchronous** (#1413) — returns `T | null`, not a promise; the cache it reads is
   * already decrypted. `await` is safe and is REQUIRED on an unhydrated collection
   * (#1414); `.catch()` is not available. See the {@link Query} class doc.
   */
  first(opts?: { locale?: string }): T | null {
    const _h = this.source.hydration
    if (_h !== undefined && !_h.isHydrated()) return gateTerminal(_h, 'first', () => this.first(opts))
    const arr = this.limit(1).toArray(opts)
    return arr[0] ?? null
  }

  /**
   * Return the number of matching records (after where/filter,
   * before limit). **Joins are normally NOT applied** — count() reports the
   * left-side cardinality, because joins are projection-only
   * (they attach an aliased field; they never filter). Running joins
   * here just to discard the aliases would be wasteful, and in strict
   * mode it could throw `DanglingReferenceError` for a call whose
   * intent is purely to count.
   *
   * The exception (#1030) is a `where` clause addressing a join alias. Then
   * the legs must run, because the predicate is part of what is being
   * counted — skipping them would report the unfiltered left cardinality.
   * A strict-mode `DanglingReferenceError` becomes reachable from `count()`
   * in exactly that case, which is acceptable: the caller asked to filter on
   * the joined side, so they asked for the join.
   *
   * **Synchronous** (#1413) — returns `number`, not a promise; the cache it reads is
   * already decrypted. `await` is safe and is REQUIRED on an unhydrated collection
   * (#1414); `.catch()` is not available. See the {@link Query} class doc.
   */
  count(): number {
    const _h = this.source.hydration
    if (_h !== undefined && !_h.isHydrated()) return gateTerminal(_h, 'count', () => this.count())
    return this.matchedRecords('count').length
  }

  /**
   * The match set every reduce-shaped terminal reports over: `count()`,
   * `distinct()`, and `exists()`'s non-short-circuit fallbacks.
   *
   * Extracted (#1347) rather than copied a third time, because "which records
   * does this terminal see" is an INVARIANT across them — `distinct()`
   * returning values `count()` never counted would be a bug nobody would look
   * for. It is deliberately the `count()` pipeline: where/filter apply, joins
   * apply only when a predicate addresses one (#1030), and orderBy/limit/offset
   * do NOT — those describe a page, and a reduction is not paginated.
   */
  private matchedRecords(terminal: string, forceJoins = false): readonly unknown[] {
    if (this.plan.clauses.some(c => c.type === 'crossJoin')) {
      if (!this.joinContext) {
        throw new Error(
          `Query.${terminal}(): plan contains crossJoin clauses but no JoinContext is attached.`,
        )
      }
      return executeClausePipeline(this.source, this.plan.clauses, this.joinContext)
    }
    // Use the same index-aware candidate machinery as toArray(); skip the
    // index-driving clause from re-evaluation. The length BEFORE limit/offset
    // is what `count()` documents.
    const { preJoin, postJoin } = splitAroundJoins(this.plan.clauses, this.plan.joins)
    const { candidates, remainingClauses } = candidateRecords(this.source, preJoin)
    const narrowed =
      remainingClauses.length === 0
        ? candidates
        : filterRecords(candidates, remainingClauses, fnViewDecoder(this.source))
    // #1289 — a left leg is projection-only, so the left match set IS the
    // answer. A right/full leg is not: it adds a row per unreferenced right
    // record and (for 'right') drops the unmatched left ones. Those legs have
    // to run or every reduce-shaped terminal is simply wrong — #1289 found
    // this for count(), and it holds identically for distinct() and exists()
    // now that #1347 made them share this pipeline.
    // #1361 adds a third reshaping leg: an INNER leg drops the left rows whose
    // alias resolved to nothing, so the left match set is no longer the answer.
    const reshapes =
      this.plan.joins.some(leg => leg.direction !== undefined && leg.direction !== 'left') ||
      joinsDropLeftRows(this.plan.joins)
    // #1338 — `forceJoins` is the third reason the legs have to run: a group
    // key or a reducer addresses an alias, so the relation being reduced IS
    // the joined one. Same pipeline, same order; only the entry condition is
    // new, which is what keeps "which records does this terminal see" one
    // definition rather than four.
    if (postJoin.length === 0 && !reshapes && !forceJoins) return narrowed
    // #1030 — the predicate lives on the joined side, so the legs are part of
    // the count. Same pipeline as toArray(), minus ordering and pagination.
    const joined = applyJoins(narrowed, this.plan.joins, this.requireJoinContext(terminal))
    return filterRecords(joined, postJoin, fnViewDecoder(this.source))
  }

  /**
   * The distinct values of `field` across the match set (#1347) — the
   * declarative form of `new Set(q.toArray().map(r => r[field]))`, which is
   * what consumers write today and which is wrong in two ways this is not.
   *
   * **Distinctness is decided on the canonical index key, not on the value
   * you get back.** For a Via-covered field that is the difference between a
   * right answer and a plausible one: money stores a scaled integer, and a
   * row written before the field was declared can spell it non-canonically
   * (`'0100'` for `'100'`). Deduping the stored strings reports two values
   * where there is one; deduping the FORMATTED strings makes the answer
   * depend on a locale this layer does not have (`'10.00'` vs `'10,00'`).
   * See `distinct-key.ts`. The values RETURNED are the decoded ones, so they
   * match what `toArray()` hands back for the same field.
   *
   * **Nullish values are excluded** — `null`/`undefined`/missing is the
   * absence of a value, not a distinct one. That is also the only choice
   * under which the index-backed and scanned paths can agree, since the hash
   * index does not hold nullish keys; see `distinctKeyOf`.
   *
   * Same match set as `count()`: where/filter apply, orderBy/limit/offset do
   * not. Values come back in first-encountered order.
   *
   * ⭐ INDEX-BACKED when the field carries a hash index AND the plan narrows
   * nothing — the buckets ARE the distinct key set, so the answer costs
   * O(distinct values) instead of O(records) and never decrypts a snapshot.
   * The guard is deliberately all-or-nothing: with a where clause the whole
   * collection's buckets are not the answer, and intersecting a candidate id
   * set with every bucket would cost more than the scan it replaced.
   *
   * ⛔ THE RETURN TYPE IS `(T & Record<F, unknown>)[F][]`, NOT
   * `F extends keyof T ? T[F][] : unknown[]` — and it must stay that way. The
   * conditional form reads better and type-checks at every call site, but a
   * DEFERRED conditional over `T` makes TypeScript give up relating
   * `Query<T>` to `Query<unknown>`, which makes `Collection<T>` invariant in
   * `T`, which breaks `vault.ts`'s `Map<string, Collection<unknown>>` cache
   * with four errors that name neither this method nor this file. The
   * intersection form resolves to the same thing (`T[F]` for a literal key,
   * `unknown` for a `string`-typed one) and stays covariant.
   */
  distinct<F extends QueryField<T, S>>(field: F): (T & Record<F, unknown>)[F][] {
    const name = field as string
    assertNoJoinAliasField([name], this.plan.joins, 'distinct')
    const via = this.source.via
    // Same posture gate `.where()` / `.orderBy()` apply: a `queryable: 'none'`
    // field (a blob handle) must not have its value set enumerated either.
    if (via?.postureFor(name)?.queryable === 'none') throw new FieldNotQueryableError(name)
    const decode = via?.hasResultDecode ? (r: unknown) => via.decodeResults(r) : (r: unknown) => r

    const indexes =
      this.plan.clauses.length === 0 && this.plan.joins.length === 0
        ? this.source.getIndexes?.()
        : undefined
    if (indexes && this.source.lookupById) {
      const lookupById = (id: string): unknown => this.source.lookupById?.(id)
      const reps = indexes.bucketRepresentatives(name)
      if (reps) {
        const fromIndex: unknown[] = []
        for (const id of reps) {
          const record = lookupById(id)
          if (record === undefined) continue
          fromIndex.push(readPath(decode(record), name))
        }
        return fromIndex as (T & Record<F, unknown>)[F][]
      }
    }

    const seen = new Set<string>()
    const out: unknown[] = []
    for (const record of this.matchedRecords('distinct')) {
      const key = distinctKeyOf(name, readPath(record, name), via)
      if (key === undefined || seen.has(key)) continue
      seen.add(key)
      out.push(readPath(decode(record), name))
    }
    return out as (T & Record<F, unknown>)[F][]
  }

  /**
   * Whether ANY record matches (#1347) — `count() > 0` without paying for the
   * records after the first.
   *
   * The saving is real rather than cosmetic: `count()` evaluates every
   * remaining clause against every candidate, so a `.filter(fn)` over 10_000
   * records calls `fn` 10_000 times to answer a yes/no question. This returns
   * at the first hit, and `__tests__/query-distinct-exists.test.ts` witnesses
   * that by COUNTING the predicate's invocations — a boolean assertion cannot
   * tell a short-circuit from a full scan.
   *
   * Same match set as `count()`. Two shapes do NOT short-circuit and fall
   * back to it, because both must materialize the relation before anything
   * can be tested: a `crossJoin` expansion, and a `where` clause addressing a
   * join alias (#1030). Both still answer correctly.
   *
   * **Synchronous** (#1413) — returns `boolean`, not a promise; the cache it reads is
   * already decrypted. `await` is safe and is REQUIRED on an unhydrated collection
   * (#1414); `.catch()` is not available. See the {@link Query} class doc.
   */
  exists(): boolean {
    const _h = this.source.hydration
    if (_h !== undefined && !_h.isHydrated()) return gateTerminal(_h, 'exists', () => this.exists())
    if (this.plan.clauses.some(c => c.type === 'crossJoin')) {
      return this.matchedRecords('exists').length > 0
    }
    const { preJoin, postJoin } = splitAroundJoins(this.plan.clauses, this.plan.joins)
    // #1361 — an inner leg can empty a non-empty candidate set, so the
    // short-circuit below (which never runs the legs) would answer `true` for a
    // query whose every row is unmatched. Same reason #1030 falls back.
    if (postJoin.length > 0 || joinsDropLeftRows(this.plan.joins)) {
      return this.matchedRecords('exists').length > 0
    }
    const { candidates, remainingClauses } = candidateRecords(this.source, preJoin)
    // The index answered the whole predicate — its candidate set IS the match
    // set, so emptiness is the answer and nothing needs evaluating.
    if (remainingClauses.length === 0) return candidates.length > 0
    return anyMatches(candidates, remainingClauses, fnViewDecoder(this.source))
  }

  /**
   * Reduce the matching records through a named set of reducers.
   * the aggregation terminal.
   *
   * ```ts
   * const { total, n, avgAmount } = invoices.query()
   *   .where('status', '==', 'open')
   *   .aggregate({
   *     total:     sum('amount'),
   *     n:         count(),
   *     avgAmount: avg('amount'),
   *   })
   *   .run()
   * ```
   *
   * Returns an `Reduction<R>` wrapper with two terminals:
   *   - `.run(): R` — synchronous one-shot reduction
   *   - `.live(): LiveReduction<R>` — reactive primitive that
   *     re-runs the reduction whenever the source notifies of a
   *     change. Always call `live.stop()` when finished.
   *
   * The reducer spec is bound here once and reused by both
   * terminals — this is why `.aggregate()` returns a wrapper instead
   * of being a direct terminal. Consumers who only need the static
   * value read `.run()`; consumers wiring a reactive UI read
   * `.live()`.
   *
   * Joins are NOT applied by default — the same logic as `.count()`. A leg is
   * projection-only, so running one just to throw the alias away would be
   * wasteful. ⭐ **The exception is a reducer that ADDRESSES an alias**
   * (#1338): then the joined relation IS what is being reduced, so the legs
   * run and the reducer is rewritten by the right collection's own Via
   * pipeline — money stays exact, and the right side's `queryable: 'none'`
   * posture refuses a field it would refuse locally. A live joined
   * aggregation also merges every right-side change stream, so it does not
   * quietly stop updating when the right side moves.
   *
   * Every reducer factory accepts an optional `{ seed }` parameter
   * that is plumbed through the protocol but unused by the
   * executor — that's  constraint #2. When partition-aware
   * aggregation lands, the seed will carry running state across
   * partition boundaries without an API break.
   *
   * KNOWN GAP (sealed fields, bare-spec form): `where`/`orderBy`/`groupBy`
   * refuse a `sensitive` field at compile time, but a reducer over a sensitive
   * field in the BARE-SPEC form (e.g. `aggregate({ x: sum('ssn') })`) is NOT
   * refused — the reducer factories (`sum`/`min`/`max`/…) are standalone
   * `(field: string)` functions with no collection-type context. This form is
   * preserved as-is for backward compatibility.
   *
   * The BUILDER form closes this gap: `aggregate(b => ({ x: b.sum('field') }))`
   * types the builder's field parameter as `QueryField<T, S>`, refusing any
   * `sensitive` field at compile time. Use the builder form for new code that
   * aggregates over a collection with sensitive fields.
   *
   */
  aggregate<Spec extends ReduceSpec>(spec: Spec): Reduction<ReduceResult<Spec>>
  aggregate<Spec extends ReduceSpec>(build: (b: ReducerBuilder<T, S, M>) => Spec): Reduction<ReduceResult<Spec>>
  aggregate<Spec extends ReduceSpec>(
    specOrBuild: Spec | ((b: ReducerBuilder<T, S, M>) => Spec),
  ): Reduction<ReduceResult<Spec>> {
    let spec = typeof specOrBuild === 'function'
      ? (specOrBuild as (b: ReducerBuilder<T, S, M>) => Spec)((reducerBuilder as unknown) as ReducerBuilder<T, S, M>)
      : specOrBuild
    // #1338 — a reducer over a joined alias used to be refused here. It now
    // routes: the legs run (so the reducer sees the joined relation) and the
    // spec is wrapped by a pipeline that delegates each aliased field to the
    // RIGHT collection's own — which carries money's exact-BigInt rewrite and
    // the `queryable: 'none'` posture gate together. Reducers without a field
    // (e.g. `count()`) address nothing and are unaffected.
    const aliases = this.aliasNames()
    const aliasedReducer =
      this.plan.joins.length > 0 &&
      Object.values(spec).some(r => {
        const f = (r as { field?: unknown }).field
        return typeof f === 'string' && this.addressesAlias(f, aliases)
      })
    // Rewrite sum/min/max over Via-covered fields (e.g. money) into exact
    // BigInt reducers before the strategy runs (covers static run() and
    // live/MV paths).
    spec = (aliasedReducer ? reduceViaFor(this.source.via, this.aliasVia()) : this.source.via)?.wrapReducers(spec) ?? spec
    // #1347 — `countDistinct` needs the SAME canonicalizer the hash index
    // buckets by, and only the source knows it. Bound here, beside the
    // money rewrite, so both spec-wrapping seams stay in one place.
    spec = bindDistinctReducers(spec, this.source.via)
    // Closure over the current query. Produces the record set that
    // the aggregation reduces — same pipeline as `count()`, skipping
    // limit/offset because aggregation is over the full match set,
    // not a paginated slice. (A paginated aggregation would be a
    // different operation; see docs for rationale.)
    const source = this.source
    const clauses = this.plan.clauses
    const joinCtx = this.joinContext
    const hasCrossJoins = clauses.some(c => c.type === 'crossJoin')
    const fullScan = aliasedReducer
      // The reduced relation IS the joined one — same pipeline `count()` uses,
      // with the legs forced on (#1338).
      ? (): readonly unknown[] => this.matchedRecords('aggregate', true)
      : (): readonly unknown[] => {
        if (hasCrossJoins) {
          if (!joinCtx) throw new Error('Query.aggregate(): crossJoin requires a join context')
          return executeClausePipeline(source, clauses, joinCtx)
        }
        const { candidates, remainingClauses } = candidateRecords(source, clauses)
        return remainingClauses.length === 0
          ? candidates
          : filterRecords(candidates, remainingClauses, fnViewDecoder(source))
      }

    // #1341 — when the plan admits it, the match set is MAINTAINED across
    // change events instead of re-scanned, so a live reduction folds over an
    // incrementally-patched array. The reducers themselves still run a full
    // fold: the array they see is byte-for-byte the one a re-scan would
    // produce (same records, same candidate order), so an incremental result
    // is not merely close to a re-run's — it is the identical computation.
    const maintainer = this.incrementalMaintainer('records')
    const executeRecords = maintainer ? (): readonly unknown[] => maintainer.rows() : fullScan

    // Upstream for live mode. The left source always subscribes; a joined
    // aggregation ALSO merges every right-side change stream (#1338) — the
    // refusal's own doc named a live joined aggregate that silently stops
    // updating as half the work, and it is this half.
    const upstreams: ReductionUpstream[] = []
    if (aliasedReducer) upstreams.push(...this.rightSideUpstreams())
    if (source.subscribe) {
      const subscribe = source.subscribe.bind(source)
      upstreams.push(
        maintainer
          ? {
              // The maintainer folds the delta in BEFORE the reduction reads,
              // which is why it is wrapped here rather than subscribed
              // separately — emitter callback order would otherwise decide
              // whether the reduction saw the new record.
              subscribe: (cb: () => void) => {
                maintainer.attach()
                const unsubscribe = subscribe(change => {
                  // A predicate that throws must not escape into the emitter —
                  // the maintainer drops its state and the reduction's own
                  // re-run raises the same error where it can be caught.
                  try {
                    maintainer.apply(change)
                  } catch {
                    maintainer.invalidate()
                  }
                  cb()
                })
                // Detach on teardown: the Reduction survives its LiveReduction
                // (`.run()` reuses the same closure), and a maintainer with no
                // subscription feeding it would go quietly out of date.
                return () => {
                  maintainer.detach()
                  unsubscribe()
                }
              },
            }
          : { subscribe: (cb: () => void) => subscribe(cb) },
      )
    }

    // #1414 — the gate travels INTO the reduction rather than wrapping it.
    // `Reduction.run()` is the synchronous terminal, and `await …aggregate(
    // spec).run()` is what an async guard's Σ-over-siblings invariant writes;
    // gating the builder call instead would break that awaited form.
    return this.reduceStrategy.aggregate<Spec>(executeRecords, spec, upstreams, this.source.hydration)
  }

  /**
   * Partition matching records into buckets keyed by a field, then
   * terminate with `.aggregate(spec)` to compute per-bucket
   * reducers..
   *
   * ```ts
   * const byClient = invoices.query()
   *   .where('status', '==', 'open')
   *   .groupBy('clientId')
   *   .aggregate({ total: sum('amount'), n: count() })
   *   .run()
   * // → [ { clientId: 'c1', total: 5250, n: 3 }, … ]
   * ```
   *
   * Result rows carry the group key value under the grouping field
   * name plus every reducer output from the spec. Buckets are
   * emitted in first-seen order — consumers who want a specific
   * ordering should `.sort()` downstream.
   *
   * **Cardinality caps:** a one-shot warning fires at 10_000
   * distinct groups; `GroupCardinalityError` throws at 100_000.
   * Grouping on a high-uniqueness field like `id` or `createdAt` is
   * almost always a query mistake — the error message names the
   * field and observed cardinality and suggests narrowing with
   * `.where()` first.
   *
   * **Null / undefined keys:** records with a missing or explicitly
   * `null` group field get their own buckets. `Map`-based
   * partitioning distinguishes `undefined` from `null`, so the two
   * cases do NOT merge. Consumers who want them merged should
   * coalesce upstream with `.filter()`.
   *
   * **Joins are not applied unless the GROUP KEY addresses an alias** (#1338).
   * For a left-side key the old rationale still holds — a leg is
   * projection-only, so running one inside a grouping pipeline would be
   * wasteful and could trigger `DanglingReferenceError` in strict mode for a
   * call whose intent is purely to bucket-and-reduce. For an aliased key
   * (`groupBy('client.region')`, the accounting-report shape) the legs run and
   * the buckets are the joined relation's: the key is stamped under its DOTTED
   * path (`row['client.region']`), and a left row whose right side is absent
   * reads `undefined` and lands in the undefined bucket — the same bucket a
   * missing left-side key gets, and still distinct from an explicit `null`.
   *
   * ⚠️ The decision is taken from the KEY, because the reducer spec arrives a
   * call later. A reducer over an alias under a LEFT key is therefore REFUSED
   * rather than folded as `undefined` — group by the alias, or aggregate
   * without grouping.
   *
   * **Filter clauses (`.filter(fn)`):** grouped queries still
   * support filter clauses in the underlying plan — they run in
   * the same candidate/filter pipeline that `.aggregate()` uses.
   * The performance caveat is the same: filter clauses cost O(N)
   * per record and can't be index-accelerated.
   */
  // The `field` param is `QueryField<T, S>` so a sealed (`sensitive`) field is
  // refused — grouping BY a sensitive field leaks its value distribution as
  // group-key labels. With `S = never` this is exactly `string` (zero churn).
  groupBy<F extends QueryField<T, S>>(field: F): GroupedQuery<T, F, S, M>
  groupBy<F extends readonly [QueryField<T, S>, QueryField<T, S>, ...QueryField<T, S>[]]>(
    ...fields: F
  ): GroupedQueryN<T, F, S, M>
  // Derived calendar keys (#1350). Listed last so the two field-name overloads
  // above still win for plain string arguments — a `DateTruncKey` is an object
  // and matches neither, so nothing existing re-resolves onto these.
  groupBy(key: DateTruncKey): GroupedQuery<T, string, S, M>
  // The string members stay `QueryField<T, S>`, so the sealed-field refusal
  // still applies to every plain key in a mixed grouping.
  groupBy(
    ...keys: readonly [
      QueryField<T, S> | DateTruncKey,
      QueryField<T, S> | DateTruncKey,
      ...(QueryField<T, S> | DateTruncKey)[],
    ]
  ): GroupedQueryN<T, readonly string[], S, M>
  groupBy(...keys: readonly GroupKey[]): GroupedQuery<T, string, S, M> | GroupedQueryN<T, readonly string[], S, M> {
    if (keys.length === 0) {
      throw new Error('.groupBy() requires at least one field')
    }
    // A derived key is bucketed into an ordinary row field before the grouping
    // pipeline runs, so everything downstream — cardinality caps, null/undefined
    // bucket semantics, live re-grouping — keeps working unchanged.
    const derived = keys.filter(isDateTruncKey)
    const fields: readonly string[] = keys.map(groupKeyName)
    // #1338 — a group key addressing an alias used to be refused. It now
    // decides the shape of the whole grouped pipeline: the legs run, and the
    // reducers are wrapped through the right side's pipeline.
    //
    // ⚠️ The decision is made HERE, from the group KEY alone, because the
    // reducer spec does not exist yet — it arrives one call later, at
    // `.aggregate()`. That is exactly why the left-key case installs a
    // REFUSING binding rather than nothing: a reducer over an alias under a
    // left-side key would otherwise fold undefined into every bucket, and the
    // grouped terminal is not the one `Query.aggregate()`'s guard sees.
    const aliases = this.aliasNames()
    const keyIsAliased = this.plan.joins.length > 0 && fields.some(f => this.addressesAlias(f, aliases))
    // Same record-producing closure as .aggregate() — grouped and
    // non-grouped aggregations execute over the same candidate set.
    // We inline the closure here instead of sharing a helper so the
    // builder stays allocation-friendly for the hot path.
    const source = this.source
    const clauses = this.plan.clauses
    const joinCtx = this.joinContext
    const hasCrossJoins = clauses.some(c => c.type === 'crossJoin')
    const executeRecords = keyIsAliased
      ? (): readonly unknown[] => this.matchedRecords('groupBy', true)
      : (): readonly unknown[] => {
        if (hasCrossJoins) {
          if (!joinCtx) throw new Error('Query.groupBy(): crossJoin requires a join context')
          return executeClausePipeline(source, clauses, joinCtx)
        }
        const { candidates, remainingClauses } = candidateRecords(source, clauses)
        return remainingClauses.length === 0
          ? candidates
          : filterRecords(candidates, remainingClauses, fnViewDecoder(source))
      }
    const executeGroupRecords = derived.length === 0
      ? executeRecords
      : (): readonly unknown[] => projectDateTruncKeys(executeRecords(), derived)

    // #1341 (grouped half) — the upstream passes the DELTA through, not just a
    // "something changed" ping, so `GroupedReduction.live()` can patch the one
    // or two buckets a change touches instead of re-grouping everything. A cb
    // that ignores the argument (every pre-#1341 caller) is unaffected.
    const upstreams: ReductionUpstream[] = []
    if (source.subscribe) {
      const subscribe = source.subscribe.bind(source)
      upstreams.push({ subscribe: (cb: (change?: SourceChange) => void) => subscribe(cb) })
    }
    if (keyIsAliased) upstreams.push(...this.rightSideUpstreams())
    // Withheld for a plan the whitelist refuses, and for an aliased key (which
    // implies joins, which the whitelist refuses anyway) — `.live()` then
    // re-runs the whole grouping, exactly as it did before.
    const maintenance = keyIsAliased ? undefined : this.groupMaintenance(derived)

    // The pipeline the reducers are wrapped with: the right side's rewrite
    // when the legs run, the refusal when they do not (#1338).
    const reduceVia = keyIsAliased
      ? reduceViaFor(this.source.via, this.aliasVia())
      : refuseAliasReduceVia(this.source.via, aliases)

    // Dict-label resolution is single-field only — the <field>Label
    // projection has no meaningful shape for composite keys. A derived
    // calendar key is never a dictKey, so it skips the lookup entirely.
    if (fields.length === 1) {
      const field = fields[0]!
      const dictLabelResolver = derived.length > 0
        ? undefined
        : buildDictLabelResolver(this.joinContext, field)
      return this.reduceStrategy.groupBy<T, string, S, M>(
        executeGroupRecords,
        field,
        upstreams,
        dictLabelResolver,
        reduceVia,
        maintenance,
      )
    }
    return this.reduceStrategy.groupByN<T, readonly string[], S, M>(
      executeGroupRecords,
      fields,
      upstreams,
      reduceVia,
      maintenance,
    )
  }

  /**
   * SQL window functions over the query's result rows (#1349) — terminate with
   * `.select(spec)`.
   *
   * ```ts
   * invoices.query()
   *   .where('status', '==', 'open')
   *   .window({ partitionBy: 'clientId', orderBy: 'date' })
   *   .select({ balance: runningSum('amount'), prev: lag('amount', 1), n: rowNumber() })
   *   .run()
   * ```
   *
   * ⭐ Distinguished from `.groupBy()` by ARITY, not by capability: grouping
   * emits one row per bucket and drops the source rows; a window keeps EVERY
   * row and attaches per-row values computed over its partition.
   *
   * **The record set is `toArray()`'s** — the full pipeline, including joins,
   * `orderBy`, `offset`/`limit` and the Via decode. That differs deliberately
   * from `.groupBy()`, which reads the candidate/filter pipeline only: a
   * window returns ROWS, so the query's own ordering and paging are exactly
   * what decides which rows there are and how they are presented. `orderBy`
   * inside the window decides only how a partition is WALKED.
   *
   * **Frame:** `rows unbounded preceding → current row`, and only that in v1.
   *
   * `partitionBy` / `orderBy` accept a `dateTrunc()` key (#1350) alongside
   * plain field names; the derived bucket is used for partitioning and is not
   * stamped on the output row. A sealed (`sensitive`) field is refused at
   * compile time, same as `.groupBy()`.
   *
   * ⛔ **Not an `explain()` node.** `explain()` is a terminal on `Query`;
   * `.window()` leaves `Query` for `WindowedQuery`, so there is nothing past
   * here to add a node to — the same reason #1336's post-group ops are absent.
   */
  window(spec: WindowSpec<QueryField<T, S>>): WindowedQuery<T> {
    const upstreams: ReductionUpstream[] = []
    if (this.source.subscribe) {
      const subscribe = this.source.subscribe.bind(this.source)
      upstreams.push({ subscribe: (cb: () => void) => subscribe(cb) })
    }
    return this.reduceStrategy.window<T>(
      () => this.toArray() as readonly unknown[],
      spec as WindowSpec,
      upstreams,
      this.source.via,
    )
  }

  /**
   * Re-run the query whenever the source notifies of changes.
   * Returns an unsubscribe function. The callback receives the latest result.
   * Throws if the source does not support subscriptions.
   *
   * **For joined queries, prefer `.live()`** — `subscribe()`
   * only re-fires on LEFT-side changes, so joined data can be
   * stale if the right side mutates between emissions. `.live()`
   * merges change streams from every join target.
   */
  subscribe(cb: (result: T[]) => void): () => void {
    const _h = this.source.hydration
    if (_h !== undefined && !_h.isHydrated()) return gateTerminal(_h, 'subscribe', () => this.subscribe(cb))
    if (!this.source.subscribe) {
      throw new Error('Query source does not support subscriptions. Pass a source with a subscribe() method.')
    }
    cb(this.toArray())
    return this.source.subscribe(() => cb(this.toArray()))
  }

  /**
   * Reactive terminal — returns a `LiveQuery<T>` that re-runs the
   * query and updates its `value` whenever any source feeding it
   * mutates..
   *
   * For non-joined queries, `.live()` is a convenience over the
   * existing `.subscribe()` callback shape: a hand-rolled reactive
   * primitive with `value` / `error` fields and a `subscribe(cb)`
   * notification channel. Frame-agnostic — Vue / React / Solid
   * adapters wrap it in their own primitive.
   *
   * For joined queries, `.live()` additionally subscribes to every
   * join target's change stream. Mutations on a right-side
   * collection (insert / update / delete of a client referenced by
   * an invoice) re-fire the live query and re-evaluate every
   * dependent left row. Right-side targets are deduped by
   * collection name, so a chain that joins the same target twice
   * (e.g. billing client + shipping client → both 'clients') only
   * subscribes once.
   *
   * **Ref-mode behavior on right-side disappearance** — matches the
   * eager `.toArray()` contract from :
   *   - `strict`  → re-run throws `DanglingReferenceError`. The
   *     LiveQuery catches the throw, stores it in `live.error`, and
   *     notifies listeners (the throw does NOT propagate out of
   *     the source's change handler — that would tear down the
   *     emitter). Consumers check `live.error` after each
   *     notification and render an error state in the UI.
   *   - `warn`    → joined value flips to `null`; the existing
   *     warn-channel deduplication keeps repeated re-runs from
   *     spamming the console.
   *   - `cascade` → no special handling needed; the cascade-
   *     delete mechanism propagates the right-side delete into the
   *     left collection on the next tick, and the live query
   *     naturally re-fires with the orphaned left rows gone.
   *
   * Always call `live.stop()` when finished — it tears down every
   * upstream subscription. The Vue layer's `onUnmounted` hook
   * should call `stop()` automatically; raw consumers must do it
   * themselves.
   *
   * **Incremental maintenance (#1341).** For a plan
   * `incrementalMaintainer()` accepts — no joins, no `.filter(fn)`, no
   * label-sort, and nothing an index would serve in index order (an `==`/`in`
   * probe, #1344's sorted-index range, or #1344's `orderBy(f).limit(n)`
   * index page) — the result set is PATCHED per change
   * event instead of re-run: one predicate evaluation for the changed record,
   * a binary search, a splice. Everything else, and any change event that
   * arrives without a delta, still re-runs the whole plan. Either way the
   * emitted value is identical to `toArray()` — the maintainer reuses this
   * query's own membership test and sort comparator.
   *
   * `options.batch` coalesces a burst of changes into one recompute and one
   * notification on a microtask. It is OFF by default because it makes
   * `live.value` stale until the microtask runs: a consumer that reads
   * synchronously after `await put()` would see the previous value.
   *
   * **Limitations:**
   *   - No re-planning under live mutations — the planner picks
   *     once at subscription time and reuses the same plan.
   *   - Streaming live joins are deferred.
   */
  live(options?: { batch?: boolean }): LiveQuery<T> {
    const _h = this.source.hydration
    if (_h !== undefined && !_h.isHydrated()) return gateTerminal(_h, 'live', () => this.live(options))
    const upstreams: LiveUpstream[] = []

    // Left-side change stream — every live query subscribes to
    // its source if the source supports subscriptions.
    if (this.source.subscribe) {
      const leftSubscribe = this.source.subscribe.bind(this.source)
      upstreams.push({
        subscribe: (cb: () => void) => leftSubscribe(cb),
      })
    }

    // Right-side change streams — only for joined queries. Dedup
    // by target name so a chain joining the same target twice
    // doesn't double-subscribe and double-fire on every right-side
    // mutation.
    if (this.plan.joins.length > 0 && this.joinContext) {
      const subscribed = new Set<string>()
      for (const leg of this.plan.joins) {
        if (subscribed.has(leg.target)) continue
        subscribed.add(leg.target)
        const rightSource = this.joinContext.resolveSource(leg.target)
        if (rightSource?.subscribe) {
          const rightSubscribe = rightSource.subscribe.bind(rightSource)
          upstreams.push({
            subscribe: (cb: () => void) => rightSubscribe(cb),
          })
        }
      }
    }

    // Cross-join right-side change streams — symmetric with FK joins above.
    if (this.joinContext) {
      const subscribedCross = new Set<string>()
      for (const clause of this.plan.clauses) {
        if (clause.type !== 'crossJoin') continue
        if (subscribedCross.has(clause.target)) continue
        subscribedCross.add(clause.target)
        const rightSource = this.joinContext.resolveSource(clause.target)
        if (rightSource?.subscribe) {
          const rightSubscribe = rightSource.subscribe.bind(rightSource)
          upstreams.push({
            subscribe: (cb: () => void) => rightSubscribe(cb),
          })
        }
      }
    }

    // The recompute is just toArray bound to this query — same
    // pipeline as eager execution, including join application. It stays the
    // fallback even when a maintainer is attached.
    const maintainer = this.incrementalMaintainer('rows')
    return buildLiveQuery<T>(() => this.toArray(), upstreams, {
      ...(options?.batch === true ? { batch: true } : {}),
      ...(maintainer ? { maintainer } : {}),
    })
  }

  /**
   * Build the #1341 delta maintainer for this plan, or `undefined` when the
   * plan shape or the source cannot support one (the query then re-runs in
   * full, exactly as it did before #1341).
   *
   * Everything the maintainer needs is taken from THIS query so the two paths
   * cannot diverge: `matches` is the same `filterRecords` call the eager
   * pipeline makes, `compare` is the same comparator `sortRecords` sorts with,
   * and `decode` is the same Via result decode `toArray()` applies after
   * slicing.
   */
  private incrementalMaintainer(mode: 'rows' | 'records'): LiveMaintainer | undefined {
    const source = this.source
    const snapshotEntries = source.snapshotEntries?.bind(source)
    const lookupById = source.lookupById?.bind(source)
    if (!snapshotEntries || !lookupById) return undefined
    // `.aggregate()` reduces the whole match set in candidate order — it never
    // sorts, offsets, limits or decodes — so its maintainer is the same engine
    // with the ordering/windowing half switched off.
    const orderBy = mode === 'rows' ? this.plan.orderBy : []
    const limit = mode === 'rows' ? this.plan.limit : undefined
    const indexes = source.getIndexes?.()
    const probe = indexes
      ? { covers: (f: string) => indexes.has(f), sorted: (f: string) => indexes.hasSorted(f) }
      : null
    if (!canMaintainIncrementally({ ...this.plan, orderBy, limit }, probe)) return undefined

    const clauses = this.plan.clauses
    const decodeForFns = fnViewDecoder(source)
    const via = source.via
    // The ordering comes from the SAME key plan `sortRecords` builds and the
    // keyset cursor compares against (#1346) — one definition of "what order
    // is this query in", so the maintained order cannot drift from a re-run's.
    // `by: 'label'` is refused above, so no label maps are needed here.
    const keyPlan = orderBy.length > 0 ? buildOrderKeyPlan(orderBy, via) : undefined
    return new LiveMaintainer({
      snapshotEntries,
      lookupById,
      matches: record => filterRecords([record], clauses, decodeForFns).length === 1,
      ...(keyPlan
        ? {
            order: {
              keyOf: (record: unknown) => orderKeyOf(keyPlan, record),
              compare: (a: readonly unknown[], b: readonly unknown[]) => compareOrderKeys(keyPlan, a, b),
            },
          }
        : {}),
      offset: mode === 'rows' ? this.plan.offset : 0,
      limit,
      ...(mode === 'rows' && via?.hasResultDecode
        ? { decode: (rows: readonly unknown[]) => this.decodeVia(rows) }
        : {}),
    })
  }

  /**
   * Build the #1341 grouped-maintenance seam for this plan, or `undefined`
   * when the plan shape or the source cannot support one (a grouped live
   * reduction then re-runs in full, exactly as it did before).
   *
   * Same whitelist and the same three inputs `incrementalMaintainer('records')`
   * uses, for the same reason: `.groupBy()`'s record pipeline IS
   * `.aggregate()`'s — `candidateRecords` + `filterRecords`, with no sort, no
   * window and no Via result decode — so `orderBy`/`limit` are stripped before
   * the whitelist is asked. `matches` is the same `filterRecords` call the
   * eager pipeline makes, which is what stops the two paths from drifting.
   *
   * The one addition is `project`: `.groupBy(dateTrunc(...))` (#1350) stamps a
   * derived key onto each row AFTER filtering and before bucketing, and the
   * maintainer has to stamp it too or it would bucket on a field that is not
   * there. It is a pure per-record map, which is the only kind of projection
   * this hook may carry.
   */
  private groupMaintenance(derived: readonly DateTruncKey[]): GroupMaintenanceSource | undefined {
    const source = this.source
    const snapshotEntries = source.snapshotEntries?.bind(source)
    const lookupById = source.lookupById?.bind(source)
    if (!snapshotEntries || !lookupById) return undefined
    const indexes = source.getIndexes?.()
    const probe = indexes
      ? { covers: (f: string) => indexes.has(f), sorted: (f: string) => indexes.hasSorted(f) }
      : null
    if (!canMaintainIncrementally({ ...this.plan, orderBy: [], limit: undefined }, probe)) {
      return undefined
    }
    const clauses = this.plan.clauses
    const decodeForFns = fnViewDecoder(source)
    return {
      snapshotEntries,
      lookupById,
      matches: (record: unknown) => filterRecords([record], clauses, decodeForFns).length === 1,
      ...(derived.length > 0
        ? { project: (record: unknown) => projectDateTruncKeys([record], derived)[0] }
        : {}),
    }
  }

  /**
   * Return the plan as a JSON-friendly object. FilterClause entries are
   * stripped (their `fn` cannot be serialized) and replaced with
   * { type: 'filter', fn: '[function]' } so devtools can still see them.
   */
  toPlan(): unknown {
    return serializePlan(this.plan)
  }

  /**
   * Describe how this plan WOULD run (#1348): the dispatch per clause
   * (`index:hash` vs `scan`, and why), row estimates taken from real index
   * cardinalities, join strategy and side sizes against the row ceiling,
   * whether ordering/pagination lands pre- or post-join, and which
   * cardinality caps are close to tripping. `.text` renders one line per
   * node.
   *
   * ⛔ Purely observational — it probes index buckets and reads snapshot
   * sizes, never executes the plan. A terminal returns the same thing
   * whether or not `explain()` was called. See `query/explain.ts`.
   */
  explain(): QueryExplanation {
    return explainPlan(this.source, this.plan, this.joinContext)
  }

  /**
   * Recursive traversal over ONE declared, self-referencing `ref()` field
   * (#1352) — the org-chart / bill-of-materials / parent-client shape that
   * otherwise forces the consumer to hand-roll recursion.
   *
   * ```ts
   * people.query().where('name', '==', 'Dana')
   *   .traverse('parentId', { direction: 'up', maxDepth: 10 })
   * // → [{ id: 'dana', record, depth: 0, path: ['dana'] },
   * //    { id: 'bea',  record, depth: 1, path: ['dana', 'bea'] }, …]
   * ```
   *
   * **A TERMINAL.** It returns rows, not a `Query`, so it composes with
   * `where()` / `orderBy()` / `limit()` on the way IN, not on the way out.
   *
   * **Seeds are this query's matched records** — the clauses choose the roots
   * of the walk, not which nodes the walk may pass through. A traversal from
   * one seed is `ancestorsOf` / `descendantsOf` below.
   *
   * **`maxDepth` is required**, with no default: an unbounded walk over a
   * large collection is a denial of service against your own UI, and a
   * silent default would truncate a result without saying so.
   *
   * **Cycles terminate.** A parent chain can be circular through user error,
   * and an unguarded BFS hangs the tab. The default `{ onCycle: 'stop' }`
   * prunes a node the walk is already standing on; `'throw'` raises
   * `TraversalCycleError` for hierarchies that are supposed to be acyclic.
   *
   * **A node is emitted once**, at its shallowest depth — so a diamond (two
   * seeds converging on one ancestor) yields ONE row for that ancestor,
   * carrying the path of whichever branch reached it first.
   *
   * **Declared refs only.** This is not a general graph engine: the field
   * must carry a `ref()` whose target is this same collection.
   *
   * **Cost.** Every hop reads the vault's already-decrypted in-memory cache
   * (`query()` is eager-mode only), so a depth-5 traversal costs
   * `depth × frontier` Map lookups and ZERO additional decrypts — the
   * AES-GCM work was paid once at `openVault()`. `direction: 'down'` adds one
   * O(n) pass to build the reverse-FK index; `'up'` adds nothing.
   *
   * ⛔ **Not an `explain()` node.** `explain()` describes the plan, and a
   * traversal is a terminal over the plan's result rather than a clause in
   * it — the same reason `.window()` and #1336's post-group ops are absent.
   * `explain()` on the seed query still describes how the SEEDS are found.
   */
  traverse(field: QueryField<T, S>, opts: TraverseOptions): TraversalRow<T>[] {
    // Validation FIRST: a misdeclared ref is a programming error whose own
    // message must survive #1414's gate, not be masked by it.
    this.assertSelfRef(field, 'traverse')
    const _h = this.source.hydration
    if (_h !== undefined && !_h.isHydrated()) return gateTerminal(_h, 'traverse', () => this.traverse(field, opts))
    return this.runTraverse(field, this.ids(), opts)
  }

  /**
   * `.traverse()` sugar: every ancestor of one record, that record included
   * at `depth: 0`. See {@link traverse} for the full contract.
   *
   * Refused on a query that already carries clauses — the seed is named
   * explicitly here, so a `where()` would silently do nothing. Use
   * `.traverse()` when the seeds come from a query.
   */
  ancestorsOf(
    id: string,
    field: QueryField<T, S>,
    opts: { maxDepth: number; onCycle?: CyclePolicy },
  ): TraversalRow<T>[] {
    return this.traverseFromId(id, field, 'up', opts)
  }

  /**
   * `.traverse()` sugar: every descendant of one record, that record included
   * at `depth: 0`. See {@link traverse} for the full contract.
   */
  descendantsOf(
    id: string,
    field: QueryField<T, S>,
    opts: { maxDepth: number; onCycle?: CyclePolicy },
  ): TraversalRow<T>[] {
    return this.traverseFromId(id, field, 'down', opts)
  }

  private traverseFromId(
    id: string,
    field: QueryField<T, S>,
    direction: TraverseDirection,
    opts: { maxDepth: number; onCycle?: CyclePolicy },
  ): TraversalRow<T>[] {
    const _h = this.source.hydration
    if (_h !== undefined && !_h.isHydrated()) return gateTerminal(_h, direction === 'up' ? 'ancestorsOf' : 'descendantsOf', () => this.traverseFromId(id, field, direction, opts))
    const sugar = direction === 'up' ? 'ancestorsOf' : 'descendantsOf'
    const plan = this.plan
    if (
      plan.clauses.length > 0 ||
      plan.orderBy.length > 0 ||
      plan.joins.length > 0 ||
      plan.limit !== undefined ||
      plan.offset !== 0
    ) {
      throw new Error(
        `Query.${sugar}("${id}"): this query already carries clauses, but ${sugar}() ` +
          `seeds from the id you passed — the clauses would silently do nothing. ` +
          `Use .traverse("${field}", { direction: '${direction}', … }), whose seeds ` +
          `ARE the query's matched records, or call ${sugar}() on a bare ` +
          `collection.query().`,
      )
    }
    this.assertSelfRef(field, sugar)
    return this.runTraverse(field, [id], { ...opts, direction })
  }

  /**
   * The one place a traversal runs. Both entry points share it so they cannot
   * drift on Via decoding or on which source view the walk reads.
   */
  private runTraverse(
    field: string,
    seeds: readonly string[],
    opts: TraverseOptions,
  ): TraversalRow<T>[] {
    const rows = runTraversal(this.source, field, seeds, opts)
    // Same result decode `toArray()` applies — a traversal reads the raw
    // cache records, so without this a money field would serve its stored
    // scaled integer here and its canonical decimal everywhere else.
    return rows.map(row => ({ ...row, record: this.decodeVia([row.record])[0] }) as TraversalRow<T>)
  }

  /**
   * Plan-time validation shared by `.traverse()` and its sugar: the field must
   * carry a `ref()`, and that ref must point back at this same collection.
   *
   * The second half is what keeps this from becoming a general graph engine.
   * A ref to ANOTHER collection has no second hop — the target's records do
   * not carry this field — so a two-collection "traversal" is a `.join()`
   * wearing the wrong name, and would walk exactly one level before stopping
   * for reasons the caller could not see.
   */
  private assertSelfRef(field: string, caller: string): void {
    if (!this.joinContext) {
      throw new Error(
        `Query.${caller}(): requires a collection-backed query. Use collection.query() ` +
          `instead of the Query constructor directly (the direct constructor is only ` +
          `used for tests with plain-object sources).`,
      )
    }
    const descriptor = this.joinContext.resolveRef(field)
    if (!descriptor) {
      throw new RefNotDeclaredError({
        collection: this.joinContext.leftCollection,
        field,
        message:
          `Query.${caller}(): no ref() declared for field "${field}" on collection ` +
          `"${this.joinContext.leftCollection}". Traversal walks DECLARED refs only — ` +
          `add refs: { ${field}: ref('${this.joinContext.leftCollection}') } to the ` +
          `collection options, then retry.`,
      })
    }
    if (descriptor.target !== this.joinContext.leftCollection) {
      throw new Error(
        `Query.${caller}(): field "${field}" refs "${descriptor.target}", but traversal ` +
          `requires a self-referencing ref — one whose target is the collection being ` +
          `queried ("${this.joinContext.leftCollection}"). A ref across collections has ` +
          `no second hop; use .join("${field}", { as: … }) for that.`,
      )
    }
  }
}

/**
 * Index-aware execution: try the indexed fast path first, fall back to a
 * full scan otherwise. Mirrors `executePlan` for the public surface but
 * takes a `QuerySource` so it can consult `getIndexes()` and `lookupById()`.
 */
function executePlanWithSource(
  source: InternalSource,
  plan: QueryPlan,
  joinContext?: JoinContext,
  locale?: string,
  aliasVia?: ReadonlyMap<string, ViaPipeline>,
): unknown[] {
  const hasCrossJoins = plan.clauses.some(c => c.type === 'crossJoin')

  let result: unknown[]
  if (hasCrossJoins) {
    if (!joinContext) {
      throw new Error(
        `Query.toArray(): plan contains crossJoin clauses but no JoinContext is attached. ` +
          `Use collection.query() instead of new Query() for cross-join support.`,
      )
    }
    result = executeClausePipeline(source, plan.clauses, joinContext)
  } else {
    const ordered = orderedIndexRows(source, plan) ?? compoundOrderedRows(source, plan)
    if (ordered) return ordered
    // Index-aware fast path: only the clauses NOT consumed by the index need
    // re-evaluation. For a single-clause query against an indexed field,
    // `remainingClauses` is empty and we skip per-record predicate evaluation.
    const { candidates, remainingClauses } = candidateRecords(source, plan.clauses)
    result =
      remainingClauses.length === 0
        ? [...candidates]
        : filterRecords(candidates, remainingClauses, fnViewDecoder(source))
  }

  return applyOrderAndPage(result, plan, source, joinContext, locale, aliasVia)
}

/**
 * The tail of every execution path: sort, then offset, then limit.
 *
 * Extracted so the post-join filtering path (#1030) applies the identical
 * ordering and pagination rules. Pagination MUST come after any post-join
 * predicate — slicing first would page a set the filter has not seen yet.
 */
function applyOrderAndPage(
  rows: unknown[],
  plan: QueryPlan,
  source: InternalSource,
  joinContext?: JoinContext,
  locale?: string,
  aliasVia?: ReadonlyMap<string, ViaPipeline>,
): unknown[] {
  let result = rows
  if (plan.orderBy.length > 0) {
    // dictKey label-sort: for any `orderBy(..., { by: 'label' })`, build a
    // sync code→label resolver at the query locale so the sort compares
    // labels. `source.via` also feeds the #650 Task 7 matrix-tier fallback
    // (fields `joinContext.resolveDictSource` doesn't bridge).
    const labelMaps = buildOrderLabelMaps(plan.orderBy, joinContext, locale, source.via)
    result = sortRecords(result, plan.orderBy, source.via, labelMaps, aliasVia)
  }
  if (plan.offset > 0) {
    result = result.slice(plan.offset)
  }
  if (plan.limit !== undefined) {
    result = result.slice(0, plan.limit)
  }
  return result
}

const RANGE_OPERATORS: ReadonlySet<string> = new Set(['<', '<=', '>', '>=', 'between', 'startsWith'])

export function isRangeOperator(op: string): op is '<' | '<=' | '>' | '>=' | 'between' | 'startsWith' {
  return RANGE_OPERATORS.has(op)
}

/**
 * #1344 ordered fast path: answer `orderBy(field, dir).limit(n)` from a
 * sorted index instead of sorting the whole decrypted snapshot.
 *
 * Returns `null` — meaning "fall back" — unless EVERY guard holds, because
 * an index-served page must be byte-identical to the scan-and-sort one:
 *
 *  - no where clauses (the index prefix is only the answer for the whole
 *    collection; with a filter the first `n` index rows may not survive it),
 *  - exactly one `orderBy`, no `{ by: 'label' }` (label sort resolves
 *    through the dict registry, not the stored key),
 *  - an explicit `limit` (without one there is nothing to save),
 *  - a sorted index covering the field whose entry count equals the
 *    snapshot size — a record with a nullish or non-orderable value is
 *    absent from the index but `sortRecords` still places it (last in
 *    `asc`, first in `desc`), so partial coverage must not take this path,
 *  - the Via pipeline does not order the field (money/lookup supply their
 *    own `compareForOrder`, which the stored-key order need not match).
 */
function orderedIndexRows(source: InternalSource, plan: QueryPlan): unknown[] | null {
  const limit = plan.limit
  if (limit === undefined || plan.clauses.length > 0 || plan.orderBy.length !== 1) return null
  const [order] = plan.orderBy
  if (!order || order.by === 'label') return null
  const indexes = source.getIndexes?.()
  if (!indexes || !source.lookupById || !indexes.hasSorted(order.field)) return null
  // Arrow-bound so `this` can't drift (same discipline as `candidateRecords`).
  const lookupById = (id: string): unknown => source.lookupById?.(id)
  if (viaOrdersField(source.via, order.field)) return null
  const snapshot = source.snapshot()
  if (indexes.sortedSize(order.field) !== snapshot.length) return null
  const ids = indexes.orderedIds(order.field, order.direction)
  if (!ids) return null
  const out: unknown[] = []
  for (let i = plan.offset; i < ids.length && out.length < limit; i++) {
    const record = lookupById(ids[i]!)
    if (record !== undefined) out.push(record)
  }
  return out
}

/**
 * True when a Via binding claims the ORDERING of this field. Probed with
 * two equal strings: `compareForOrder` returns `undefined` for any field
 * no binding covers (money checks its field map first; lookup checks its
 * `sortBy` declaration), and a number for one it does.
 */
export function viaOrdersField(via: ViaPipeline | undefined, field: string): boolean {
  return via !== undefined && via.compareForOrder(field, '', '') !== undefined
}

/**
 * A range operand for the component just past a compound index's equality
 * prefix. `op` repeats {@link isRangeOperator}'s union rather than importing
 * `RangeOperator`, keeping this file's import list unchanged.
 */
/**
 * The only slice of an index store the compound PICKERS read. Declared
 * structurally (#1375) so `query/explain.ts` can share these pickers rather
 * than re-implementing them — the mirror this file's `explain()` header warns
 * about is one function narrower for every picker that moves here.
 */
export interface CompoundTupleSource {
  compoundTuples(): ReadonlyArray<readonly string[]>
}

export interface CompoundRange {
  readonly op: '<' | '<=' | '>' | '>=' | 'between' | 'startsWith'
  readonly value: unknown
}

export interface CompoundPick {
  readonly fields: readonly string[]
  /** Equality operands for `fields[0..values.length-1]`, in index order. */
  readonly values: readonly unknown[]
  readonly range?: CompoundRange
  /** Indices into the plan's clause list that this pick answers. */
  readonly consumed: ReadonlySet<number>
}

/**
 * Split the top-level clauses into the `==` and range clauses a compound
 * index could answer. Via-covered clauses are excluded for the same reason
 * `candidateRecords` excludes them from the sorted path — a binding's
 * `indexProbe` yields an equality operand in STORED form, never an ordered
 * one, and this path compares raw operands. A repeated field keeps its FIRST
 * clause; the duplicate stays in `remainingClauses` and is re-evaluated.
 */
export function indexableClauses(clauses: readonly Clause[]): {
  eq: Map<string, { value: unknown; at: number }>
  ranges: Map<string, { op: CompoundRange['op']; value: unknown; at: number }>
} {
  const eq = new Map<string, { value: unknown; at: number }>()
  const ranges = new Map<string, { op: CompoundRange['op']; value: unknown; at: number }>()
  for (let i = 0; i < clauses.length; i++) {
    const clause = clauses[i]!
    if (clause.type !== 'field' || clause.via !== undefined) continue
    if (clause.op === '==') {
      if (!eq.has(clause.field)) eq.set(clause.field, { value: clause.value, at: i })
    } else if (isRangeOperator(clause.op)) {
      if (!ranges.has(clause.field)) ranges.set(clause.field, { op: clause.op, value: clause.value, at: i })
    }
  }
  return { eq, ranges }
}

/**
 * Choose the declared field tuple that answers the most clauses: the longest
 * equality PREFIX of the tuple, plus a range on the component immediately
 * after it. A pick answering fewer than two clauses is declined — the
 * single-field hash or sorted index already covers that, at lower cost.
 */
export function pickCompound(indexes: CompoundTupleSource, clauses: readonly Clause[]): CompoundPick | null {
  const { eq, ranges } = indexableClauses(clauses)
  if (eq.size === 0) return null
  let best: CompoundPick | null = null
  for (const fields of indexes.compoundTuples()) {
    const values: unknown[] = []
    const consumed = new Set<number>()
    let depth = 0
    while (depth < fields.length) {
      const hit = eq.get(fields[depth]!)
      if (!hit) break
      values.push(hit.value)
      consumed.add(hit.at)
      depth++
    }
    if (depth === 0) continue
    let range: CompoundRange | undefined
    if (depth < fields.length) {
      const hit = ranges.get(fields[depth]!)
      if (hit) {
        range = { op: hit.op, value: hit.value }
        consumed.add(hit.at)
      }
    }
    if (consumed.size < 2) continue
    if (!best || consumed.size > best.consumed.size) {
      best = { fields, values, consumed, ...(range ? { range } : {}) }
    }
  }
  return best
}

/**
 * #1345 candidate fast path: narrow through a compound index instead of
 * scanning, for `where(a, '==', x).where(b, '==', y)` and for
 * `where(a, '==', x).where(b, '>=', d)`.
 *
 * Returns `null` — fall back — unless the index COVERS THE SNAPSHOT. A record
 * whose value for any component is nullish or has no order-defined runtime
 * type is absent from the tuple index, and the consumed clauses leave the
 * plan, so an under-covering index would silently drop matching records.
 */
function compoundCandidates(
  source: InternalSource,
  indexes: CollectionIndexes,
  lookupById: (id: string) => unknown,
  clauses: readonly Clause[],
): CandidateResult | null {
  const pick = pickCompound(indexes, clauses)
  if (!pick) return null
  if (indexes.compoundSize(pick.fields) !== source.snapshot().length) return null
  const ids = indexes.lookupCompound(pick.fields, pick.values, pick.range)
  if (!ids) return null
  // ⛔ #1425: A TUPLE MATCH IS A SUPERSET, NOT AN ANSWER — #1415's defect, one
  // dispatch over. Compound keys ARE type-tagged, so none of #1415's
  // string↔number↔boolean coercion reaches here; what still leaks is Date
  // object identity, because two `Date`s at the same instant encode to the
  // same key and the scan compares with `===`. Measured on #1415's branch:
  //
  //   where('d','==',new Date(D1.getTime())).where('k','==','x')
  //   index:compound → ['a']        scan → []
  //
  // So EVERY consumed clause stays in the plan and `filterRecords` re-applies
  // the very predicate the scan applies — the two answers are then equal BY
  // CONSTRUCTION, not by a type rule that has to enumerate what the tuple
  // encoder happens to collapse. Same posture as `prefixCandidates` below,
  // and for the same reason.
  //
  // ⚠️ This makes the compound arm a pure candidate NARROWER: it consumes
  // nothing. That is the point — the narrowing is where the win was, and the
  // re-filter runs over a set the executor has already materialized. Do not
  // "optimise" it back by dropping the clauses the tuple matched exactly;
  // exactness is a property of the operand against the STORED values, which
  // the probe cannot see.
  return { candidates: materializeIds(ids, lookupById), remainingClauses: clauses }
}

/**
 * #1345 ordered fast path: answer the headline shape
 * `where(a, '==', x).orderBy(b).limit(n)` from a `[a, b]` compound index —
 * the equality prefix is a contiguous run already sorted by `b`, so neither
 * the filter nor the sort has to touch the rest of the snapshot.
 *
 * Guards, on top of the ones {@link orderedIndexRows} carries for the
 * single-field case:
 *
 *  - EVERY clause must be a via-free `==` on a distinct field, because
 *    nothing re-filters the rows this returns,
 *  - the tuple must be exactly those fields followed by the order field.
 *    A LONGER tuple would break tie order: entries equal on the order
 *    component are then ranked by the components after it, whereas
 *    `sortRecords()` leaves them in insertion order,
 *  - the index must cover the snapshot, same reason as above.
 */
function compoundOrderedRows(source: InternalSource, plan: QueryPlan): unknown[] | null {
  const limit = plan.limit
  if (limit === undefined || plan.clauses.length === 0 || plan.orderBy.length !== 1) return null
  const [order] = plan.orderBy
  if (!order || order.by === 'label') return null
  const indexes = source.getIndexes?.()
  if (!indexes || !source.lookupById) return null
  if (viaOrdersField(source.via, order.field)) return null
  const { eq } = indexableClauses(plan.clauses)
  if (eq.size !== plan.clauses.length) return null
  const match = pickCompoundOrder(indexes, eq, order.field)
  if (!match) return null
  const snapshot = source.snapshot()
  if (indexes.compoundSize(match.fields) !== snapshot.length) return null
  const ids = indexes.compoundOrderedIds(match.fields, match.values, order.direction)
  if (!ids) return null
  // Arrow-bound so `this` can't drift (same discipline as `candidateRecords`).
  const lookupById = (id: string): unknown => source.lookupById?.(id)
  const out: unknown[] = []
  // ⛔ #1425: this path returns rows NOTHING ELSE FILTERS, so it cannot take
  // `compoundCandidates`' fix of pushing the clauses back into the plan —
  // there is no later filter here to push them into. Nor can it re-filter
  // AFTER the limit: that would drop rows from a page the scan would have
  // kept, trading a wrong-rows bug for a wrong-page-size bug.
  //
  // It re-applies the predicate INSIDE the walk instead, and counts the
  // offset in MATCHING rows rather than in index positions — which is what
  // `offset` means everywhere else. Cost is bounded by the equality-prefix
  // run the index already narrowed to, and in the overwhelming case (no
  // superset row) the loop still stops at `offset + limit`, exactly as
  // before. Declining the fast path outright was the alternative and would
  // have cost the headline `where(a,'==',x).orderBy(b).limit(n)` shape its
  // whole reason for existing.
  //
  // Safe to evaluate bare: the guards above already require every clause to
  // be a via-free `==` on a distinct field, so there is no callback clause
  // needing the decoded view `filterRecords` builds.
  let matched = 0
  for (let i = 0; i < ids.length && out.length < limit; i++) {
    const record = lookupById(ids[i]!)
    if (record === undefined) continue
    let hit = true
    for (const clause of plan.clauses) {
      if (!evaluateClause(record, clause)) {
        hit = false
        break
      }
    }
    if (!hit) continue
    if (matched++ < plan.offset) continue
    out.push(record)
  }
  return out
}

/** The declared tuple that is exactly `eq`'s fields followed by `orderField`. */
export function pickCompoundOrder(
  indexes: CompoundTupleSource,
  eq: ReadonlyMap<string, { value: unknown; at: number }>,
  orderField: string,
): { fields: readonly string[]; values: readonly unknown[] } | null {
  for (const fields of indexes.compoundTuples()) {
    if (fields.length !== eq.size + 1) continue
    if (fields[fields.length - 1] !== orderField) continue
    const values: unknown[] = []
    for (let i = 0; i < fields.length - 1; i++) {
      const hit = eq.get(fields[i]!)
      if (!hit) break
      values.push(hit.value)
    }
    if (values.length === fields.length - 1) return { fields, values }
  }
  return null
}

interface CandidateResult {
  /** The reduced candidate set, materialized to record objects. */
  readonly candidates: readonly unknown[]
  /** The clauses that the index could not satisfy and must still be evaluated. */
  readonly remainingClauses: readonly Clause[]
}

/**
 * Pick a candidate record set using the index store when possible.
 *
 * Strategy: scan the top-level clauses for the FIRST `==` or `in` clause
 * against an indexed field. If found, use the index to materialize a
 * candidate set and return the OTHER clauses as `remainingClauses`. The
 * caller skips re-evaluating the index-driving clause because the index
 * is authoritative for that field.
 *
 * This is a deliberately simple planner. A future optimizer could pick
 * the most selective index, intersect multiple indexes, or push composite
 * keys through. For the single-index fast path is good enough.
 */
function candidateRecords(source: InternalSource, clauses: readonly Clause[]): CandidateResult {
  const indexes = source.getIndexes?.()
  if (!indexes || !source.lookupById || clauses.length === 0) {
    return { candidates: source.snapshot(), remainingClauses: clauses }
  }
  // Bind the lookup method through an arrow so it doesn't drift from
  // its `this` context — keeps the unbound-method lint rule happy.
  const lookupById = (id: string): unknown => source.lookupById?.(id)

  // #1345: a compound index consuming an equality PREFIX (plus an optional
  // range on the next component) removes MORE clauses from the plan than any
  // single-clause choice below, so it is tried first.
  const compound = compoundCandidates(source, indexes, lookupById, clauses)
  if (compound) return compound

  // #1355: a Via binding may probe with a PREFIX COVER instead of an
  // equality operand. Tried before the single-clause loop below for the
  // same reason compound is — it is the narrowest thing the index can do
  // for that clause — but unlike every other arm it CONSUMES NOTHING.
  const prefixed = prefixCandidates(indexes, lookupById, clauses)
  if (prefixed) return prefixed

  for (let i = 0; i < clauses.length; i++) {
    const clause = clauses[i]!
    if (clause.type !== 'field') continue
    if (!indexes.has(clause.field) && !indexes.hasSorted(clause.field)) continue
    // A Via-covered clause (e.g. money) only carries a build-time
    // evaluator payload for per-record comparison by default — `buildClause`
    // does not rewrite `clause.value` into the index's stored representation
    // (e.g. multi-currency money operands are `{ amount, currency }`
    // objects; the index would stringify their keys to a no-match
    // sentinel). A binding MAY additionally supply `indexValue` (#625,
    // via `NoydbVia.indexProbe`) — the STORED-form operand for a direct
    // probe (fixed-mode money `==`/`in` today). When it's absent, skip the
    // index fast path for this clause; the fallback scan evaluates it via
    // `clause.via.evaluate`. MIXED-ERA DATA (money, #672 fixed, incl. the
    // #672 review's C1 finding): the index bucket this probe hits is no
    // longer keyed by the RAW stored string — EAGER-mode `CollectionIndexes`
    // canonicalizes money keys through `ViaPipeline.canonicalizeIndexKey` at
    // EVERY bucket-mutation site (`build`, `upsert`, `remove`), not just
    // build/rebuild, so a legacy non-canonical scaled value (predates the
    // field's money() declaration) lands in — and stays in — the SAME bucket
    // a canonical probe looks up, across later put()/delete() too. LAZY
    // mode's `PersistedCollectionIndex` gained the SAME guarantee (#677) —
    // its bucket-mutation sites (`ingest`/`upsert`/`remove`) canonicalize
    // through the same `ViaPipeline.canonicalizeIndexKey`, and its probe
    // path (`lazy-builder.ts`'s `resolveCandidateIds()`) canonicalizes the
    // `==`/`in` lookup value before calling `lookupEqual`/`lookupIn` — see
    // `moneyIndexProbe`'s doc comment (via-money/where.ts) for the full
    // story — lazy mode's post-filter is now Via-aware too (#684), so
    // end-to-end `lazyQuery().where()` money parity with this eager path
    // holds at every scale (`orderBy` ordering parity remains open, #695).
    if (clause.via && clause.via.indexValue === undefined) continue
    const probeValue = clause.via ? clause.via.indexValue : clause.value

    let ids: ReadonlySet<string> | null = null
    // ⛔ #1415: A HASH BUCKET IS A SUPERSET, NOT AN ANSWER. The bucket key is
    // `stringifyBucketKey`, so `1` and `'1'` — and `true` and `'true'`, and a
    // Date and its ISO spelling, and two distinct Date objects at the same
    // instant — share one bucket, while the scan compares with `===`. Handing
    // the bucket back AND dropping the clause from `remainingClauses` is what
    // made `where('pin','==',1100400123450)` return a row that
    // `.filter(r => r.pin === v)` and the unindexed collection both reject.
    // So the equality arms set `exact: false` and the clause STAYS in the
    // plan; `filterRecords` re-applies the very predicate the scan path
    // applies, which makes the two answers equal BY CONSTRUCTION rather than
    // by a type rule that has to enumerate the coercions.
    //
    // Why not decline the operand at the probe, the way `isProbeableBucketKey`
    // declines objects and nullish (#1402)? Because "type-mismatched" is not a
    // property of the OPERAND — it is a property of the operand against the
    // STORED values, which the probe cannot see without new per-bucket type
    // bookkeeping, and even that would not cover two Date objects at one
    // instant (equal keys, `===` false). Why not make the bucket key
    // type-aware? That moves stored index keys: it splits `distinct()`'s
    // buckets (`distinct-key.ts` is the ONE definition, shared with the
    // scanned `distinct()`) and invalidates persisted index sidecars — a much
    // larger blast radius than re-filtering a set the executor has already
    // materialized.
    //
    // ⛔ RANGE STAYS EXACT. `lookupRange` is served by the SORTED index, whose
    // comparisons are the scan's own (#1344, measured on this issue: `!=`,
    // `startsWith` and the range operators never disagreed). Retaining those
    // clauses would be a cost with no defect behind it.
    let exact = true
    if (clause.op === '==') {
      ids = indexes.lookupEqual(clause.field, probeValue)
      exact = false
    } else if (clause.op === 'in' && Array.isArray(probeValue)) {
      ids = indexes.lookupIn(clause.field, probeValue)
      exact = false
    } else if (clause.via === undefined && isRangeOperator(clause.op)) {
      // #1344 sorted index: `<`/`<=`/`>`/`>=`/`between`/`startsWith`.
      // `null` when no SORTED index covers the field (a hash-only field
      // keeps falling through to the scan). Via-covered clauses are
      // excluded deliberately — `indexProbe` only yields an EQUALITY
      // operand today, never an ordered one, so a money range must still
      // be evaluated per record by the binding.
      ids = indexes.lookupRange(clause.field, clause.op, clause.value)
    }

    if (ids !== null) {
      // Found an index-eligible clause: materialize the candidate set. The
      // clause leaves the plan only when the index answer is EXACT — see the
      // #1415 note above for why the equality arms are supersets.
      const remaining: Clause[] = []
      for (let j = 0; j < clauses.length; j++) {
        if (j !== i || !exact) remaining.push(clauses[j]!)
      }
      return {
        candidates: materializeIds(ids, lookupById),
        remainingClauses: remaining,
      }
    }
    // Not index-eligible — keep scanning in case a later clause is a
    // better candidate.
  }

  // No clause was index-eligible — fall back to a full scan.
  return { candidates: source.snapshot(), remainingClauses: clauses }
}

/**
 * #1355 prefix fast path: narrow through a UNION of sorted-index
 * `startsWith` slices named by a Via binding's {@link ViaPrefixProbe}.
 *
 * ⛔ EVERY CLAUSE STAYS IN `remainingClauses`, INCLUDING THIS ONE. A prefix
 * cover is a SUPERSET by contract (`kernel/via/index.ts`), so the binding's
 * `evaluateClause` is still the answer — dropping the clause here would
 * return the cover's corners as matches. That also means this path needs no
 * snapshot-coverage guard of its own: it removes nothing from the plan, so
 * an under-covering index cannot make it return a record the predicate has
 * not seen. What it DOES need is the other half of the same soundness
 * argument, and it is the binding's to hold — a record absent from the
 * index must be one `evaluateClause` would reject anyway. Geo's is: the
 * index key is the geohash derived from `lat`/`lng`, so a record with no
 * key has no usable point, and a clause over no point never matches.
 *
 * Returns `null` — fall back — when no clause carries a prefix probe, or
 * when the field has no sorted index to slice.
 */
function prefixCandidates(
  indexes: CollectionIndexes,
  lookupById: (id: string) => unknown,
  clauses: readonly Clause[],
): CandidateResult | null {
  for (const clause of clauses) {
    if (clause.type !== 'field' || clause.via === undefined) continue
    const probe = clause.via.indexValue
    if (!isViaPrefixProbe(probe)) continue
    if (!indexes.hasSorted(clause.field)) continue
    const ids = new Set<string>()
    for (const prefix of probe.prefixes) {
      const hit = indexes.lookupRange(clause.field, 'startsWith', prefix)
      if (hit === null) return null
      for (const id of hit) ids.add(id)
    }
    return { candidates: materializeIds(ids, lookupById), remainingClauses: clauses }
  }
  return null
}

function materializeIds(
  ids: ReadonlySet<string>,
  lookupById: (id: string) => unknown,
): unknown[] {
  const out: unknown[] = []
  for (const id of ids) {
    const record = lookupById(id)
    if (record !== undefined) out.push(record)
  }
  return out
}

/**
 * Execute a plan against a snapshot of records.
 * Pure function — same input, same output, no side effects.
 *
 * Records are typed as `unknown` because plans are non-parametric; callers
 * cast the return type at the API surface (see `Query.toArray()`).
 */
export function executePlan(records: readonly unknown[], plan: QueryPlan): unknown[] {
  if (plan.clauses.some(c => c.type === 'crossJoin')) {
    throw new Error(
      `executePlan(): does not support crossJoin clauses. ` +
        `executePlan is a stateless pure function — it cannot resolve cross-join right-side ` +
        `collections. Use Query.toArray() (via collection.query()) instead.`,
    )
  }
  let result = filterRecords(records, plan.clauses)
  if (plan.orderBy.length > 0) {
    result = sortRecords(result, plan.orderBy)
  }
  if (plan.offset > 0) {
    result = result.slice(plan.offset)
  }
  if (plan.limit !== undefined) {
    result = result.slice(0, plan.limit)
  }
  return result
}

/**
 * Build the per-record DECODED view factory for user-callback clauses
 * (`filter` / `wherePredicate`) — those callbacks must see the canonical
 * shape (e.g. money's decimal string), never a Via-transformed stored
 * form. Field clauses are NOT affected: their operands were pre-built
 * into raw stored space at build time. Returns undefined when the
 * source's Via pipeline declares no result decode.
 */
function fnViewDecoder(source: InternalSource): ((r: unknown) => unknown) | undefined {
  const via = source.via
  if (!via || !via.hasResultDecode) return undefined
  return r => via.decodeResults(r)
}

/** A clause compiled to a per-row test. `fnView` is the decoded record, when one was built. */
type CompiledClause = (record: unknown, fnView: unknown) => boolean

/**
 * #1437 — compile the two clause shapes that dominate the indexed read path,
 * once per query instead of interpreting them once per row.
 *
 * ⛔ THIS IS PAYING BACK A COST #1415 INTRODUCED ON PURPOSE. Before #1415 an
 * `==` served from the hash index left the plan entirely; now it stays and
 * `filterRecords` re-checks every candidate, which is what makes the index and
 * the scan agree by construction. Correct, and it halved the index's advantage:
 * measured 4.94x over a linear scan at `e43c1c7a~1`, 2.34x on main — against a
 * DoD guard asserting `> 2`, so the regression landed green and first surfaced
 * as an unrelated PR failing three retries.
 *
 * The re-check itself is not the expense; reaching it is. Per candidate row the
 * generic path is `evaluateClause`'s switch, `evaluateFieldClause`, `readPath`
 * (which tests the field for a `.` on every call), then `evaluateOperator`'s
 * switch — five calls and two switches to perform one `===`.
 *
 * ⚠️ The specialisations must be OBSERVATIONALLY IDENTICAL to the generic path,
 * including its edge cases, or this reintroduces the #1402 class from the other
 * side: a nullish record reads as `undefined` rather than throwing, exactly as
 * `readPath` does, and `in` keeps `Array.isArray` gating and SameValueZero
 * membership (a `Set` matches `includes` on `NaN` and on object identity
 * alike). Anything else — a via-covered clause, a dotted path, any other
 * operator — falls through to the interpreter unchanged.
 */
function compileClause(clause: Clause): CompiledClause {
  if (clause.type === 'field' && clause.via === undefined && !clause.field.includes('.')) {
    const field = clause.field
    const value = clause.value
    if (clause.op === '==') {
      return (r) => (r === null || r === undefined ? undefined : (r as Record<string, unknown>)[field]) === value
    }
    if (clause.op === 'in') {
      // A non-array operand matches nothing under `in`, same as `includes`.
      const set = Array.isArray(value) ? new Set(value as readonly unknown[]) : null
      if (set !== null) {
        return (r) => set.has(r === null || r === undefined ? undefined : (r as Record<string, unknown>)[field])
      }
      return () => false
    }
  }
  return (r, fnView) => evaluateClause(r, clause, fnView)
}

function filterRecords(
  records: readonly unknown[],
  clauses: readonly Clause[],
  decodeForFns?: (r: unknown) => unknown,
): unknown[] {
  if (clauses.length === 0) return [...records]
  // Decode once per record, and only when a callback clause will consume it.
  const needsFnView = decodeForFns !== undefined && hasFnClause(clauses)
  // Compile once per QUERY, not once per row (#1437).
  const compiled = clauses.map(compileClause)
  const out: unknown[] = []
  for (const r of records) {
    const fnView = needsFnView ? decodeForFns(r) : undefined
    let matches = true
    for (const test of compiled) {
      if (!test(r, fnView)) {
        matches = false
        break
      }
    }
    if (matches) out.push(r)
  }
  return out
}

/**
 * `filterRecords(...).length > 0`, without building the array or looking past
 * the first match — the engine behind `Query.exists()` (#1347).
 *
 * Kept as a separate loop rather than a `limit`-aware `filterRecords`: the
 * hot read path should not grow a branch it never takes, and the two loops
 * are three lines each.
 */
function anyMatches(
  records: readonly unknown[],
  clauses: readonly Clause[],
  decodeForFns?: (r: unknown) => unknown,
): boolean {
  if (clauses.length === 0) return records.length > 0
  const needsFnView = decodeForFns !== undefined && hasFnClause(clauses)
  for (const r of records) {
    const fnView = needsFnView ? decodeForFns(r) : undefined
    let matches = true
    for (const clause of clauses) {
      if (!evaluateClause(r, clause, fnView)) {
        matches = false
        break
      }
    }
    if (matches) return true
  }
  return false
}

/**
 * Walk the clause list in declaration order, batching filter clauses and
 * expanding on crossJoin clauses. Falls back to `candidateRecords + filterRecords`
 * (index fast-path) when no crossJoin clauses are present.
 *
 * Precondition: `joinContext` must be non-null when any `CrossJoinClause` is in `clauses`.
 */
function executeClausePipeline(
  source: InternalSource,
  clauses: readonly Clause[],
  joinContext: JoinContext,
): unknown[] {
  let rel: unknown[] = [...source.snapshot()]
  let filterBatch: Clause[] = []
  const decodeForFns = fnViewDecoder(source)

  for (const clause of clauses) {
    if (clause.type === 'crossJoin') {
      if (filterBatch.length > 0) {
        rel = filterRecords(rel, filterBatch, decodeForFns)
        filterBatch = []
      }
      const rightSource = joinContext.resolveSource(clause.target)
      if (!rightSource) {
        throw new CrossJoinSourceUnknownError(clause.target, joinContext.leftCollection)
      }
      rel = applyCrossJoin(rel, clause, rightSource)
    } else {
      filterBatch.push(clause)
    }
  }

  if (filterBatch.length > 0) {
    rel = filterRecords(rel, filterBatch, decodeForFns)
  }

  return rel
}

/**
 * Expand `leftRel` by cross-joining with `rightSource`. Enforces the cost ceiling
 * BEFORE allocating the expanded relation (full cartesian) or cumulatively
 * (lateral form). Throws `CrossJoinTooLargeError` on breach.
 */
function applyCrossJoin(
  leftRel: unknown[],
  clause: CrossJoinClause,
  rightSource: JoinableSource,
): unknown[] {
  const rightRows = rightSource.snapshot()
  const maxRows = clause.maxRows ?? DEFAULT_CROSS_JOIN_MAX_ROWS
  const { as } = clause

  // `outer` substitutes a single null right-hand row wherever the right side is
  // empty, which is exactly what the documented `?? [null]` idiom did by hand
  // (#1130). Emitting `{ ...left, [as]: null }` IS the outer-join row — the flag
  // makes it typed and explicit rather than a trick a later "simplification"
  // silently removes. Cost accounting is unchanged: a substituted row is one
  // row, and it counts toward the ceiling like any other.
  const outer = clause.outer === true

  // #1289 — `leftAs` set means BOTH sides are aliased (`.crossJoinWith()`),
  // so the row is a pair rather than a left row wearing one extra field.
  const { leftAs } = clause
  const emit =
    leftAs === undefined
      ? (left: Record<string, unknown>, right: unknown): unknown => ({ ...left, [as]: right })
      : (left: Record<string, unknown>, right: unknown): unknown => ({ [leftAs]: left, [as]: right })

  if (!clause.on) {
    const rightSide = outer && rightRows.length === 0 ? [null] : rightRows
    const product = leftRel.length * rightSide.length
    if (product > maxRows) {
      throw new CrossJoinTooLargeError({ target: clause.target, expected: product, limit: maxRows })
    }
    const expanded: unknown[] = []
    for (const left of leftRel) {
      const leftObj = left as Record<string, unknown>
      for (const right of rightSide) {
        expanded.push(emit(leftObj, right))
      }
    }
    return expanded
  }

  // Lateral — ceiling is cumulative (post-filter count)
  const expanded: unknown[] = []
  let cumulative = 0
  for (const left of leftRel) {
    const callbackResult = clause.on(left)
    let filteredRight: readonly unknown[]
    if (Array.isArray(callbackResult)) {
      filteredRight = callbackResult
    } else {
      filteredRight = (rightRows as unknown[]).filter(
        callbackResult as (r: unknown) => boolean,
      )
    }
    if (outer && filteredRight.length === 0) filteredRight = [null]
    cumulative += filteredRight.length
    if (cumulative > maxRows) {
      throw new CrossJoinTooLargeError({
        target: clause.target,
        expected: cumulative,
        limit: maxRows,
      })
    }
    const leftObj = left as Record<string, unknown>
    for (const right of filteredRight) {
      expanded.push(emit(leftObj, right))
    }
  }
  return expanded
}

/**
 * One `orderBy` entry, resolved: how to read its sort value off a record and
 * how to compare two of those values.
 *
 * Split out of `sortRecords` so the keyset path (`page()`/`after()`) can
 * compare a row against a cursor's STORED values with exactly the ordering
 * the sort used — the alternative was a second comparator that would drift.
 */
interface OrderKeyPlan {
  readonly entries: readonly {
    readonly field: string
    readonly direction: 'asc' | 'desc'
    readonly labelResolver: ((code: string) => string | undefined) | undefined
    /**
     * The pipeline to ask for this entry's exact ordering, and the name to
     * ask it about (#1337). For a left-side field that is the source's own
     * pipeline and the field verbatim; for `client.credit` it is the RIGHT
     * collection's pipeline and `credit`, because a pipeline covers bare
     * field names. `undefined` → the generic comparator, as before.
     */
    readonly via: ViaPipeline | undefined
    readonly viaField: string
  }[]
}

/**
 * One row of a keyset page order: the record, its id, and its precomputed
 * order key. Held by the #1417 memo so a page walk sorts once, not per page.
 */
interface KeysetRow {
  readonly record: unknown
  readonly id: string
  readonly key: readonly unknown[]
}

interface KeysetMemoEntry {
  readonly sorted: KeysetRow[]
  readonly keyPlan: OrderKeyPlan
}

/**
 * #1417 — the keyset page order, remembered between `after()` calls.
 *
 * Keyed by source identity + the source's mutation counter + a fingerprint of
 * everything the order depends on. A cache MISS is always safe (it just
 * re-sorts); a stale HIT would serve rows from before a write, so the counter
 * is maintained by the cache container itself rather than at its eleven write
 * sites — see `kernel/generation-map.ts`.
 *
 * ⚠️ Bounded to a handful of entries, evicted oldest-first. It holds record
 * REFERENCES, which the collection cache holds anyway, so a live entry costs
 * an array; an unbounded map keyed on a string would instead pin one array per
 * collection ever paged, for the life of the process.
 */
const KEYSET_MEMO_LIMIT = 8
const keysetMemo = new Map<string, KeysetMemoEntry>()

function readKeysetMemo(key: string): KeysetMemoEntry | undefined {
  const hit = keysetMemo.get(key)
  if (hit) {
    // Refresh recency: re-inserting moves it to the end of the iteration order.
    keysetMemo.delete(key)
    keysetMemo.set(key, hit)
  }
  return hit
}

function writeKeysetMemo(key: string, entry: KeysetMemoEntry): void {
  keysetMemo.set(key, entry)
  while (keysetMemo.size > KEYSET_MEMO_LIMIT) {
    const oldest = keysetMemo.keys().next()
    if (oldest.done === true) break
    keysetMemo.delete(oldest.value)
  }
}

/**
 * A key that is EQUAL only when the sorted order provably is, and `null` when
 * that cannot be decided cheaply.
 *
 * ⛔ Returning `null` is the safe answer and the default for anything not
 * explicitly understood. A memo that guesses is a stale-read bug; a memo that
 * declines is merely the old cost. So: no source identity or no mutation
 * counter, a callback/predicate/group clause (whose identity lives in a
 * closure this cannot see), or an operand that is not a primitive, Date, or
 * array of those — no key, no memo.
 *
 * `clause.via` is deliberately absent from the fingerprint: it is derived by
 * the source's own pipeline from (field, op, value), all three of which ARE in
 * the key, so including it would add closure identity without adding
 * discrimination.
 */
function keysetMemoKey(
  source: InternalSource,
  plan: QueryPlan,
  locale: string | undefined,
): string | null {
  const identity = source.identity
  const version = source.snapshotVersion?.()
  if (identity === undefined || version === undefined) return null

  const parts: string[] = [identity, String(version), locale ?? '']
  for (const clause of plan.clauses) {
    if (clause.type !== 'field') return null
    const value = fingerprintOperand(clause.value)
    if (value === null) return null
    parts.push(`w:${clause.field}:${clause.op}:${value}`)
  }
  for (const o of plan.orderBy) parts.push(`o:${o.field}:${o.direction}:${o.by ?? 'value'}`)
  return parts.join('\u0000')
}

/** A stable spelling of an operand, or `null` when there is no safe one. */
function fingerprintOperand(value: unknown): string | null {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (value instanceof Date) return `D${value.getTime()}`
  // A number's spelling is TAGGED so it cannot collapse into the string of the
  // same digits — that collapse is exactly what #1415 was about, and a memo
  // key that reintroduced it would serve `pin == 1` the page for `pin == '1'`.
  if (typeof value === 'string') return `s${value}`
  if (typeof value === 'number') return `n${value}`
  if (typeof value === 'bigint') return `g${value}`
  if (typeof value === 'boolean') return `b${value}`
  if (Array.isArray(value)) {
    const each = value.map(fingerprintOperand)
    if (each.some(e => e === null)) return null
    return `[${each.join(',')}]`
  }
  return null
}

/**
 * First index where `pred` becomes true, or `arr.length` if it never does.
 *
 * Requires `pred` to be MONOTONE over `arr` — false for a prefix, then true
 * for the rest. `executeKeyset`'s predicate is "ordered strictly after the
 * cursor" over an array totally ordered by (key, id), which is exactly that.
 */
function lowerBound<T>(arr: readonly T[], pred: (item: T) => boolean): number {
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (pred(arr[mid]!)) hi = mid
    else lo = mid + 1
  }
  return lo
}

function buildOrderKeyPlan(
  orderBy: readonly OrderBy[],
  via?: ViaPipeline,
  labelMaps?: Map<string, (code: string) => string | undefined>,
  aliasVia?: ReadonlyMap<string, ViaPipeline>,
): OrderKeyPlan {
  return {
    entries: orderBy.map(({ field, direction, by }) => {
      const dot = field.indexOf('.')
      const aliased = dot > 0 ? aliasVia?.get(field.slice(0, dot)) : undefined
      return {
        field,
        direction,
        labelResolver: by === 'label' ? labelMaps?.get(field) : undefined,
        via: aliased ?? via,
        viaField: aliased ? field.slice(dot + 1) : field,
      }
    }),
  }
}

/** The sort-key tuple of one record, in `orderBy` order. */
function orderKeyOf(plan: OrderKeyPlan, record: unknown): unknown[] {
  return plan.entries.map(({ field, labelResolver }) => {
    const v = readField(record, field)
    // dictKey/lookup label-sort: compare resolved labels (fallback to the
    // code when unresolved), so e.g. honorific codes sort by their locale label.
    if (labelResolver) return (typeof v === 'string' ? labelResolver(v) : undefined) ?? v
    return v
  })
}

function compareOrderKeys(plan: OrderKeyPlan, a: readonly unknown[], b: readonly unknown[]): number {
  for (let i = 0; i < plan.entries.length; i++) {
    const { direction, labelResolver, via, viaField } = plan.entries[i]!
    const av = a[i]
    const bv = b[i]
    // A Via-covered field (e.g. money) may store a representation the
    // generic comparator would order wrong (money's scaled-integer
    // strings sort lexically, not numerically: '9882' > '10004'). Ask
    // the pipeline for an exact ordering first; fall back to the
    // generic comparator when no binding covers the field. Label-resolved
    // values are already plain strings, so they skip the pipeline.
    const viaCmp = labelResolver ? undefined : via?.compareForOrder(viaField, av, bv)
    const cmp = viaCmp !== undefined ? viaCmp : compareValues(av, bv)
    if (cmp !== 0) return direction === 'asc' ? cmp : -cmp
  }
  return 0
}

/** Ids are opaque strings; lexical order is enough to make the keyset total. */
function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Exported (#1342) for the cross-collection union read path: a union's sort
 * runs AFTER the legs are concatenated, and it has to be the same comparator
 * a single collection's `orderBy` uses or two queries over the same rows
 * would order them differently.
 */
export function sortRecords(
  records: unknown[],
  orderBy: readonly OrderBy[],
  via?: ViaPipeline,
  labelMaps?: Map<string, (code: string) => string | undefined>,
  aliasVia?: ReadonlyMap<string, ViaPipeline>,
): unknown[] {
  const plan = buildOrderKeyPlan(orderBy, via, labelMaps, aliasVia)
  // Stable sort: Array.prototype.sort is required to be stable since ES2019.
  return [...records].sort((a, b) =>
    compareOrderKeys(plan, orderKeyOf(plan, a), orderKeyOf(plan, b)),
  )
}

/**
 * dictKey/lookup label-sort: for each `orderBy(..., { by: 'label' })`
 * field, build a sync per-key label RESOLVER at the query `locale` (falling
 * back to a `staticDict` `displayLocale`). Two sources, tried in order:
 *
 * 1. `joinContext.resolveDictSource(field)` — the pre-existing dict-registry
 *    bridge (unchanged from before #650 Task 7): covers dictKey/staticDict
 *    AND their native `dict()`/`lookup(static)`/`lookup(reserved)` aliases
 *    (`registry.ts`'s `collectLookupDictCompat` bridges those tiers into the
 *    same vault registries this reads). Builds an EAGER `code -> label` map
 *    from the source's full snapshot, same as always.
 * 2. `via.resolveOrderLabel(field, key, locale)` (#650 Task 7) — the
 *    fallback for lookup fields the bridge above doesn't cover (matrix/
 *    collection tier — no vault registry backs it). Per-key, LAZY (no full
 *    snapshot enumeration API at this layer), memoized per field so a
 *    repeated key within one sort doesn't re-resolve.
 *
 * Fields with neither source available are skipped — the sort then falls
 * back to the raw stored code for them.
 */
function buildOrderLabelMaps(
  orderBy: readonly OrderBy[],
  joinContext: JoinContext | undefined,
  locale: string | undefined,
  via: ViaPipeline | undefined,
): Map<string, (code: string) => string | undefined> | undefined {
  let maps: Map<string, (code: string) => string | undefined> | undefined
  for (const { field, by } of orderBy) {
    if (by !== 'label') continue
    const dictSource = joinContext?.resolveDictSource?.(field)
    if (dictSource) {
      const loc = locale ?? dictSource.displayLocale
      if (loc === undefined) continue
      const codeToLabel = new Map<string, string>()
      for (const entry of dictSource.snapshot()) {
        const k = (entry as Record<string, unknown>)['key']
        const labels = (entry as Record<string, unknown>)['labels'] as Record<string, string> | undefined
        const label = labels?.[loc]
        if (typeof k === 'string' && typeof label === 'string') codeToLabel.set(k, label)
      }
      ;(maps ??= new Map()).set(field, (code: string) => codeToLabel.get(code))
      continue
    }
    if (via) {
      const cache = new Map<string, string | undefined>()
      ;(maps ??= new Map()).set(field, (code: string) => {
        if (!cache.has(code)) cache.set(code, via.resolveOrderLabel(field, code, locale))
        return cache.get(code)
      })
    }
  }
  return maps
}

function readField(record: unknown, field: string): unknown {
  if (record === null || record === undefined) return undefined
  if (!field.includes('.')) {
    return (record as Record<string, unknown>)[field]
  }
  const segments = field.split('.')
  let cursor: unknown = record
  for (const segment of segments) {
    if (cursor === null || cursor === undefined) return undefined
    cursor = (cursor as Record<string, unknown>)[segment]
  }
  return cursor
}

function compareValues(a: unknown, b: unknown): number {
  // Nullish goes last in asc order.
  if (a === undefined || a === null) return b === undefined || b === null ? 0 : 1
  if (b === undefined || b === null) return -1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime()
  // Mixed/unsupported types: treat as equal so the sort stays stable.
  // (Deliberate choice — we don't try to coerce arbitrary objects to strings.)
  return 0
}

function serializePlan(plan: QueryPlan): unknown {
  return {
    clauses: plan.clauses.map(serializeClause),
    orderBy: plan.orderBy,
    limit: plan.limit,
    offset: plan.offset,
    after: plan.after,
    joins: plan.joins,
  }
}

function serializeClause(clause: Clause): unknown {
  if (clause.type === 'filter') {
    return { type: 'filter', fn: '[function]' }
  }
  if (clause.type === 'wherePredicate') {
    // Strip the live `fn` reference (non-serializable) but keep the
    // identity-carrying fields so distinct predicates still serialize
    // distinctly. `predicateHash` + `ctxHash` are the hash identity;
    // `name` is the named predicate reference. This matters because
    // A previous fall-through (return clause) exposed the live fn and produced
    // identical serializations for distinct predicates with different ctx values.
    return {
      type: 'wherePredicate',
      name: clause.name,
      ctx: clause.ctx,
      predicateHash: clause.predicateHash,
      ctxHash: clause.ctxHash,
      fn: '[function]',
    }
  }
  if (clause.type === 'group') {
    return {
      type: 'group',
      op: clause.op,
      clauses: clause.clauses.map(serializeClause),
    }
  }
  if (clause.type === 'crossJoin') {
    return {
      type: 'crossJoin',
      target: clause.target,
      as: clause.as,
      // Identity, not decoration: `leftAs` changes the SHAPE of every row
      // (#1289), so two plans differing only in it are different queries.
      // Omitted when unset so a `.crossJoin()` plan serializes exactly as it
      // did before #1289 and no stored queryHash moves.
      ...(clause.leftAs !== undefined && { leftAs: clause.leftAs }),
      on: clause.on ? '[function]' : undefined,
      onPredicateName: clause.onPredicateName,
      maxRows: clause.maxRows,
      // Part of the identity, not decoration: `outer` changes which rows come
      // back, so omitting it here would let an inner-mode plan be reused for an
      // outer-mode query under the same hash (#1130).
      outer: clause.outer,
    }
  }
  return clause
}

/**
 * Compute a stable hash of a `ctx` value supplied to
 * `.wherePredicate(name, ctx)`. Canonical-JSON: keys sorted at each
 * level so `{a, b}` and `{b, a}` hash to the same value. Undefined ctx
 * hashes to the empty string. The hash is sync because it just runs
 * a cheap djb2-style fold — used at builder time, not security-sensitive.
 *
 * @internal
 */
function canonicalCtxHash(ctx: unknown): string {
  if (ctx === undefined) return ""
  const canonical = JSON.stringify(ctx, (_key, value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const sorted: Record<string, unknown> = {}
      for (const k of Object.keys(value as Record<string, unknown>).sort()) {
        sorted[k] = (value as Record<string, unknown>)[k]
      }
      return sorted
    }
    return value
  })
  // djb2 fold over the canonical string; converted to hex.
  let h = 5381
  for (let i = 0; i < canonical.length; i++) {
    h = ((h << 5) + h) ^ canonical.charCodeAt(i)
  }
  return (h >>> 0).toString(16).padStart(8, "0")
}

/**
 * Build a dict-label resolver for `Query.groupBy(field)` when the
 * grouping field is a `dictKey`. Extracted from the inline closure
 * inside `groupBy` so the multi-key path (which has no meaningful
 * `<field>Label` shape) can skip it cleanly. Pure refactor — no
 * behaviour change for the single-field path.
 *
 * Returns `undefined` when:
 *   - the join context lacks a `resolveDictSource` hook, or
 *   - no dictionary source is registered for `field`.
 *
 * @internal
 */
function buildDictLabelResolver(
  joinCtx: JoinContext | undefined,
  field: string,
):
  | ((key: string, locale: string, fallback?: string | readonly string[]) => Promise<string | undefined>)
  | undefined {
  if (!joinCtx?.resolveDictSource) return undefined
  const dictSource = joinCtx.resolveDictSource(field)
  if (!dictSource) return undefined
  const snapshot = dictSource.snapshot()
  // A staticDict-backed source carries a `displayLocale`; use it as the
  // locale default when the query is locale-less, so `{ by: 'label' }` still
  // resolves under a locale-less read. Plain _dict_* sources omit it.
  const displayLocale = dictSource.displayLocale
  const dictMap = new Map<string, Record<string, string>>()
  for (const entry of snapshot) {
    const k = (entry as Record<string, unknown>)['key']
    const labels = (entry as Record<string, unknown>)['labels']
    if (typeof k === 'string' && labels && typeof labels === 'object') {
      dictMap.set(k, labels as Record<string, string>)
    }
  }
  return async (
    key: string,
    locale: string,
    fallback?: string | readonly string[],
  ): Promise<string | undefined> => {
    const effLocale = locale || displayLocale
    if (!effLocale) return undefined
    const labels = dictMap.get(key)
    if (!labels) return undefined
    if (labels[effLocale] !== undefined) return labels[effLocale]
    const chain = Array.isArray(fallback)
      ? (fallback as readonly string[])
      : fallback
        ? [fallback as string]
        : []
    for (const fb of chain) {
      if (fb === 'any') {
        const any = Object.values(labels)[0]
        if (any !== undefined) return any
      } else if (labels[fb] !== undefined) {
        return labels[fb]
      }
    }
    return undefined
  }
}
