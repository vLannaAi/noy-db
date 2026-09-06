/**
 * #1458 — **Relate**: every multi-source and plan-level operation.
 *
 * `join` · `joinOn` · `rightJoin` · `fullOuterJoin` · `crossJoin` ·
 * `crossJoinWith` · `traverse` · `ancestorsOf` · `descendantsOf` · `explain`
 *
 * The bodies below moved out of `kernel/query/builder.ts` UNCHANGED. They read
 * `this.source` / `this.plan` / `this.joinContext` exactly as they did while
 * they were class members, because at runtime that is precisely what they
 * still are: `install()` copies them onto `Query.prototype`, and TypeScript's
 * `private` never existed at runtime. The `declare` fields at the top of the
 * mixin are how the compiler is told the same thing.
 *
 * ⚠️ **Do not import this module for its side effects — import
 * `./index.js`.** This file defines the methods; the barrel installs them, and
 * the barrel is what `package.json`'s `sideEffects` list names.
 */
import type { QueryField } from '../../types.js'
import { Query } from '../builder.js'
import type { DeclaredPredicate, InternalSource, QueryPlan, QuerySource } from '../builder.js'
import type { CrossJoinClause } from '../predicate.js'
import { gateTerminal } from '../hydration.js'
import type { ReduceStrategy } from '../../../with-lookup/reduce/strategy.js'
import type { JoinableSource, JoinContext, JoinDirection, JoinLeg, JoinStrategy } from './join.js'
import { DEFAULT_CROSS_JOIN_MAX_ROWS } from './join.js'
import { normalizeJoinOn, type JoinOnSpec } from './join-on.js'
import type { QueryExplanation } from './explain.js'
import { explainPlan } from './explain.js'
import type { CyclePolicy, TraversalRow, TraverseDirection, TraverseOptions } from './traverse.js'
import { runTraversal } from './traverse.js'
import { CrossJoinTooLargeError, RefNotDeclaredError } from '../../errors.js'

/**
 * The Relate half of `Query`, as a mixin whose prototype is copied onto the
 * real class. Never instantiated.
 */
export class RelateMethods<
  T,
  S extends keyof T = never,
  Q extends keyof T & string = never,
  M extends keyof T & string = never,
> {
  // ─── The instance state these bodies read (see the header) ──────────────
  declare protected readonly source: InternalSource
  declare protected readonly plan: QueryPlan
  declare protected readonly joinContext: JoinContext | undefined
  declare protected readonly reduceStrategy: ReduceStrategy
  declare protected readonly predicates: ReadonlyMap<string, DeclaredPredicate> | undefined
  // ─── The Find-side helpers they call ────────────────────────────────────
  declare protected decodeVia: (records: readonly unknown[], locale?: string) => unknown[]
  declare protected requireJoinContext: (terminal: string) => JoinContext
  declare ids: () => string[]

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
 * The public Relate surface, named once. The `declare module` block in
 * `./index.ts` merges exactly this into `Query`, so the signatures live in one
 * place and cannot drift from the implementations above.
 *
 * `Pick` rather than the class itself: an interface that extended
 * `RelateMethods` would inherit the `protected` state declarations too, and
 * they collide with `Query`'s own `private` fields.
 */
export type RelateSurface<
  T,
  S extends keyof T = never,
  Q extends keyof T & string = never,
  M extends keyof T & string = never,
> = Pick<
  RelateMethods<T, S, Q, M>,
  | 'join'
  | 'joinOn'
  | 'rightJoin'
  | 'fullOuterJoin'
  | 'crossJoin'
  | 'crossJoinWith'
  | 'traverse'
  | 'ancestorsOf'
  | 'descendantsOf'
  | 'explain'
>

/**
 * Expand `leftRel` by cross-joining with `rightSource`. Enforces the cost ceiling
 * BEFORE allocating the expanded relation (full cartesian) or cumulatively
 * (lateral form). Throws `CrossJoinTooLargeError` on breach.
 */
export function applyCrossJoin(
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
