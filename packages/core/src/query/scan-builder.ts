/**
 * Streaming scan builder with filter + aggregate support.
 *
 * v0.6 #99 — `Collection.scan()` now returns a `ScanBuilder<T>` that
 * implements `AsyncIterable<T>` (for existing `for await … of`
 * consumers) AND exposes chainable `.where()` / `.filter()` clauses
 * plus a `.aggregate(spec)` async terminal that reduces the scan
 * stream through the same reducer protocol as `Query.aggregate()`
 * (#97).
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
 * iteration across the two. Multi-way aggregation in a single pass
 * is out of scope for v0.6; consumers who need it should build a
 * compound spec and run a single `.aggregate({ openN, paidN })` at
 * the DSL level.
 *
 * **Out of scope for v0.6 (tracked separately):**
 *   - `scan().aggregate().live()` — unbounded scan + change-stream
 *     reconciliation is a design problem, not just a code one
 *   - `scan().groupBy().aggregate()` — high-cardinality grouping on
 *     huge collections would re-introduce the O(groups) memory
 *     problem that aggregate fixes
 *   - Parallel scan across pages — race-safe page cursor contracts
 *     are not in the adapter API yet
 *   - `scan().join(...)` — tracked under #76 (streaming join)
 */

import type { Clause, FieldClause, Operator } from './predicate.js'
import { evaluateClause, readPath } from './predicate.js'
import type {
  AggregateSpec,
  AggregateResult,
} from './aggregate.js'
import type { JoinContext, JoinLeg, JoinableSource } from './join.js'
import { DanglingReferenceError } from '../errors.js'

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
export class ScanBuilder<T> implements AsyncIterable<T> {
  private readonly pageProvider: ScanPageProvider<T>
  private readonly pageSize: number
  private readonly clauses: readonly Clause[]
  /**
   * Zero-or-more join legs to apply per record as the stream flows.
   * Each leg attaches the resolved right-side record (or null) under
   * its alias. v0.6 #76 — streaming joins.
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

  constructor(
    pageProvider: ScanPageProvider<T>,
    pageSize: number = DEFAULT_SCAN_PAGE_SIZE,
    clauses: readonly Clause[] = [],
    joins: readonly JoinLeg[] = [],
    joinContext?: JoinContext,
  ) {
    this.pageProvider = pageProvider
    this.pageSize = pageSize
    this.clauses = clauses
    this.joins = joins
    this.joinContext = joinContext
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
   */
  where(field: string, op: Operator, value: unknown): ScanBuilder<T> {
    const clause: FieldClause = { type: 'field', field, op, value }
    return new ScanBuilder<T>(
      this.pageProvider,
      this.pageSize,
      [...this.clauses, clause],
      this.joins,
      this.joinContext,
    )
  }

  /**
   * Escape hatch: add an arbitrary predicate function. Same
   * non-serializable caveat as `Query.filter()` — filter clauses
   * don't round-trip through `toPlan()`. Prefer `.where()` when
   * possible.
   */
  filter(fn: (record: T) => boolean): ScanBuilder<T> {
    const clause: Clause = {
      type: 'filter',
      fn: fn as (record: unknown) => boolean,
    }
    return new ScanBuilder<T>(
      this.pageProvider,
      this.pageSize,
      [...this.clauses, clause],
      this.joins,
      this.joinContext,
    )
  }

  /**
   * Resolve a `ref()`-declared foreign key per record as the scan
   * stream flows, attaching the right-side record (or null) under
   * `opts.as`. v0.6 #76 — streaming joins over `scan()`.
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
   * **The key difference from eager `.join()` (#73):** the LEFT
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
   *     `querySourceForJoin` from #73).
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
   * out of scope for v0.6.
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
   * #87 constraint #1 — every JoinLeg carries `partitionScope:
   * 'all'` plumbed through but never read by v0.6. Same seam as
   * eager join (#73).
   */
  join<As extends string, R = unknown>(
    field: string,
    opts: { as: As },
  ): ScanBuilder<T & Record<As, R | null>> {
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
      throw new Error(
        `ScanBuilder.join(): no ref() declared for field "${field}" on ` +
          `collection "${this.joinContext.leftCollection}". Add ` +
          `refs: { ${field}: ref('<target-collection>') } to the ` +
          `collection options, then retry.`,
      )
    }
    const leg: JoinLeg = {
      field,
      as: opts.as,
      target: descriptor.target,
      mode: descriptor.mode,
      strategy: undefined,
      maxRows: undefined,
      // #87 constraint #1 — always 'all' in v0.6, never read by
      // the streaming executor. v0.10 partition-aware scan joins
      // will populate this from where() predicates without
      // changing the planner shape.
      partitionScope: 'all',
    }
    return new ScanBuilder<T & Record<As, R | null>>(
      this.pageProvider as unknown as ScanPageProvider<T & Record<As, R | null>>,
      this.pageSize,
      this.clauses,
      [...this.joins, leg],
      this.joinContext,
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

    let page = await this.pageProvider.listPage({ limit: this.pageSize })
    while (true) {
      for (const record of page.items) {
        if (!this.recordMatches(record)) continue
        if (joinResolvers === null) {
          yield record
        } else {
          // Apply every join leg in declaration order. Each
          // leg attaches a field — the result of one leg becomes
          // the input to the next. Multi-FK chaining (#75) is
          // supported by construction.
          let attached: unknown = record
          for (const resolver of joinResolvers) {
            attached = this.applyOneJoinStreaming(attached, resolver)
          }
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
            `collection has been opened via compartment.collection() ` +
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
   * Ref-mode dispatch matches eager `applyJoins` from #73:
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
            `compartment.checkIntegrity() to find and fix the orphans.`,
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
   * Reuses the same reducer protocol as `Query.aggregate()` (#97),
   * so `count()`, `sum(field)`, `avg(field)`, `min(field)`,
   * `max(field)` all work unchanged. The `{ seed }` parameter
   * plumbing from #87 constraint #2 is honored transparently — the
   * factories ignore it in v0.6 and the scan executor never
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
   * **No `.live()` in v0.6.** `scan().aggregate().live()` would
   * require reconciling an unbounded streaming iteration with a
   * change-stream subscription — a design problem, not just a code
   * one. Consumers with huge collections and live needs should
   * narrow with `.where()` enough to fit in the 50k `query()`
   * limit and use `query().aggregate().live()` instead.
   */
  async aggregate<Spec extends AggregateSpec>(
    spec: Spec,
  ): Promise<AggregateResult<Spec>> {
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
    return result as AggregateResult<Spec>
  }

  /**
   * Evaluate the clause list against a single record. Linear in
   * the clause count; short-circuits on first false. Clauses on a
   * scan are always re-evaluated per record — no index-accelerated
   * path, because the stream sources records from the adapter
   * paginator, not from the in-memory cache where indexes live.
   */
  private recordMatches(record: T): boolean {
    if (this.clauses.length === 0) return true
    for (const clause of this.clauses) {
      if (!evaluateClause(record, clause)) return false
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
