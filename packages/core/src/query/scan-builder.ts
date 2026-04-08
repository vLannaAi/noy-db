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
import { evaluateClause } from './predicate.js'
import type {
  AggregateSpec,
  AggregateResult,
} from './aggregate.js'

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

  constructor(
    pageProvider: ScanPageProvider<T>,
    pageSize: number = DEFAULT_SCAN_PAGE_SIZE,
    clauses: readonly Clause[] = [],
  ) {
    this.pageProvider = pageProvider
    this.pageSize = pageSize
    this.clauses = clauses
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
    return new ScanBuilder<T>(this.pageProvider, this.pageSize, [
      ...this.clauses,
      clause,
    ])
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
    return new ScanBuilder<T>(this.pageProvider, this.pageSize, [
      ...this.clauses,
      clause,
    ])
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
    let page = await this.pageProvider.listPage({ limit: this.pageSize })
    while (true) {
      for (const record of page.items) {
        if (this.recordMatches(record)) yield record
      }
      if (page.nextCursor === null) return
      page = await this.pageProvider.listPage({
        cursor: page.nextCursor,
        limit: this.pageSize,
      })
    }
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
