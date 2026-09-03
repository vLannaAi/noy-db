/**
 * Streaming scan builder with filter + aggregate support.
 *
 * `Collection.scan()` now returns a `ScanBuilder<T>` that
 * implements `AsyncIterable<T>` (for existing `for await … of`
 * consumers) AND exposes chainable `.where()` / `.filter()` clauses
 * plus a `.aggregate(spec)` async terminal that reduces the scan
 * stream through the same reducer protocol as `Query.aggregate()`
 *.
 *
 * **Memory model:** O(reducers), not O(records). The aggregate
 * terminal initializes one state per reducer, iterates through the
 * scan one record at a time via `for await`, applies every reducer's
 * `step` per record, and never collects the stream into an array.
 * This is what makes `scan().aggregate()` suitable for collections
 * that don't fit in memory — the bound is a code-level invariant
 * visible in the function body, not a runtime assertion.
 *
 * **Paginated iteration:** the builder holds a `pageProvider`
 * closure that maps `(cursor, limit) → Promise<page>`, plumbed by
 * `Collection.scan()` to `collection.listPage(...)`. The page
 * iterator walks cursors forward until exhaustion, same as the
 * previous async-generator `scan()` did.
 *
 * **Backward compatibility:** existing `for await (const rec of
 * collection.scan()) { … }` code continues to work because
 * `ScanBuilder` implements `[Symbol.asyncIterator]`. The previous
 * signature returned an `AsyncIterableIterator<T>` (which has both
 * `[Symbol.asyncIterator]` and `.next()`). We verified at grep time
 * that no call sites use `.next()` on the scan result directly, so
 * the narrowed interface is safe.
 *
 * **Immutability:** each `.where()` / `.filter()` call returns a
 * fresh builder sharing the same page provider and page size. This
 * lets a base scan be reused for multiple parallel aggregations:
 *
 * ```ts
 * const scan = invoices.scan()
 * const [open, paid] = await Promise.all([
 *   scan.where('status', '==', 'open').aggregate({ n: count() }),
 *   scan.where('status', '==', 'paid').aggregate({ n: count() }),
 * ])
 * ```
 *
 * Note that each aggregation pays a full scan — there's no shared
 * iteration across the two. When the specs are known together, pass
 * them as an ARRAY (#1340): `.aggregate([specA, specB])` steps every
 * spec's state from the same yielded record, so N specs cost one
 * pass, not N.
 *
 * **Out of scope for (tracked separately):**
 *   - `scan().aggregate().live()` — unbounded scan + change-stream
 *     reconciliation is a design problem, not just a code one, and
 *     #1340 deliberately left it out
 *   - Parallel scan across pages — race-safe page cursor contracts
 *     are not in the adapter API yet
 *   - `scan().join(...)` — tracked under  (streaming join)
 */

import type { QueryField } from '../types.js'
import type { ReducerBuilder } from '../../with-lookup/reduce/reducers.js'
import { bindDistinctReducers, reducerBuilder } from '../../with-lookup/reduce/reducers.js'
import type { Clause, FieldClause, Operator } from './predicate.js'
import { evaluateClause, hasFnClause, normalizeMatches, normalizeSubqueryOperand, readPath } from './predicate.js'
import type {
  ReduceSpec,
  ReduceResult,
} from '../../with-lookup/reduce/reduction.js'
import type { JoinContext, JoinLeg, JoinableSource } from './join.js'
import { splitAroundJoins } from './join.js'
import { DanglingReferenceError, FieldNotQueryableError, GroupCardinalityError, RefNotDeclaredError } from '../errors.js'
import type { ViaPipeline } from '../via/pipeline.js'
import type { DateTruncKey } from './date-trunc.js'
import { groupKeyName, isDateTruncKey, projectDateTruncKeys } from './date-trunc.js'

/**
 * Result of the multi-spec `.aggregate([specA, specB, …])` form (#1340) — a
 * tuple positionally matching the specs, each element the shape that spec's
 * own single-spec `.aggregate()` would have returned.
 */
export type MultiReduceResult<Specs extends readonly ReduceSpec[]> = {
  -readonly [K in keyof Specs]: ReduceResult<Specs[K]>
}

/**
 * Page provider — the Collection-shaped hook the builder calls to
 * walk cursors forward. Kept as a structural interface so tests can
 * wire up a synthetic provider without pulling in the full
 * Collection class. Collection's `listPage` matches this shape
 * exactly.
 */
export interface ScanPageProvider<T> {
  listPage(opts: {
    cursor?: string
    limit?: number
  }): Promise<{ items: T[]; nextCursor: string | null }>
}

const DEFAULT_SCAN_PAGE_SIZE = 100

/**
 * Chainable streaming scan. Implements `AsyncIterable<T>` for
 * drop-in use with `for await … of`; adds `.where()` / `.filter()`
 * chainable clauses and a `.aggregate(spec)` async terminal.
 *
 * The builder is immutable per operation — each chained call
 * returns a fresh `ScanBuilder` sharing the same page provider and
 * page size. The original builder is never mutated, so it's safe
 * to reuse across multiple parallel consumers.
 */
export class ScanBuilder<T, S extends keyof T = never, M extends keyof T & string = never> implements AsyncIterable<T> {
  private readonly pageProvider: ScanPageProvider<T>
  private readonly pageSize: number
  private readonly clauses: readonly Clause[]
  /**
   * Zero-or-more join legs to apply per record as the stream flows.
   * Each leg attaches the resolved right-side record (or null) under
   * its alias. — streaming joins.
   *
   * Joins are evaluated AFTER clauses, so a `where()` filtered-out
   * record never triggers a right-side lookup. This is the same
   * ordering as `Query.toArray()` (clauses first, joins after) and
   * keeps the streaming path from doing wasted work.
   */
  private readonly joins: readonly JoinLeg[]
  /**
   * Join resolution context. Required for `.join()` to translate a
   * field name into a target collection + ref mode and to resolve
   * the right-side `JoinableSource`. Optional because tests
   * construct ScanBuilder directly with synthetic page providers
   * that don't know about ref() — calling `.join()` without a
   * context throws with an actionable error.
   */
  private readonly joinContext: JoinContext | undefined
  /**
   * The backing collection's compiled Via pipeline (money now; more Via
   * features later). When it declares a result decode, yielded records
   * are decoded (e.g. money: stored scaled-int → canonical decimal) so
   * `scan()` agrees with `get()`/`list()`/`query().toArray()`. Decoded
   * with `'raw'` (canonical decimal, no locale-formatted virtuals) since
   * the scan stream carries no locale context, mirroring `Query.toArray()`.
   */
  private readonly via: ViaPipeline | undefined

  constructor(
    pageProvider: ScanPageProvider<T>,
    pageSize: number = DEFAULT_SCAN_PAGE_SIZE,
    clauses: readonly Clause[] = [],
    joins: readonly JoinLeg[] = [],
    joinContext?: JoinContext,
    via?: ViaPipeline,
  ) {
    this.pageProvider = pageProvider
    this.pageSize = pageSize
    this.clauses = clauses
    this.joins = joins
    this.joinContext = joinContext
    this.via = via
  }

  /**
   * Decode this scan's Via-covered fields on a record (e.g. money: stored
   * scaled-int → canonical decimal). No-op when the Via pipeline declares
   * no result decode. See {@link via}.
   */
  private decodeVia(record: T): T {
    if (!this.via || !this.via.hasResultDecode) return record
    return this.via.decodeResults(record) as T
  }

  /**
   * Add a field comparison. Runs per record as the scan stream
   * flows through, so non-matching records are dropped before they
   * reach `.aggregate()` or the iteration consumer. Multiple
   * `.where()` calls are AND-combined — same semantics as
   * `Query.where()`.
   *
   * Clauses cannot use the secondary-index fast path here because
   * the scan sources records from the adapter's paginator, not from
   * the in-memory cache where indexes live. Index-accelerated scans
   * are a future optimization — the current implementation
   * evaluates clauses per record in O(1) per clause.
   *
   * Consults the Via pipeline's posture before building a clause (#629
   * Task 8): a field whose posture is `queryable: 'none'` throws
   * `FieldNotQueryableError` here, at the call site — same gate as
   * `Query.where()`.
   */
  where(field: QueryField<T, S>, op: Operator, value: unknown): ScanBuilder<T, S, M> {
    // A Via-covered field (e.g. money) compares in major units, BigInt-exact
    // in scaled space — same build-time operand rewrite as Query.where().
    const via = this.via
    if (via?.postureFor(field as string)?.queryable === 'none') throw new FieldNotQueryableError(field as string)
    // #1357: a 'matches' operand is refused-or-normalized HERE, at the call
    // site — an anchored literal prefix lowers to `startsWith` (taking the
    // sorted index), anything else serializes to `{ source, flags }` so the
    // pattern folds into an MV's queryHash. Every other operator is identity.
    // #1351: a SUBQUERY operand of `in`/`!in` resolves to its id array here,
    // at build time — same normalization order as `Query.where()`, so all
    // three builders turn the same call into the same clause.
    const { op: sop, value: sval, subquery } = normalizeSubqueryOperand(op, value)
    const { op: mop, value: mval } = normalizeMatches(sop, sval)
    const viaClause = via?.buildClause(field as string, mop, mval)
    const clause: FieldClause = viaClause
      ? {
          type: 'field',
          field: field as string,
          op: mop,
          value: mval,
          ...(subquery ? { subquery } : {}),
          via: {
            brand: viaClause.brand,
            payload: viaClause.payload,
            evaluate: (actual: unknown, evalOp: string) => via!.evaluateClause(viaClause, actual, evalOp),
          },
        }
      : { type: 'field', field: field as string, op: mop, value: mval, ...(subquery ? { subquery } : {}) }
    return new ScanBuilder<T, S, M>(
      this.pageProvider,
      this.pageSize,
      [...this.clauses, clause],
      this.joins,
      this.joinContext,
      this.via,
    )
  }

  /**
   * Escape hatch: add an arbitrary predicate function. Same
   * non-serializable caveat as `Query.filter()` — filter clauses
   * don't round-trip through `toPlan()`. Prefer `.where()` when
   * possible.
   */
  filter(fn: (record: T) => boolean): ScanBuilder<T, S, M> {
    const clause: Clause = {
      type: 'filter',
      fn: fn as (record: unknown) => boolean,
    }
    return new ScanBuilder<T, S, M>(
      this.pageProvider,
      this.pageSize,
      [...this.clauses, clause],
      this.joins,
      this.joinContext,
      this.via,
    )
  }

  /**
   * Resolve a `ref()`-declared foreign key per record as the scan
   * stream flows, attaching the right-side record (or null) under
   * `opts.as`. — streaming joins over `scan()`.
   *
   * ```ts
   * for await (const inv of invoices.scan().join('clientId', { as: 'client' })) {
   *   await processInvoice(inv) // inv.client is attached
   * }
   *
   * // Or terminate with .aggregate() for streaming joined aggregation
   * const { total } = await invoices.scan()
   *   .where('status', '==', 'open')
   *   .join('clientId', { as: 'client' })
   *   .aggregate({ total: sum('amount') })
   * ```
   *
   * **The key difference from eager `.join()`:** the LEFT
   * side streams page-by-page from the adapter and is never
   * materialized. Memory ceiling on the left is O(pageSize), not
   * O(rowCount). This is what makes streaming joins suitable for
   * collections that exceed the eager join's 50_000-row ceiling.
   *
   * **Right-side strategy** is auto-selected per leg:
   *   - **Indexed** — right source exposes `lookupById`, so each
   *     left row costs O(1). This is the common path for
   *     Collection right sides, which back `lookupById` with a Map
   *     lookup over the in-memory cache. The right collection must
   *     be in eager mode (the same constraint as eager join's
   *     `querySourceForJoin` from ).
   *   - **Hash** — right source has only `snapshot()`. Build a
   *     `Map<id, record>` once at iteration start, probe per left
   *     row. Same correctness, same per-row cost as the indexed
   *     path; the difference is the upfront cost of materializing
   *     the right side once.
   *
   * Both strategies hold the right side in memory for the duration
   * of the iteration. The "streaming" property applies to the LEFT
   * side only — true left-and-right streaming joins (where neither
   * side fits in memory) require a sort-merge join planner that's
   * out of scope for.
   *
   * **Ref-mode semantics** match eager `.join()` exactly:
   *   - `strict`  → throws `DanglingReferenceError` mid-stream
   *     when a left record points at a non-existent right id.
   *     The throw aborts the async iterator — consumers should
   *     wrap the `for await` in try/catch if they want to recover.
   *   - `warn`    → attaches `null` and emits a one-shot warning
   *     per unique dangling pair (deduped via the same warn
   *     channel as eager join).
   *   - `cascade` → attaches `null` silently. A delete-time mode;
   *     dangling refs at read time are mid-flight or pre-existing
   *     orphans, not a DSL error.
   *
   * Left records with null/undefined FK values attach `null`
   * regardless of mode — same "no reference at all" policy as
   * eager join and write-time `enforceRefsOnPut`.
   *
   * **Multi-FK chaining** is supported via repeated `.join()`
   * calls: each leg resolves an independent ref. Each leg
   * independently picks its right-side strategy and applies its
   * own ref mode.
   *
   * **Joins are NOT applied** to a `.aggregate()` terminal that
   * doesn't reference joined fields — wait, that's not quite
   * right. The streaming path actually DOES apply joins before
   * `.aggregate()` because the join attaches a field that the
   * spec might reference. Unlike `Query.aggregate()` (which skips
   * joins entirely as a projection-only short-circuit), the
   * streaming aggregation can't know whether the spec touches a
   * joined field, so it always applies joins. Consumers who want
   * unjoined streaming aggregation should leave `.join()` off the
   * chain — the chain is composable for a reason.
   *
   * Every JoinLeg carries `partitionScope: 'all'`, plumbed through but never
   * read. Same seam as the eager join — see {@link JoinLeg.partitionScope}.
   */
  join<As extends string, R = unknown>(
    field: QueryField<T, S>,
    opts: { as: As },
  ): ScanBuilder<T & Record<As, R | null>, S, M> {
    if (!this.joinContext) {
      throw new Error(
        `ScanBuilder.join() requires a join context. Use ` +
          `collection.scan() to construct a join-capable scan instead ` +
          `of the ScanBuilder constructor directly (the direct ` +
          `constructor is only used for tests with synthetic page ` +
          `providers).`,
      )
    }
    const descriptor = this.joinContext.resolveRef(field)
    if (!descriptor) {
      // Typed for the same reason `Query.join()` is (#1139) — see RefNotDeclaredError.
      throw new RefNotDeclaredError({
        collection: this.joinContext.leftCollection,
        field,
        message:
          `ScanBuilder.join(): no ref() declared for field "${field}" on ` +
          `collection "${this.joinContext.leftCollection}". Add ` +
          `refs: { ${field}: ref('<target-collection>') } to the ` +
          `collection options, then retry.`,
      })
    }
    const leg: JoinLeg = {
      field,
      as: opts.as,
      target: descriptor.target,
      mode: descriptor.mode,
      strategy: undefined,
      maxRows: undefined,
      // Always 'all', never read by the streaming executor. This is the
      // path where partition pruning would actually pay (every listPage()
      // page is decrypted) — and the path blocked on a store-contract
      // change. See JoinLeg.partitionScope constraint 2 (#1342).
      partitionScope: 'all',
    }
    return new ScanBuilder<T & Record<As, R | null>, S, M>(
      this.pageProvider as unknown as ScanPageProvider<T & Record<As, R | null>>,
      this.pageSize,
      this.clauses,
      [...this.joins, leg],
      this.joinContext,
      this.via,
    )
  }

  /**
   * Iterate the scan as an async iterable. Walks the page
   * provider's cursors forward until exhaustion, applying every
   * clause per record — only matching records are yielded.
   *
   * Backward-compatible with the previous async-generator `scan()`
   * return type for `for await … of` consumers.
   */
  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    // One-time setup: resolve every join leg's right-side source
    // and pick its strategy (lookupById per row vs hash from
    // snapshot once). Both are O(left) per record after setup; the
    // difference is the upfront cost of hashing the right side
    // when there's no lookupById.
    //
    // Hash maps live for the lifetime of the iteration, so memory
    // for the right side is O(rightRowCount) per leg. Memory for
    // the left side stays O(pageSize) regardless — that's the
    // streaming property we're after.
    const joinResolvers = this.joins.length === 0 ? null : this.buildJoinResolvers()
    // #1030 — a clause addressing a join alias cannot be evaluated against the
    // raw record, where the alias does not exist yet. Split once per
    // iteration, not per record. Streaming pays nothing for this: the
    // post-join predicate runs on the row already in hand, so the O(pageSize)
    // memory property is untouched.
    const { preJoin, postJoin } = splitAroundJoins(this.clauses, this.joins)

    let page = await this.pageProvider.listPage({ limit: this.pageSize })
    while (true) {
      for (const record of page.items) {
        // Filter on the raw stored record (same order as Query.toArray:
        // clauses first), then decode Via-covered fields (e.g. money, to
        // the canonical decimal) before yielding so scan() never leaks the
        // internal stored representation.
        if (!this.recordMatches(record, preJoin)) continue
        const decoded = this.decodeVia(record)
        if (joinResolvers === null) {
          yield decoded
        } else {
          // Apply every join leg in declaration order. Each
          // leg attaches a field — the result of one leg becomes
          // the input to the next. Multi-FK chaining is
          // supported by construction.
          let attached: unknown = decoded
          for (const resolver of joinResolvers) {
            attached = this.applyOneJoinStreaming(attached, resolver)
          }
          if (postJoin.length > 0 && !this.recordMatches(attached as T, postJoin)) continue
          yield attached as T
        }
      }
      if (page.nextCursor === null) return
      page = await this.pageProvider.listPage({
        cursor: page.nextCursor,
        limit: this.pageSize,
      })
    }
  }

  /**
   * Per-leg right-side resolution state. Built once at iteration
   * start and reused for every left record. Two strategies:
   *
   *   - `lookupById`: present when the right source exposes the
   *     hook directly (typical Collection right side). Per-row
   *     cost is O(1).
   *   - `hashByPrimaryKey`: built from `snapshot()` when no
   *     lookupById. Per-row cost is O(1) after the upfront O(N)
   *     materialization. Same as eager join's hash strategy.
   *
   * `warnedKeys` is the per-leg dedup set for ref-mode 'warn'. We
   * key on `field→target:refId` so the same dangling pair only
   * warns once per iteration. The dedup is per-iteration, not
   * per-process — a long-running scan that re-iterates would warn
   * again, which is the desired behavior (the data may have
   * changed between iterations).
   */
  private buildJoinResolvers(): Array<{
    leg: JoinLeg
    source: JoinableSource
    lookupById: ((id: string) => unknown) | null
    hashByPrimaryKey: ReadonlyMap<string, unknown> | null
    warnedKeys: Set<string>
  }> {
    if (!this.joinContext) {
      // Unreachable — .join() throws if joinContext is missing.
      // Belt-and-braces because the iterator is invoked via
      // Symbol.asyncIterator on a builder that may have been
      // constructed via the direct constructor with pre-populated
      // joins.
      throw new Error(
        `ScanBuilder iterator: ${this.joins.length} join leg(s) ` +
          `present but no JoinContext attached. Use collection.scan() ` +
          `to construct a join-capable scan.`,
      )
    }
    const resolvers: Array<{
      leg: JoinLeg
      source: JoinableSource
      lookupById: ((id: string) => unknown) | null
      hashByPrimaryKey: ReadonlyMap<string, unknown> | null
      warnedKeys: Set<string>
    }> = []
    for (const leg of this.joins) {
      const source = this.joinContext.resolveSource(leg.target)
      if (!source) {
        throw new Error(
          `ScanBuilder.join() cannot resolve target collection ` +
            `"${leg.target}" (referenced from field "${leg.field}" on ` +
            `"${this.joinContext.leftCollection}"). Make sure the target ` +
            `collection has been opened via vault.collection() ` +
            `at least once before iterating the scan.`,
        )
      }
      // Strategy selection: prefer lookupById when available
      // (O(1) per row, no upfront cost), fall back to hashing
      // snapshot() once otherwise.
      let lookupById: ((id: string) => unknown) | null = null
      let hashByPrimaryKey: ReadonlyMap<string, unknown> | null = null
      if (source.lookupById) {
        // Bind through an arrow so the lookupById's `this`
        // doesn't drift — same pattern as the eager join's
        // strategy resolver.
        const fn = source.lookupById.bind(source)
        lookupById = (id: string): unknown => fn(id)
      } else {
        const map = new Map<string, unknown>()
        for (const record of source.snapshot()) {
          const rawId = readPath(record, 'id')
          const key = coerceRefKey(rawId)
          if (key !== null) map.set(key, record)
        }
        hashByPrimaryKey = map
      }
      resolvers.push({
        leg,
        source,
        lookupById,
        hashByPrimaryKey,
        warnedKeys: new Set<string>(),
      })
    }
    return resolvers
  }

  /**
   * Resolve a single join leg for one left record and return the
   * left record with the joined field attached under
   * `leg.as`. Pure function over `(left, resolver)`; never
   * mutates the input.
   *
   * Ref-mode dispatch matches eager `applyJoins` from :
   *   - null/undefined FK → attach null silently (always allowed)
   *   - dangling FK + strict → throw `DanglingReferenceError`
   *   - dangling FK + warn → attach null, warn-once per pair
   *   - dangling FK + cascade → attach null silently
   */
  private applyOneJoinStreaming(
    left: unknown,
    resolver: {
      leg: JoinLeg
      source: JoinableSource
      lookupById: ((id: string) => unknown) | null
      hashByPrimaryKey: ReadonlyMap<string, unknown> | null
      warnedKeys: Set<string>
    },
  ): unknown {
    if (left === null || typeof left !== 'object') {
      // Pathological input; matches eager join's defensive return.
      return left
    }
    const { leg } = resolver
    const rawId = readPath(left, leg.field)
    const refKey = coerceRefKey(rawId)
    let right: unknown = undefined
    if (refKey !== null) {
      if (resolver.lookupById !== null) {
        right = resolver.lookupById(refKey)
      } else if (resolver.hashByPrimaryKey !== null) {
        right = resolver.hashByPrimaryKey.get(refKey)
      }
    }

    const merged: Record<string, unknown> = {
      ...(left as Record<string, unknown>),
    }
    if (right === undefined) {
      // No matching record. Distinguish "no ref at all" (null FK)
      // from "dangling ref" (FK pointed at nothing).
      if (refKey !== null && leg.mode === 'strict') {
        throw new DanglingReferenceError({
          field: leg.field,
          target: leg.target,
          refId: refKey,
          message:
            `ScanBuilder.join() strict dangling: record references ` +
            `"${leg.target}:${refKey}" via field "${leg.field}", but no ` +
            `such record exists. Use ref() mode 'warn' or 'cascade' if ` +
            `dangling refs are acceptable, or run ` +
            `vault.checkIntegrity() to find and fix the orphans.`,
        })
      }
      if (refKey !== null && leg.mode === 'warn') {
        const dedupKey = `${leg.field}→${leg.target}:${refKey}`
        if (!resolver.warnedKeys.has(dedupKey)) {
          resolver.warnedKeys.add(dedupKey)
          console.warn(
            `[noy-db] ScanBuilder.join() encountered dangling ref in ` +
              `'warn' mode: field "${leg.field}" → "${leg.target}:` +
              `${refKey}" not found. Attaching null.`,
          )
        }
      }
      // strict already threw above; warn falls through here; cascade
      // hits this path silently.
      merged[leg.as] = null
    } else {
      merged[leg.as] = right
    }
    return merged
  }

  /**
   * Reduce the scan stream through a named set of reducers and
   * return the final aggregated shape.
   *
   * Memory is O(reducers): one mutable state slot per spec key.
   * Records flow through the pipeline one at a time via
   * `for await` and are discarded after their `step()` is applied
   * — never collected into an array. This is the distinguishing
   * property from `Query.aggregate()`, which materializes the full
   * match set first.
   *
   * Reuses the same reducer protocol as `Query.aggregate()`,
   * so `count()`, `sum(field)`, `avg(field)`, `min(field)`,
   * `max(field)` all work unchanged. The `{ seed }` parameter
   * plumbing from  constraint #2 is honored transparently — the
   * factories ignore it in and the scan executor never
   * touches the per-reducer state construction.
   *
   * **Returns a Promise**, unlike `Query.aggregate().run()` which
   * is synchronous. The scan is inherently async because it walks
   * adapter pages, so the terminal has to be too. Consumers
   * destructure with await:
   *
   * ```ts
   * const { total, n } = await invoices.scan()
   *   .where('year', '==', 2025)
   *   .aggregate({ total: sum('amount'), n: count() })
   * ```
   *
   * **No `.live()` in.** `scan().aggregate().live()` would
   * require reconciling an unbounded streaming iteration with a
   * change-stream subscription — a design problem, not just a code
   * one. Consumers with huge collections and live needs should
   * narrow with `.where()` enough to fit in the 50k `query()`
   * limit and use `query().aggregate().live()` instead.
   *
   * Consults the Via pipeline's posture before reducing (#629 Task 8 review
   * fix wave 1): a reducer over a field whose posture is `queryable: 'none'`
   * throws `FieldNotQueryableError` here, metadata-only — via
   * `ViaPipeline.refuseUnqueryableReducers`, NOT the full `wrapReducers`
   * (which would also activate money's exact-reducer rewrite, a path this
   * method has never run and must not start running as a side effect of
   * this gate).
   */
  // `const` so an inline `[specA, specB]` infers as a TUPLE, not a `Spec[]` —
  // that is what makes `const [a, b] = await …` land on the right shapes.
  async aggregate<const Specs extends readonly ReduceSpec[]>(specs: Specs): Promise<MultiReduceResult<Specs>>
  async aggregate<Spec extends ReduceSpec>(spec: Spec): Promise<ReduceResult<Spec>>
  async aggregate<Spec extends ReduceSpec>(build: (b: ReducerBuilder<T, S, M>) => Spec): Promise<ReduceResult<Spec>>
  async aggregate<Spec extends ReduceSpec>(
    specOrBuild: Spec | readonly ReduceSpec[] | ((b: ReducerBuilder<T, S, M>) => Spec),
  ): Promise<ReduceResult<Spec> | unknown[]> {
    // #1340 — the multi-spec form. N independent specs, ONE pass: the states
    // for every spec are stepped from the same yielded record, so the page
    // provider is walked exactly once no matter how many specs are passed.
    // (Calling `.aggregate(specA)` then `.aggregate(specB)` costs two full
    // scans — the immutable-builder docs above say so, and this is the fix.)
    if (Array.isArray(specOrBuild)) return this.aggregateMany(specOrBuild as readonly ReduceSpec[])
    // Opt-in builder form `aggregate(b => spec)`: `b`'s field args are
    // `QueryField<T, S>`, refusing sensitive fields (the standalone-spec form
    // stays unrefused for back-compat), and `sum`/`min`/`max` over a declared
    // `moneyFields` (`M`) member return a `MoneyString`. Mirrors `Query.aggregate`.
    const spec: Spec = typeof specOrBuild === 'function'
      ? (specOrBuild as (b: ReducerBuilder<T, S, M>) => Spec)(reducerBuilder as unknown as ReducerBuilder<T, S, M>)
      // `Array.isArray` above does not narrow a READONLY array out of the
      // union, so the array arm is already returned and this cast is the
      // remainder — a plain spec.
      : (specOrBuild as Spec)
    this.via?.refuseUnqueryableReducers(spec)
    const keys = Object.keys(spec)
    // Per-reducer state. Exactly |keys| entries, never grows with
    // the record count — that's the O(reducers) memory guarantee.
    const state: Record<string, unknown> = {}
    for (const key of keys) {
      state[key] = spec[key]!.init()
    }

    // Record-by-record streaming step. `for await (… of this)`
    // invokes the Symbol.asyncIterator above, which honors the
    // clause list, so filtered-out records never reach the step
    // loop — they're dropped at the iterator boundary.
    for await (const record of this) {
      for (const key of keys) {
        state[key] = spec[key]!.step(state[key], record)
      }
    }

    const result: Record<string, unknown> = {}
    for (const key of keys) {
      result[key] = spec[key]!.finalize(state[key])
    }
    return result as ReduceResult<Spec>
  }

  /**
   * The multi-spec `.aggregate([specA, specB, …])` executor (#1340).
   *
   * One iteration of the scan, `Σ|spec|` reducer states — memory stays
   * O(reducers) exactly as the single-spec terminal's does, with the sum taken
   * across specs instead of within one. Every spec's state is stepped from the
   * SAME yielded record, so the page provider is read once per page.
   *
   * Semantics per spec are identical to the single-spec form, deliberately:
   * the posture gate is `refuseUnqueryableReducers` (metadata only), NOT the
   * full `wrapReducers` — so `aggregate([a, b])` returns exactly what
   * `aggregate(a)` and `aggregate(b)` return, and the array form is a pure
   * cost optimisation with no behavioural delta to reason about. (The grouped
   * scan path DOES wrap — it has to agree with the eager grouped path, which
   * wraps. See `scan-groupby.ts`.)
   */
  private async aggregateMany(specs: readonly ReduceSpec[]): Promise<unknown[]> {
    for (const spec of specs) this.via?.refuseUnqueryableReducers(spec)
    const keysPerSpec = specs.map((spec) => Object.keys(spec))
    const states: Record<string, unknown>[] = specs.map((spec, i) => {
      const state: Record<string, unknown> = {}
      for (const key of keysPerSpec[i]!) state[key] = spec[key]!.init()
      return state
    })

    for await (const record of this) {
      for (let i = 0; i < specs.length; i++) {
        const spec = specs[i]!
        const state = states[i]!
        for (const key of keysPerSpec[i]!) state[key] = spec[key]!.step(state[key], record)
      }
    }

    return specs.map((spec, i) => {
      const result: Record<string, unknown> = {}
      for (const key of keysPerSpec[i]!) result[key] = spec[key]!.finalize(states[i]![key])
      return result
    })
  }

  /**
   * Group the scan stream and reduce each group — `#1340`.
   *
   * ```ts
   * const byClient = await invoices.scan()
   *   .where('status', '==', 'open')
   *   .groupBy('clientId', { maxGroups: 5_000 })
   *   .aggregate({ total: sum('amount'), n: count() })
   * ```
   *
   * ⚠️ **This is the one scan terminal whose memory is NOT O(pageSize).** It
   * holds one reducer state per group, which is why the budget is explicit:
   * `maxGroups` defaults to the eager path's 100_000-group ceiling and is
   * REFUSED — never truncated — the moment a scan would exceed it. Price the
   * budget before raising it: an exact `median`/`percentile`, a `mode` or a
   * `countDistinct` holds O(values) per group, so an unbounded scan wants
   * `{ approx: true }` on the quantiles. Full rationale in `scan-groupby.ts`.
   *
   * The key may be a field name or a `dateTrunc()` derived calendar key (the
   * monthly-rollup shape); grouping BY a `sensitive` field is refused at
   * compile time, same as `Query.groupBy()`.
   */
  groupBy<F extends QueryField<T, S>>(field: F, opts?: { maxGroups?: number }): ScanGroupedScan<T, F, S, M>
  groupBy(key: DateTruncKey, opts?: { maxGroups?: number }): ScanGroupedScan<T, string, S, M>
  groupBy(key: QueryField<T, S> | DateTruncKey, opts?: { maxGroups?: number }): ScanGroupedScan<T, string, S, M> {
    return new ScanGroupedScan<T, string, S, M>(
      this,
      key as string | DateTruncKey,
      opts?.maxGroups ?? SCAN_GROUPBY_DEFAULT_MAX_GROUPS,
      this.via,
    )
  }

  /**
   * Evaluate the clause list against a single record. Linear in
   * the clause count; short-circuits on first false. Clauses on a
   * scan are always re-evaluated per record — no index-accelerated
   * path, because the stream sources records from the adapter
   * paginator, not from the in-memory cache where indexes live.
   */
  private recordMatches(record: T, clauses: readonly Clause[] = this.clauses): boolean {
    if (clauses.length === 0) return true
    // User-callback clauses (filter) see the DECODED view (e.g. money's
    // canonical decimal); field clauses keep the raw record — their
    // operands are pre-built into stored space. Decoded at most once per
    // record, only when a callback clause exists.
    const fnView =
      this.via?.hasResultDecode && hasFnClause(clauses)
        ? this.decodeVia(record)
        : undefined
    for (const clause of clauses) {
      if (!evaluateClause(record, clause, fnView)) return false
    }
    return true
  }
}

/**
 * Coerce an unknown FK value into a lookup key string.
 *
 * Mirror of the same helper in `query/join.ts` — kept local to
 * `scan-builder.ts` to avoid pulling the eager join executor's
 * surface area into this file. Strings and numbers convert to
 * string keys; everything else (objects, arrays, booleans, null,
 * undefined) returns null and is treated as "no ref at all".
 *
 * Matches the write-time `enforceRefsOnPut` policy: nullish ref
 * values are never dangling, regardless of mode.
 */
function coerceRefKey(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'bigint') return String(value)
  return null
}

/**
 * ── Grouped streaming reduction over a `scan()` — `#1340` ──────────────────
 *
 * `scan().groupBy(key, { maxGroups }).aggregate(spec)` folds an unbounded,
 * page-by-page scan into one row per group. The distinguishing property
 * against the eager `Query.groupBy()` path is WHAT IS HELD:
 *
 *   - eager (`groupAndReduce` in `with-lookup/reduce/groupby.ts`) partitions
 *     the matched records into `Map<key, records[]>` and reduces each bucket
 *     afterwards — O(matched records) memory;
 *   - this one holds **one reducer state per group and no records at all** —
 *     O(groups × state), with the left side still streaming at O(pageSize).
 *
 * So the two cannot share an implementation, and this deliberately does
 * NOT use `groupAndReduce`: reusing it would mean collecting the stream,
 * which is the exact thing `scan()` exists to avoid. What IS shared is every
 * piece that decides SEMANTICS — the group-key canonicalisation (so `null`
 * and `undefined` bucket apart here exactly as they do there), the reducer
 * protocol, `ViaPipeline.wrapReducers` (money stays BigInt-exact),
 * `bindDistinctReducers` (`countDistinct` dedups on the canonical index key),
 * and `projectDateTruncKeys` (a derived calendar key is stamped onto a
 * shallow copy of the row before bucketing, same as `Query.groupBy()`).
 *
 * ## The memory budget IS the feature
 *
 * `maxGroups` defaults to `GROUPBY_MAX_CARDINALITY` (100_000) — the same
 * ceiling the eager path enforces — and is refused the moment the group that
 * would exceed it is first seen, mid-stream, before its state is allocated.
 * ⛔ It never truncates: a truncated rollup is a WRONG ANSWER that looks like
 * a right one, and the whole point of declaring a budget is to learn that the
 * grouping does not fit. The refusal names the option and the observed count.
 *
 * ⚠️ **Per-group state is NOT constant.** `count`/`sum`/`avg`/`min`/`max` are
 * O(1) per group, but `median`/`percentile` (exact) hold every sampled value
 * — O(n) per group — `mode` holds one entry per distinct value, and
 * `countDistinct` one per distinct value. A grouped scan with an exact
 * `median` is therefore O(matched records) overall no matter what `maxGroups`
 * says, since the values live in the group states. Pair it with
 * `{ approx: true }` (the t-digest, bounded per group) when the scan is
 * genuinely unbounded — that is what makes `maxGroups` a real ceiling rather
 * than an accounting fiction.
 *
 * ## Post-group `having` / `orderBy` / `limit` (#1336) are NOT on this path
 *
 * Those live on `GroupedReduction`, which is built around a SYNCHRONOUS
 * `executeRecords()` closure and the eager pipeline; a scan has neither.
 * Rather than grow a second, subtly different implementation of the same
 * three operations, this terminal returns the row array — bounded by
 * `maxGroups` and already in memory — and the caller filters, sorts and
 * slices it. See the report on #1340; if a consumer wants the chainable
 * shape, the honest fix is to lift the post-group stage out of
 * `GroupedReduction` and share it, not to copy it here.
 *
 * ⚠️ Lives in THIS file rather than its own `scan-groupby.ts` for one
 * mechanical reason: `check-architecture`'s `port-layering` ratchet
 * grandfathers `scan-builder.ts`'s two `with-lookup/reduce/*` imports per
 * specifier, and a NEW kernel file may not statically import a `with-*`
 * service at all. Splitting it out means either a dynamic import on the
 * reducer protocol or a new grandfather entry; neither is worth it for a
 * class that only exists to terminate `ScanBuilder.groupBy()`.
 */

/**
 * Default group ceiling — the same constant the eager `.groupBy()` enforces.
 * Duplicated as a literal rather than imported from
 * `with-lookup/reduce/groupby.ts` on purpose: that module carries the eager
 * `groupAndReduce` + `GroupedReduction` classes, and the always-on kernel must
 * not pull them in to read one number. The pairing is asserted by a test.
 */
export const SCAN_GROUPBY_DEFAULT_MAX_GROUPS = 100_000

/**
 * Single-field spelling of `canonicalGroupKey` (`with-lookup/reduce/canonical-key.ts`).
 *
 * ⛔ Inlined, not imported, and not by preference: `check-architecture`'s
 * `port-layering` rule grandfathers this file for exactly two
 * `with-lookup/reduce/*` specifiers (`reducers.js`, `reduction.js`), and
 * `canonical-key.js` is not one of them — a new one may not be added
 * silently. The eager helper sorts its field list and serialises
 * each value — with exactly one field, that reduces to this line, including
 * the part that matters: `undefined` gets a sentinel so a MISSING key and an
 * explicit `null` land in different buckets, as they do under
 * `Query.groupBy()`. The agreement is held by test, not by comment
 * (`query-scan-groupby.test.ts` — null/undefined bucketing, and full equality
 * with the eager path).
 */
function scanGroupKey(field: string, value: unknown): string {
  return `${field}=${value === undefined ? 'undefined' : JSON.stringify(value)}`
}

/** Group-key result-row shape: the key under its own name, plus the reducers. */
export type ScanGroupedRow<F extends string, R> = { [K in F]: unknown } & R

/**
 * Chainable wrapper returned by `ScanBuilder.groupBy()`. The only operation on
 * it is `.aggregate()` — same minimal shape as `GroupedQuery`.
 */
export class ScanGroupedScan<
  T,
  F extends string,
  S extends keyof T = never,
  M extends keyof T & string = never,
> {
  constructor(
    private readonly stream: AsyncIterable<T>,
    private readonly key: string | DateTruncKey,
    private readonly maxGroups: number,
    private readonly via: ViaPipeline | undefined,
  ) {
    if (!Number.isInteger(maxGroups) || maxGroups < 1) {
      throw new Error(
        `scan().groupBy(): { maxGroups: ${String(maxGroups)} } must be a positive integer — ` +
          `it is the declared ceiling on how many reducer states the grouped scan may hold.`,
      )
    }
  }

  /**
   * Fold the scan into one row per group. Resolves to `R[]`, ordered by each
   * group's FIRST-SEEN position in the stream (`Map` insertion order), which
   * is the same ordering rule the eager path documents.
   *
   * ```ts
   * const byMonth = await invoices.scan()
   *   .where('status', '==', 'paid')
   *   .groupBy(dateTrunc('closedAt', 'month', { as: 'month', timeZone: 'UTC' }), { maxGroups: 240 })
   *   .aggregate({ total: sum('amount'), n: count() })
   * ```
   */
  async aggregate<Spec extends ReduceSpec>(spec: Spec): Promise<ScanGroupedRow<F, ReduceResult<Spec>>[]>
  async aggregate<Spec extends ReduceSpec>(
    build: (b: ReducerBuilder<T, S, M>) => Spec,
  ): Promise<ScanGroupedRow<F, ReduceResult<Spec>>[]>
  async aggregate<Spec extends ReduceSpec>(
    specOrBuild: Spec | ((b: ReducerBuilder<T, S, M>) => Spec),
  ): Promise<ScanGroupedRow<F, ReduceResult<Spec>>[]> {
    const raw: Spec =
      typeof specOrBuild === 'function'
        ? (specOrBuild as (b: ReducerBuilder<T, S, M>) => Spec)(reducerBuilder as unknown as ReducerBuilder<T, S, M>)
        : specOrBuild
    // Same reducer rewriting as the eager grouped path, and for the same
    // reason: a money `sum` must accumulate per-currency BigInt totals, and a
    // `countDistinct` must dedup on the canonical index key — otherwise a
    // grouped scan and a grouped query disagree on identical data.
    // `wrapReducers` runs the `queryable: 'none'` posture refusal itself.
    const spec: ReduceSpec = bindDistinctReducers(this.via ? this.via.wrapReducers(raw) : raw, this.via)
    const keys = Object.keys(spec)

    const field = groupKeyName(this.key)
    const derived: readonly DateTruncKey[] = isDateTruncKey(this.key) ? [this.key] : []
    const groups = new Map<string, { keyValue: unknown; state: Record<string, unknown> }>()

    for await (const record of this.stream) {
      // A derived calendar key is stamped onto a shallow copy before bucketing
      // — the reducers then see an ordinary row carrying an ordinary field,
      // exactly as they do under `Query.groupBy(dateTrunc(...))`.
      const row = derived.length === 0 ? record : projectDateTruncKeys([record], derived)[0]!
      const keyValue = readPath(row, field)
      const dedupKey = scanGroupKey(field, keyValue)
      let group = groups.get(dedupKey)
      if (group === undefined) {
        if (groups.size >= this.maxGroups) {
          // Loud and early: the state for this group is never allocated, so
          // the refusal fires at the budget, not after blowing through it.
          throw new GroupCardinalityError(field, groups.size + 1, this.maxGroups, 'scan')
        }
        const state: Record<string, unknown> = {}
        for (const k of keys) state[k] = spec[k]!.init()
        group = { keyValue, state }
        groups.set(dedupKey, group)
      }
      for (const k of keys) group.state[k] = spec[k]!.step(group.state[k], row)
    }

    const out: ScanGroupedRow<F, ReduceResult<Spec>>[] = []
    for (const group of groups.values()) {
      // Group key first, then the reducer outputs — same row shape as the
      // eager path, which tests assert by key order.
      const outRow: Record<string, unknown> = { [field]: group.keyValue }
      for (const k of keys) outRow[k] = spec[k]!.finalize(group.state[k])
      out.push(outRow as ScanGroupedRow<F, ReduceResult<Spec>>)
    }
    return out
  }
}
