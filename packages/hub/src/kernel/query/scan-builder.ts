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
import type { Clause, FieldClause, Operator } from './predicate.js'
import { evaluateClause, hasFnClause, normalizeMatches, normalizeSubqueryOperand } from './predicate.js'
import type { ReduceSpec, ReduceResult } from '../../with-lookup/reduce/reduction.js'
// ─── #1458 — Relate is TYPE-ONLY here, same as in `builder.ts` ───────────
// The streaming iterator has to be able to run a plan that carries legs; it
// cannot BUILD one. `splitAroundJoins` is the Find-side shim (join-conditional,
// with the empty answer inline) that `builder.ts` publishes for both builders,
// so the two cannot drift on what "pre-join" means.
import type { JoinContext, JoinLeg } from './relate/join.js'
import type { ScanJoinResolver } from './relate/scan-methods.js'
import { splitAroundJoins } from './builder.js'
import { FieldNotQueryableError, QueryExtensionMissingError } from '../errors.js'
import type { ViaPipeline } from '../via/pipeline.js'

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

  // ─── #1458 — installed by the extension subpaths ────────────────────────
  //
  // `ScanBuilder` is split the same way `Query` is: Find here, Reduce and
  // Relate in `@noy-db/hub/query/{reduce,relate}`. These two are declared
  // rather than defined because the ITERATOR below calls them, and it stays in
  // Find — both calls are behind `joins.length === 0`, which only Relate's
  // `join()` can make false.
  declare protected buildJoinResolvers: () => ScanJoinResolver[]
  declare protected applyOneJoinStreaming: (record: unknown, resolver: ScanJoinResolver) => unknown

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

// ─── #1458 — ScanBuilder's extension stubs ────────────────────────────────
// Same mechanism, and the same reason for not declaring them on the class, as
// `builder.ts`'s block: the method's TYPE must arrive with its subpath.
const SCAN_EXTENSION_METHODS: readonly (readonly [string, string])[] = [
  ['aggregate', '@noy-db/hub/query/reduce'],
  ['groupBy', '@noy-db/hub/query/reduce'],
  ['join', '@noy-db/hub/query/relate'],
]

for (const [method, subpath] of SCAN_EXTENSION_METHODS) {
  Object.defineProperty(ScanBuilder.prototype, method, {
    value: function scanExtensionMissing(): never {
      throw new QueryExtensionMissingError(`scan().${method}`, subpath)
    },
    writable: true,
    enumerable: false,
    configurable: true,
  })
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
