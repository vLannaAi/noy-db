/**
 * #1458 — **Reduce**: a fold over a result set.
 *
 * `aggregate` · `groupBy` · `window` · `distinct`
 *
 * Bodies moved out of `kernel/query/builder.ts` unchanged; see
 * `../relate/methods.ts` for why `this.plan` still resolves.
 *
 * ⚠️ This group depends on TWO others, and both edges are real rather than
 * tidyable:
 *   - **Live**, for `incrementalMaintainer` — a live reduction maintains its
 *     state through Live's maintainer (see `../internal/maintenance.ts`);
 *   - **Relate**, for `reduceViaFor` / `refuseAliasReduceVia` — a reducer over
 *     a JOIN ALIAS has to resolve the right side's Via pipeline, and refusing
 *     it correctly is #1338's whole subject.
 * Neither is a layering accident: both are what "reduce over a joined, live
 * result" means.
 */
import type { DeclaredPredicate, InternalSource, QueryPlan } from '../builder.js'
// @internal Find helpers. A reduce terminal narrows its record set through the
// SAME executor the projection terminals use — sharing the functions is what
// keeps "which records does this terminal see" one definition (#1347).
import { buildDictLabelResolver, candidateRecords, executeClausePipeline, filterRecords, fnViewDecoder } from '../builder.js'
import { readPath } from '../predicate.js'
import type { SourceChange } from '../live/incremental.js'
import type { QueryField } from '../../types.js'
import type { ViaPipeline } from '../../via/pipeline.js'
import type { JoinContext, JoinLeg } from '../relate/join.js'
import { reduceViaFor, refuseAliasReduceVia } from '../relate/join-reduce.js'
import type { DateTruncKey, GroupKey } from './date-trunc.js'
import { groupKeyName, isDateTruncKey, projectDateTruncKeys } from './date-trunc.js'
import { distinctKeyOf } from '../distinct-key.js'
import type { LiveMaintainer, GroupMaintenanceSource } from '../live/incremental.js'
import type { ReduceSpec, ReduceResult, ReductionUpstream, Reduction } from '../../../with-lookup/reduce/reduction.js'
import type { ReducerBuilder } from '../../../with-lookup/reduce/reducers.js'
import { bindDistinctReducers, reducerBuilder } from '../../../with-lookup/reduce/reducers.js'
import type { GroupedQuery, GroupedQueryN } from '../../../with-lookup/reduce/groupby.js'
import type { ReduceStrategy, WindowSpec, WindowedQuery } from '../../../with-lookup/reduce/strategy.js'
import { FieldNotQueryableError } from '../../errors.js'

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

/** @internal — the mixin whose prototype `./index.ts` copies onto `Query`. */
  /* eslint-disable @typescript-eslint/no-unused-vars -- #1458: the parameter
     list must match `Query`'s exactly (T, S, Q, M) because `declare module`
     merges this mixin's `Pick` into it, and TypeScript requires every
     declaration of an interface to carry identical type parameters. A group
     whose methods happen to use only `T` still declares all four. */
export class ReduceMethods<
  T,
  S extends keyof T = never,
  Q extends keyof T & string = never,
  M extends keyof T & string = never,
  /* eslint-enable @typescript-eslint/no-unused-vars */
> {
  declare protected readonly source: InternalSource
  declare protected readonly plan: QueryPlan
  declare protected readonly joinContext: JoinContext | undefined
  declare protected readonly reduceStrategy: ReduceStrategy
  declare protected readonly predicates: ReadonlyMap<string, DeclaredPredicate> | undefined
  declare protected matchedRecords: (terminal: string, forceJoins?: boolean) => readonly unknown[]
  declare protected decodeVia: (records: readonly unknown[], locale?: string) => unknown[]
  declare protected aliasVia: () => ReadonlyMap<string, ViaPipeline> | undefined
  declare protected incrementalMaintainer: (mode: 'rows' | 'records') => LiveMaintainer | undefined
  declare protected groupMaintenance: (derived: readonly DateTruncKey[]) => GroupMaintenanceSource | undefined
  declare toArray: (opts?: { locale?: string }) => T[]

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
}

/** The public Reduce surface — merged into `Query` by `./index.ts`. */
export type ReduceSurface<
  T,
  S extends keyof T = never,
  Q extends keyof T & string = never,
  M extends keyof T & string = never,
> = Pick<ReduceMethods<T, S, Q, M>, 'aggregate' | 'groupBy' | 'window' | 'distinct'>

