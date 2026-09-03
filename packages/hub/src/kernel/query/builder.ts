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
import { applyJoins, splitAroundJoins } from './join.js'
import { CrossJoinTooLargeError, CrossJoinSourceUnknownError, FieldNotQueryableError, RefNotDeclaredError } from '../errors.js'
import type { LiveQuery, LiveUpstream } from './live.js'
import { buildLiveQuery } from './live.js'
import type { SourceChange } from './incremental.js'
import { LiveMaintainer, canMaintainIncrementally } from './incremental.js'
import type { ReduceSpec, ReduceResult, ReductionUpstream, Reduction } from '../../with-lookup/reduce/reduction.js'
import type { ReducerBuilder } from '../../with-lookup/reduce/reducers.js'
import { bindDistinctReducers, reducerBuilder } from '../../with-lookup/reduce/reducers.js'
import type { GroupedQuery, GroupedQueryN } from '../../with-lookup/reduce/groupby.js'
import { NO_REDUCE, type ReduceStrategy } from '../../with-lookup/reduce/strategy.js'
import type { ViaPipeline } from '../via/pipeline.js'
import { decodeCursor, encodeCursor, keysetShape } from './cursor.js'
import type { QueryExplanation } from './explain.js'
import { explainPlan } from './explain.js'

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
 * Refusing rather than reordering is a DELIBERATE, REVIEWED DECISION
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
   * Stable name for this source (`<vault>/<collection>`), used to bind a
   * keyset cursor to the query that minted it (#1346) so a cursor replayed
   * against another collection is refused rather than silently mis-paged.
   */
  identity?: string
}

interface InternalSource {
  snapshot(): readonly unknown[]
  subscribe?(cb: (change?: SourceChange) => void): () => void
  getIndexes?(): CollectionIndexes | null
  lookupById?(id: string): unknown
  via?: ViaPipeline
  snapshotEntries?(): readonly { id: string; record: unknown }[]
  identity?: string
}

/**
 * The chainable builder. All methods return a new Query — the original
 * remains unchanged. Terminal methods (`toArray`, `first`, `count`,
 * `subscribe`) execute the plan against the source.
 *
 * Type parameter T flows through the public API for ergonomics, but the
 * internal storage uses `unknown` so Collection<T> stays covariant.
 *
 * The optional `joinContext` is attached when the Query is constructed
 * via `Collection.query()` (Collection passes in a context built from
 * the Vault's join resolver). A Query constructed via `new Query`
 * directly — e.g. from tests with a plain-object source — has no
 * joinContext, and calling `.join()` on it throws with an actionable
 * error. See `query/join.ts` for the full design.
 */
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
   */
  ids(): string[] {
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
  join<As extends string, R = unknown>(
    field: QueryField<T, S>,
    opts: { as: As; strategy?: JoinStrategy; maxRows?: number },
  ): Query<T & Record<As, R | null>, S, Q, M> {
    return this.withJoinLeg(field, opts, 'left') as unknown as Query<T & Record<As, R | null>, S, Q, M>
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
   * **Ordering.** Like `.join()`, legs run AFTER `orderBy`/`limit`/`offset`,
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
    opts: { as: string; strategy?: JoinStrategy; maxRows?: number },
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
    const leg: JoinLeg = descriptor
      ? {
          field,
          as: opts.as,
          target: descriptor.target,
          mode: descriptor.mode,
          strategy: opts.strategy,
          maxRows: opts.maxRows,
          ...directionField,
          //  constraint #1 — always 'all' in. Do not remove.
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
   * / `limit` / `offset` narrow the left set. See the `.join()` doc
   * for the ordering rationale.
   *
   * `opts.locale` resolves JOINED right-side i18n fields at the
   * `join` layer to that locale; without it, the owning collection's default
   * locale applies, and a locale-less query leaves joined i18n fields raw.
   * (Left/base i18n fields are resolved by `get`/`list`, not here.)
   */
  toArray(opts?: { locale?: string }): T[] {
    // A cursor was applied: the window is decided by the keyset, not by
    // offset/limit slicing. Same rows `page()` would serve, same signature.
    if (this.plan.after !== undefined) return this.executeKeyset(opts).rows

    const { preJoin, postJoin } = splitAroundJoins(this.plan.clauses, this.plan.joins)

    if (postJoin.length === 0) {
      // Decode Via-covered fields (e.g. money: stored scaled-int → canonical
      // decimal) so query().toArray() matches get()/sum(), which already
      // apply the same decode. Decode the left/base records before joins
      // (right-side aliased fields belong to other collections and are out
      // of this source's Via scope).
      const base = this.decodeVia(executePlanWithSource(this.source, this.plan, this.joinContext, opts?.locale))
      if (this.plan.joins.length === 0) return this.dressAliases(base) as T[]
      return this.dressAliases(
        applyJoins(base, this.plan.joins, this.requireJoinContext('toArray'), opts?.locale),
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
      applyOrderAndPage(filtered, this.plan, this.source, joinContext, opts?.locale),
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
   */
  page(opts?: { locale?: string }): { rows: T[]; nextCursor: string | null } {
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
    const entries = this.source.snapshotEntries?.()
    if (entries === undefined) {
      throw new Error(
        'Query.page()/after(): the query source has no snapshotEntries(); keyset pagination ' +
          'requires a collection-backed query (collection.query()).',
      )
    }
    const refToId = new Map<unknown, string>()
    for (const { id, record } of entries) refToId.set(record, id)

    // Match without ordering or paging — this path owns both.
    const matched = executePlanWithSource(
      this.source,
      { ...plan, orderBy: [], limit: undefined, offset: 0, after: undefined },
      this.joinContext,
      opts?.locale,
    )

    const labelMaps = buildOrderLabelMaps(plan.orderBy, this.joinContext, opts?.locale, this.source.via)
    const keyPlan = buildOrderKeyPlan(plan.orderBy, this.source.via, labelMaps)
    const sorted = matched
      .map(record => ({ record, id: refToId.get(record) ?? '', key: orderKeyOf(keyPlan, record) }))
      .sort((a, b) => compareOrderKeys(keyPlan, a.key, b.key) || compareIds(a.id, b.id))

    const shape = keysetShape(this.source.identity, plan.orderBy)
    let start = 0
    if (plan.after !== undefined) {
      const cursor = decodeCursor(plan.after, shape)
      // Strictly after the cursor's position. The row itself may be gone —
      // that is exactly the case an offset cannot survive.
      start = sorted.findIndex(
        r => (compareOrderKeys(keyPlan, r.key, cursor.values) || compareIds(r.id, cursor.id)) > 0,
      )
      if (start < 0) start = sorted.length
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

  /** Return the first matching record, or null. Joins are applied. `opts.locale` resolves joined i18n fields. */
  first(opts?: { locale?: string }): T | null {
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
   */
  count(): number {
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
  private matchedRecords(terminal: string): readonly unknown[] {
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
    const reshapes = this.plan.joins.some(leg => leg.direction !== undefined && leg.direction !== 'left')
    if (postJoin.length === 0 && !reshapes) return narrowed
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
   */
  exists(): boolean {
    if (this.plan.clauses.some(c => c.type === 'crossJoin')) {
      return this.matchedRecords('exists').length > 0
    }
    const { preJoin, postJoin } = splitAroundJoins(this.plan.clauses, this.plan.joins)
    if (postJoin.length > 0) return this.matchedRecords('exists').length > 0
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
   * Joins are intentionally NOT applied to aggregations in —
   * the same logic as `.count()`. Joins in are projection-only
   * (they attach an aliased field and never filter), so running
   * them just to throw the aliases away would be wasteful. If you
   * need a reducer that reads a joined field, open an issue —
   * aggregations-across-joins is explicitly out of scope for v1.
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
    // A reducer over a joined alias would silently reduce undefined (#1030) —
    // the terminals below never apply join legs. Reducers without a field
    // (e.g. `count()`) have nothing to check.
    assertNoJoinAliasField(
      Object.values(spec)
        .map(r => (r as { field?: unknown }).field)
        .filter((f): f is string => typeof f === 'string'),
      this.plan.joins,
      'aggregate',
    )
    // Rewrite sum/min/max over Via-covered fields (e.g. money) into exact
    // BigInt reducers before the strategy runs (covers static run() and
    // live/MV paths).
    spec = this.source.via?.wrapReducers(spec) ?? spec
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
    const fullScan = (): readonly unknown[] => {
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

    // Upstream for live mode — only the left source subscribes.
    // Joined aggregations are out of scope for (see above), so
    // there are no right-side change streams to merge in.
    const upstreams: ReductionUpstream[] = []
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

    return this.reduceStrategy.aggregate<Spec>(executeRecords, spec, upstreams)
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
   * **Joins are not applied** — same rationale as `.count()` and
   * `.aggregate()`. Joined fields in are projection-only, so
   * running a join inside a grouping pipeline would be wasteful and
   * could trigger `DanglingReferenceError` in strict mode for a
   * call whose intent is purely to bucket-and-reduce. Grouping by
   * a joined field is explicitly out of scope for — file an
   * issue if a real consumer needs it.
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
    assertNoJoinAliasField(fields, this.plan.joins, 'groupBy')
    // Same record-producing closure as .aggregate() — grouped and
    // non-grouped aggregations execute over the same candidate set.
    // We inline the closure here instead of sharing a helper so the
    // builder stays allocation-friendly for the hot path.
    const source = this.source
    const clauses = this.plan.clauses
    const joinCtx = this.joinContext
    const hasCrossJoins = clauses.some(c => c.type === 'crossJoin')
    const executeRecords = (): readonly unknown[] => {
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

    const upstreams: ReductionUpstream[] = []
    if (source.subscribe) {
      const subscribe = source.subscribe.bind(source)
      upstreams.push({ subscribe: (cb: () => void) => subscribe(cb) })
    }

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
        this.source.via,
      )
    }
    return this.reduceStrategy.groupByN<T, readonly string[], S, M>(
      executeGroupRecords,
      fields,
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

  return applyOrderAndPage(result, plan, source, joinContext, locale)
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
): unknown[] {
  let result = rows
  if (plan.orderBy.length > 0) {
    // dictKey label-sort: for any `orderBy(..., { by: 'label' })`, build a
    // sync code→label resolver at the query locale so the sort compares
    // labels. `source.via` also feeds the #650 Task 7 matrix-tier fallback
    // (fields `joinContext.resolveDictSource` doesn't bridge).
    const labelMaps = buildOrderLabelMaps(plan.orderBy, joinContext, locale, source.via)
    result = sortRecords(result, plan.orderBy, source.via, labelMaps)
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

function isRangeOperator(op: string): op is '<' | '<=' | '>' | '>=' | 'between' | 'startsWith' {
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
function viaOrdersField(via: ViaPipeline | undefined, field: string): boolean {
  return via !== undefined && via.compareForOrder(field, '', '') !== undefined
}

/**
 * A range operand for the component just past a compound index's equality
 * prefix. `op` repeats {@link isRangeOperator}'s union rather than importing
 * `RangeOperator`, keeping this file's import list unchanged.
 */
interface CompoundRange {
  readonly op: '<' | '<=' | '>' | '>=' | 'between' | 'startsWith'
  readonly value: unknown
}

interface CompoundPick {
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
function indexableClauses(clauses: readonly Clause[]): {
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
function pickCompound(indexes: CollectionIndexes, clauses: readonly Clause[]): CompoundPick | null {
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
  const remaining: Clause[] = []
  for (let j = 0; j < clauses.length; j++) {
    if (!pick.consumed.has(j)) remaining.push(clauses[j]!)
  }
  return { candidates: materializeIds(ids, lookupById), remainingClauses: remaining }
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
  for (let i = plan.offset; i < ids.length && out.length < limit; i++) {
    const record = lookupById(ids[i]!)
    if (record !== undefined) out.push(record)
  }
  return out
}

/** The declared tuple that is exactly `eq`'s fields followed by `orderField`. */
function pickCompoundOrder(
  indexes: CollectionIndexes,
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
    if (clause.op === '==') {
      ids = indexes.lookupEqual(clause.field, probeValue)
    } else if (clause.op === 'in' && Array.isArray(probeValue)) {
      ids = indexes.lookupIn(clause.field, probeValue)
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
      // Found an index-eligible clause: materialize the candidate set and
      // remove this clause from the remaining list.
      const remaining: Clause[] = []
      for (let j = 0; j < clauses.length; j++) {
        if (j !== i) remaining.push(clauses[j]!)
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

function filterRecords(
  records: readonly unknown[],
  clauses: readonly Clause[],
  decodeForFns?: (r: unknown) => unknown,
): unknown[] {
  if (clauses.length === 0) return [...records]
  // Decode once per record, and only when a callback clause will consume it.
  const needsFnView = decodeForFns !== undefined && hasFnClause(clauses)
  const out: unknown[] = []
  for (const r of records) {
    const fnView = needsFnView ? decodeForFns(r) : undefined
    let matches = true
    for (const clause of clauses) {
      if (!evaluateClause(r, clause, fnView)) {
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
  }[]
  readonly via: ViaPipeline | undefined
}

function buildOrderKeyPlan(
  orderBy: readonly OrderBy[],
  via?: ViaPipeline,
  labelMaps?: Map<string, (code: string) => string | undefined>,
): OrderKeyPlan {
  return {
    entries: orderBy.map(({ field, direction, by }) => ({
      field,
      direction,
      labelResolver: by === 'label' ? labelMaps?.get(field) : undefined,
    })),
    via,
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
    const { field, direction, labelResolver } = plan.entries[i]!
    const av = a[i]
    const bv = b[i]
    // A Via-covered field (e.g. money) may store a representation the
    // generic comparator would order wrong (money's scaled-integer
    // strings sort lexically, not numerically: '9882' > '10004'). Ask
    // the pipeline for an exact ordering first; fall back to the
    // generic comparator when no binding covers the field. Label-resolved
    // values are already plain strings, so they skip the pipeline.
    const viaCmp = labelResolver ? undefined : plan.via?.compareForOrder(field, av, bv)
    const cmp = viaCmp !== undefined ? viaCmp : compareValues(av, bv)
    if (cmp !== 0) return direction === 'asc' ? cmp : -cmp
  }
  return 0
}

/** Ids are opaque strings; lexical order is enough to make the keyset total. */
function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function sortRecords(
  records: unknown[],
  orderBy: readonly OrderBy[],
  via?: ViaPipeline,
  labelMaps?: Map<string, (code: string) => string | undefined>,
): unknown[] {
  const plan = buildOrderKeyPlan(orderBy, via, labelMaps)
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
