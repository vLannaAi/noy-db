/**
 * Chainable, immutable query builder.
 *
 * Each builder operation returns a NEW Query — the underlying plan is never
 * mutated. This makes plans safe to share, cache, and serialize.
 */

import type { Clause, FieldClause, FilterClause, GroupClause, Operator } from './predicate.js'
import { evaluateClause } from './predicate.js'
import type { CollectionIndexes } from './indexes.js'
import type { JoinContext, JoinLeg, JoinStrategy } from './join.js'
import { applyJoins } from './join.js'
import type { LiveQuery, LiveUpstream } from './live.js'
import { buildLiveQuery } from './live.js'
import type { AggregateSpec, AggregateResult, AggregationUpstream } from './aggregate.js'
import { Aggregation } from './aggregate.js'
import { GroupedQuery } from './groupby.js'

export interface OrderBy {
  readonly field: string
  readonly direction: 'asc' | 'desc'
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
  joins: [],
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
  /** Subscribe to mutations; returns an unsubscribe function. */
  subscribe?(cb: () => void): () => void
  /** Index store for the indexed-fast-path. Optional. */
  getIndexes?(): CollectionIndexes | null
  /** O(1) record lookup by id, used to materialize index hits. */
  lookupById?(id: string): T | undefined
}

interface InternalSource {
  snapshot(): readonly unknown[]
  subscribe?(cb: () => void): () => void
  getIndexes?(): CollectionIndexes | null
  lookupById?(id: string): unknown
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
export class Query<T> {
  private readonly source: InternalSource
  private readonly plan: QueryPlan
  private readonly joinContext: JoinContext | undefined

  constructor(
    source: QuerySource<T>,
    plan: QueryPlan = EMPTY_PLAN,
    joinContext?: JoinContext,
  ) {
    this.source = source as InternalSource
    this.plan = plan
    this.joinContext = joinContext
  }

  /** Add a field comparison. Multiple where() calls are AND-combined. */
  where(field: string, op: Operator, value: unknown): Query<T> {
    const clause: FieldClause = { type: 'field', field, op, value }
    return new Query<T>(
      this.source as QuerySource<T>,
      { ...this.plan, clauses: [...this.plan.clauses, clause] },
      this.joinContext,
    )
  }

  /**
   * Logical OR group. Pass a callback that builds a sub-query.
   * Each clause inside the callback is OR-combined; the group itself
   * joins the parent plan with AND.
   */
  or(builder: (q: Query<T>) => Query<T>): Query<T> {
    const sub = builder(
      new Query<T>(this.source as QuerySource<T>, EMPTY_PLAN, this.joinContext),
    )
    const group: GroupClause = {
      type: 'group',
      op: 'or',
      clauses: sub.plan.clauses,
    }
    return new Query<T>(
      this.source as QuerySource<T>,
      { ...this.plan, clauses: [...this.plan.clauses, group] },
      this.joinContext,
    )
  }

  /**
   * Logical AND group. Same shape as `or()` but every clause inside the group
   * must match. Useful for explicit grouping inside a larger OR.
   */
  and(builder: (q: Query<T>) => Query<T>): Query<T> {
    const sub = builder(
      new Query<T>(this.source as QuerySource<T>, EMPTY_PLAN, this.joinContext),
    )
    const group: GroupClause = {
      type: 'group',
      op: 'and',
      clauses: sub.plan.clauses,
    }
    return new Query<T>(
      this.source as QuerySource<T>,
      { ...this.plan, clauses: [...this.plan.clauses, group] },
      this.joinContext,
    )
  }

  /** Escape hatch: add an arbitrary predicate function. Not serializable. */
  filter(fn: (record: T) => boolean): Query<T> {
    const clause: FilterClause = {
      type: 'filter',
      fn: fn as (record: unknown) => boolean,
    }
    return new Query<T>(
      this.source as QuerySource<T>,
      { ...this.plan, clauses: [...this.plan.clauses, clause] },
      this.joinContext,
    )
  }

  /** Sort by a field. Subsequent calls are tie-breakers. */
  orderBy(field: string, direction: 'asc' | 'desc' = 'asc'): Query<T> {
    return new Query<T>(
      this.source as QuerySource<T>,
      { ...this.plan, orderBy: [...this.plan.orderBy, { field, direction }] },
      this.joinContext,
    )
  }

  /** Cap the result size. */
  limit(n: number): Query<T> {
    return new Query<T>(
      this.source as QuerySource<T>,
      { ...this.plan, limit: n },
      this.joinContext,
    )
  }

  /** Skip the first N matching records (after ordering). */
  offset(n: number): Query<T> {
    return new Query<T>(
      this.source as QuerySource<T>,
      { ...this.plan, offset: n },
      this.joinContext,
    )
  }

  /**
   * Resolve a `ref()`-declared foreign key and attach the right-side
   * record under `opts.as`. v0.6 #73 — eager, single-FK, intra-
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
   * correlation goes through `Noydb.queryAcross` (v0.5 #63), not
   * `.join()`.
   */
  join<As extends string, R = unknown>(
    field: string,
    opts: { as: As; strategy?: JoinStrategy; maxRows?: number },
  ): Query<T & Record<As, R | null>> {
    if (!this.joinContext) {
      throw new Error(
        `Query.join() requires a join context. Use collection.query() ` +
          `to construct a join-capable Query instead of the Query constructor ` +
          `directly (the direct constructor is only used for tests with ` +
          `plain-object sources).`,
      )
    }
    const descriptor = this.joinContext.resolveRef(field)
    // Check for dictKey join (v0.8 #85) when no ref() is declared
    const isDictJoinField = !descriptor && this.joinContext.resolveDictSource?.(field) != null
    if (!descriptor && !isDictJoinField) {
      throw new Error(
        `Query.join(): no ref() declared for field "${field}" on collection ` +
          `"${this.joinContext.leftCollection}". Add ` +
          `refs: { ${field}: ref('<target-collection>') } to the collection ` +
          `options, then retry. See the ref() docs for the full list of modes.`,
      )
    }
    const leg: JoinLeg = descriptor
      ? {
          field,
          as: opts.as,
          target: descriptor.target,
          mode: descriptor.mode,
          strategy: opts.strategy,
          maxRows: opts.maxRows,
          // #87 constraint #1 — always 'all' in v0.6. Do not remove.
          partitionScope: 'all',
        }
      : {
          // Dict join leg (v0.8 #85)
          field,
          as: opts.as,
          target: field, // dict name = field name for dictKey
          mode: 'strict',
          strategy: opts.strategy,
          maxRows: opts.maxRows,
          partitionScope: 'all',
          isDictJoin: true,
        }
    return new Query<T & Record<As, R | null>>(
      this.source as unknown as QuerySource<T & Record<As, R | null>>,
      { ...this.plan, joins: [...this.plan.joins, leg] },
      this.joinContext,
    )
  }

  /**
   * Execute the plan and return the matching records. When the plan
   * carries any join legs, they are applied after `where` / `orderBy`
   * / `limit` / `offset` narrow the left set. See the `.join()` doc
   * for the ordering rationale.
   */
  toArray(): T[] {
    const base = executePlanWithSource(this.source, this.plan)
    if (this.plan.joins.length === 0) return base as T[]
    if (!this.joinContext) {
      // Unreachable in practice — .join() throws if joinContext is
      // missing — but belt-and-braces for direct plan construction.
      throw new Error(
        `Query.toArray(): plan carries ${this.plan.joins.length} join leg(s) ` +
          `but no JoinContext is attached. This usually means the Query was ` +
          `constructed via the raw Query constructor with a plan that had joins ` +
          `pre-populated. Use collection.query().join(...) instead.`,
      )
    }
    return applyJoins(base, this.plan.joins, this.joinContext) as T[]
  }

  /** Return the first matching record, or null. Joins are applied. */
  first(): T | null {
    const arr = this.limit(1).toArray()
    return arr[0] ?? null
  }

  /**
   * Return the number of matching records (after where/filter,
   * before limit). **Joins are NOT applied** — count() reports the
   * left-side cardinality, because joins in v0.6 are projection-only
   * (they attach an aliased field; they never filter). Running joins
   * here just to discard the aliases would be wasteful, and in strict
   * mode it could throw `DanglingReferenceError` for a call whose
   * intent is purely to count.
   */
  count(): number {
    // Use the same index-aware candidate machinery as toArray(); skip the
    // index-driving clause from re-evaluation. The length BEFORE limit/offset
    // is what `count()` documents.
    const { candidates, remainingClauses } = candidateRecords(this.source, this.plan.clauses)
    if (remainingClauses.length === 0) return candidates.length
    return filterRecords(candidates, remainingClauses).length
  }

  /**
   * Reduce the matching records through a named set of reducers.
   * v0.6 #97 — the aggregation terminal.
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
   * Returns an `Aggregation<R>` wrapper with two terminals:
   *   - `.run(): R` — synchronous one-shot reduction
   *   - `.live(): LiveAggregation<R>` — reactive primitive that
   *     re-runs the reduction whenever the source notifies of a
   *     change. Always call `live.stop()` when finished.
   *
   * The reducer spec is bound here once and reused by both
   * terminals — this is why `.aggregate()` returns a wrapper instead
   * of being a direct terminal. Consumers who only need the static
   * value read `.run()`; consumers wiring a reactive UI read
   * `.live()`.
   *
   * Joins are intentionally NOT applied to aggregations in v0.6 —
   * the same logic as `.count()`. Joins in v0.6 are projection-only
   * (they attach an aliased field and never filter), so running
   * them just to throw the aliases away would be wasteful. If you
   * need a reducer that reads a joined field, open an issue —
   * aggregations-across-joins is explicitly out of scope for v1.
   *
   * Every reducer factory accepts an optional `{ seed }` parameter
   * that is plumbed through the protocol but unused by the v0.6
   * executor — that's #87 constraint #2. When v0.10 partition-aware
   * aggregation lands, the seed will carry running state across
   * partition boundaries without an API break.
   */
  aggregate<Spec extends AggregateSpec>(
    spec: Spec,
  ): Aggregation<AggregateResult<Spec>> {
    // Closure over the current query. Produces the record set that
    // the aggregation reduces — same pipeline as `count()`, skipping
    // limit/offset because aggregation is over the full match set,
    // not a paginated slice. (A paginated aggregation would be a
    // different operation; see docs for rationale.)
    const source = this.source
    const clauses = this.plan.clauses
    const executeRecords = (): readonly unknown[] => {
      const { candidates, remainingClauses } = candidateRecords(source, clauses)
      return remainingClauses.length === 0
        ? candidates
        : filterRecords(candidates, remainingClauses)
    }

    // Upstream for live mode — only the left source subscribes.
    // Joined aggregations are out of scope for v0.6 (see above), so
    // there are no right-side change streams to merge in.
    const upstreams: AggregationUpstream[] = []
    if (source.subscribe) {
      const subscribe = source.subscribe.bind(source)
      upstreams.push({ subscribe: (cb: () => void) => subscribe(cb) })
    }

    return new Aggregation<AggregateResult<Spec>>(
      executeRecords,
      spec as unknown as AggregateSpec,
      upstreams,
    )
  }

  /**
   * Partition matching records into buckets keyed by a field, then
   * terminate with `.aggregate(spec)` to compute per-bucket
   * reducers. v0.6 #98.
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
   * `.aggregate()`. Joined fields in v0.6 are projection-only, so
   * running a join inside a grouping pipeline would be wasteful and
   * could trigger `DanglingReferenceError` in strict mode for a
   * call whose intent is purely to bucket-and-reduce. Grouping by
   * a joined field is explicitly out of scope for v0.6 — file an
   * issue if a real consumer needs it.
   *
   * **Filter clauses (`.filter(fn)`):** grouped queries still
   * support filter clauses in the underlying plan — they run in
   * the same candidate/filter pipeline that `.aggregate()` uses.
   * The performance caveat is the same: filter clauses cost O(N)
   * per record and can't be index-accelerated.
   */
  groupBy<F extends string>(field: F): GroupedQuery<T, F> {
    // Same record-producing closure as .aggregate() — grouped and
    // non-grouped aggregations execute over the same candidate set.
    // We inline the closure here instead of sharing a helper so the
    // builder stays allocation-friendly for the hot path.
    const source = this.source
    const clauses = this.plan.clauses
    const executeRecords = (): readonly unknown[] => {
      const { candidates, remainingClauses } = candidateRecords(source, clauses)
      return remainingClauses.length === 0
        ? candidates
        : filterRecords(candidates, remainingClauses)
    }

    const upstreams: AggregationUpstream[] = []
    if (source.subscribe) {
      const subscribe = source.subscribe.bind(source)
      upstreams.push({ subscribe: (cb: () => void) => subscribe(cb) })
    }

    // Wire dictKey label resolver for <field>Label projection (v0.8 #85)
    const joinCtx = this.joinContext
    const dictLabelResolver = joinCtx?.resolveDictSource
      ? (() => {
          const dictSource = joinCtx.resolveDictSource(field)
          if (!dictSource) return undefined
          const snapshot = dictSource.snapshot()
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
            const labels = dictMap.get(key)
            if (!labels) return undefined
            if (labels[locale] !== undefined) return labels[locale]
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
        })()
      : undefined

    return new GroupedQuery<T, F>(executeRecords, field, upstreams, dictLabelResolver)
  }

  /**
   * Re-run the query whenever the source notifies of changes.
   * Returns an unsubscribe function. The callback receives the latest result.
   * Throws if the source does not support subscriptions.
   *
   * **For joined queries, prefer `.live()`** (#74) — `subscribe()`
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
   * mutates. v0.6 #74.
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
   * eager `.toArray()` contract from #73:
   *   - `strict`  → re-run throws `DanglingReferenceError`. The
   *     LiveQuery catches the throw, stores it in `live.error`, and
   *     notifies listeners (the throw does NOT propagate out of
   *     the source's change handler — that would tear down the
   *     emitter). Consumers check `live.error` after each
   *     notification and render an error state in the UI.
   *   - `warn`    → joined value flips to `null`; the existing
   *     warn-channel deduplication keeps repeated re-runs from
   *     spamming the console.
   *   - `cascade` → no special handling needed; the v0.4 cascade-
   *     delete mechanism propagates the right-side delete into the
   *     left collection on the next tick, and the live query
   *     naturally re-fires with the orphaned left rows gone.
   *
   * Always call `live.stop()` when finished — it tears down every
   * upstream subscription. The Vue layer's `onUnmounted` hook
   * should call `stop()` automatically; raw consumers must do it
   * themselves.
   *
   * **v0.6 limitations** (tracked separately):
   *   - No granular delta updates — the whole query re-runs on
   *     every change. v2 optimization.
   *   - No microtask batching — bursty changes produce one re-run
   *     per change. v2 optimization.
   *   - No re-planning under live mutations — the planner picks
   *     once at subscription time and reuses the same plan.
   *   - Streaming live joins → tracked under #76.
   */
  live(): LiveQuery<T> {
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

    // The recompute is just toArray bound to this query — same
    // pipeline as eager execution, including join application.
    return buildLiveQuery<T>(() => this.toArray(), upstreams)
  }

  /**
   * Return the plan as a JSON-friendly object. FilterClause entries are
   * stripped (their `fn` cannot be serialized) and replaced with
   * { type: 'filter', fn: '[function]' } so devtools can still see them.
   */
  toPlan(): unknown {
    return serializePlan(this.plan)
  }
}

/**
 * Index-aware execution: try the indexed fast path first, fall back to a
 * full scan otherwise. Mirrors `executePlan` for the public surface but
 * takes a `QuerySource` so it can consult `getIndexes()` and `lookupById()`.
 */
function executePlanWithSource(source: InternalSource, plan: QueryPlan): unknown[] {
  const { candidates, remainingClauses } = candidateRecords(source, plan.clauses)
  // Only the clauses NOT consumed by the index need re-evaluation. This is
  // the key optimization that makes indexed queries dominate linear scans:
  // for a single-clause query against an indexed field, `remainingClauses`
  // is empty and we skip the per-record predicate evaluation entirely.
  let result = remainingClauses.length === 0
    ? [...candidates]
    : filterRecords(candidates, remainingClauses)
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
 * keys through. For v0.3 the single-index fast path is good enough.
 */
function candidateRecords(source: InternalSource, clauses: readonly Clause[]): CandidateResult {
  const indexes = source.getIndexes?.()
  if (!indexes || !source.lookupById || clauses.length === 0) {
    return { candidates: source.snapshot(), remainingClauses: clauses }
  }
  // Bind the lookup method through an arrow so it doesn't drift from
  // its `this` context — keeps the unbound-method lint rule happy.
  const lookupById = (id: string): unknown => source.lookupById?.(id)

  for (let i = 0; i < clauses.length; i++) {
    const clause = clauses[i]!
    if (clause.type !== 'field') continue
    if (!indexes.has(clause.field)) continue

    let ids: ReadonlySet<string> | null = null
    if (clause.op === '==') {
      ids = indexes.lookupEqual(clause.field, clause.value)
    } else if (clause.op === 'in' && Array.isArray(clause.value)) {
      ids = indexes.lookupIn(clause.field, clause.value)
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

function filterRecords(records: readonly unknown[], clauses: readonly Clause[]): unknown[] {
  if (clauses.length === 0) return [...records]
  const out: unknown[] = []
  for (const r of records) {
    let matches = true
    for (const clause of clauses) {
      if (!evaluateClause(r, clause)) {
        matches = false
        break
      }
    }
    if (matches) out.push(r)
  }
  return out
}

function sortRecords(records: unknown[], orderBy: readonly OrderBy[]): unknown[] {
  // Stable sort: Array.prototype.sort is required to be stable since ES2019.
  return [...records].sort((a, b) => {
    for (const { field, direction } of orderBy) {
      const av = readField(a, field)
      const bv = readField(b, field)
      const cmp = compareValues(av, bv)
      if (cmp !== 0) return direction === 'asc' ? cmp : -cmp
    }
    return 0
  })
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
    joins: plan.joins,
  }
}

function serializeClause(clause: Clause): unknown {
  if (clause.type === 'filter') {
    return { type: 'filter', fn: '[function]' }
  }
  if (clause.type === 'group') {
    return {
      type: 'group',
      op: clause.op,
      clauses: clause.clauses.map(serializeClause),
    }
  }
  return clause
}
