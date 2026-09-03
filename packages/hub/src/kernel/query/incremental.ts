/**
 * Incremental (delta) maintenance for `.live()` — #1341.
 *
 * A live query used to re-run its whole plan on every change event: scan
 * every record in the collection, re-evaluate every clause, re-sort, re-slice.
 * That is O(N log N) per keystroke-sized mutation and is what makes a reactive
 * list unusable at 10k+ rows.
 *
 * This module maintains the match set instead. Given a change event
 * `{ id, action }` it re-evaluates the predicate for **that record only** and
 * splices it into (or out of) a sorted array, so the per-change cost is
 * O(log k) comparisons + one array splice, where k is the number of MATCHING
 * records rather than N.
 *
 * ## The correctness contract
 *
 * The maintained array must be **identical** — same records, same order — to
 * what a full re-run would produce, at every step. Two things buy that:
 *
 *   1. **Membership is delegated.** The caller passes the very `matches()`
 *      closure the full pipeline uses (`filterRecords` over the plan's
 *      clauses), so a maintained membership decision cannot drift from an
 *      eagerly-computed one. This module never re-implements a predicate.
 *
 *   2. **The ordering is delegated too, and then made total.** The sort keys
 *      are read and ranked by the query's own order key plan — the same
 *      `buildOrderKeyPlan`/`orderKeyOf`/`compareOrderKeys` trio `sortRecords`
 *      sorts with and the keyset cursor compares against (#1346), so there is
 *      one definition of "what order is this query in" rather than two that
 *      drift. What that trio does NOT decide is equal keys: `compareOrderKeys`
 *      is handed two KEY TUPLES, not two records, so with equal keys its
 *      inputs are indistinguishable and 0 is the only answer it can give —
 *      structurally, not by convention. (#1346 breaks its own ties one level
 *      up, at the `page()` call site, never inside the comparator.) The eager
 *      path lets its stable sort resolve those, leaving them in candidate =
 *      snapshot order; we append each record's snapshot position as a final
 *      key, which is the same resolution stated explicitly — and being
 *      explicit is what lets a binary search land on an exact index.
 *
 *      ⚠️ That rests on one property of the backing cache: **snapshot order is
 *      `Map` insertion order.** `Map.set` on an existing key keeps its slot
 *      (so an update never moves a record), a new key appends (so a new record
 *      sorts last among ties), and `delete` removes without reordering the
 *      rest. `Collection`'s eager cache is a `Map`, so this holds. A source
 *      whose snapshot order is not insertion-stable must not be maintained —
 *      it would produce a correct SET in a wrong ORDER among ties.
 *
 * Anything not provably patchable falls back to a full rebuild: an unknown
 * (payload-less) change event, an error thrown mid-patch, or a plan shape
 * `canMaintainIncrementally()` refuses. **The fallback is the default** —
 * `canMaintainIncrementally` is a whitelist, not a blacklist.
 */

import type { Clause } from './predicate.js'
import type { OrderBy } from './builder.js'

/**
 * The delta a source hands to its `subscribe` callback: which record changed
 * and whether it was written or removed. Deliberately the same shape as the
 * hub-level `ChangeEvent` minus the vault/collection routing fields, which
 * the source has already filtered on.
 *
 * A source that cannot say WHICH record changed simply calls its callback with
 * no argument — every consumer treats that as "rebuild from scratch", which is
 * exactly the pre-#1341 behaviour.
 */
export interface SourceChange {
  readonly id: string
  readonly action: 'put' | 'delete'
}

/** Everything the maintainer needs, supplied by the query builder. */
export interface MaintainerConfig {
  /** Id-paired snapshot, in snapshot (Map insertion) order. */
  snapshotEntries(): readonly { id: string; record: unknown }[]
  /** O(1) current-state lookup, used to read the AFTER state of a change. */
  lookupById(id: string): unknown
  /** The plan's membership test — the same one the eager path runs. */
  matches(record: unknown): boolean
  /**
   * The plan's ordering, in the same key-plan shape `sortRecords` and the
   * keyset cursor use (#1346): read a record's sort-key tuple, and compare two
   * of those tuples. `undefined` when the plan has no `orderBy` — result order
   * is then snapshot order alone.
   *
   * `compare` need not be a total order: it returns 0 for equal sort keys,
   * exactly as it does for the eager sort, and the maintainer resolves those
   * ties by snapshot sequence.
   */
  order?: {
    keyOf(record: unknown): unknown[]
    compare(a: readonly unknown[], b: readonly unknown[]): number
  }
  /** Plan offset (0 when unset). */
  offset: number
  /** Plan limit, or undefined for "all matching rows". */
  limit: number | undefined
  /**
   * Post-slice projection the eager path applies to the emitted window (Via
   * result decoding). Applied to the window, never to the maintained records,
   * mirroring `toArray()` which decodes AFTER filter/sort/slice.
   */
  decode?: (rows: readonly unknown[]) => unknown[]
}

const EMPTY_KEY: readonly unknown[] = []

interface Entry {
  readonly id: string
  readonly seq: number
  readonly record: unknown
  /**
   * The record's sort-key tuple, computed once when the entry is built. Every
   * write to a record re-enters it, so a cached key is never stale — and the
   * binary search then compares tuples instead of re-reading fields at every
   * probe.
   */
  readonly key: readonly unknown[]
}

/**
 * Reject any plan whose result set cannot be provably patched from a single
 * record's delta. Everything this refuses still works — it just re-runs in
 * full, as it did before #1341.
 *
 * Refused, and why:
 *   - **joins / crossJoin** — a row's membership depends on other collections'
 *     records, so a left-side delta does not determine the new result.
 *   - **`.filter(fn)`** — an arbitrary consumer closure with no determinism
 *     guarantee. `r => r.due < Date.now()` changes its verdict for records that
 *     never changed, which a full re-run observes and a patch cannot.
 *     (`.wherePredicate()` is admitted: it is DECLARED deterministic and
 *     carries a body hash saying so.)
 *   - **`orderBy(..., { by: 'label' })`** — the label maps are built eagerly
 *     from a dictionary collection's snapshot, so the comparator would be
 *     captured at subscribe time and go stale when that dictionary changes.
 *   - **an index-driven plan** — the rows then reach the pipeline in INDEX
 *     order rather than snapshot order, so snapshot sequence is the wrong
 *     tiebreak among equal sort keys. Three shapes qualify, and all three are
 *     refused: an `==`/`in` clause on any indexed field, a range clause on a
 *     SORTED-indexed field, and #1344's `orderedIndexRows()` page, which
 *     serves `orderBy(f).limit(n)` straight off a sorted index with no
 *     predicate at all. Little is lost: each of those re-runs is already
 *     proportional to the page or the match set, not to the collection.
 */
export function canMaintainIncrementally(
  plan: {
    readonly clauses: readonly Clause[]
    readonly orderBy: readonly OrderBy[]
    readonly limit?: number | undefined
    readonly joins: readonly unknown[]
  },
  indexes: IndexProbe | null,
): boolean {
  if (plan.joins.length > 0) return false
  if (plan.orderBy.some(o => o.by === 'label')) return false
  if (!clausesMaintainable(plan.clauses)) return false
  if (isIndexDriven(plan.clauses, indexes)) return false
  if (servedByOrderedIndex(plan, indexes)) return false
  return true
}

/**
 * What the maintainer needs to know about the source's indexes: which fields
 * carry ANY index, and which carry a SORTED one. Both matter — the sorted
 * index feeds two paths (#1344) the hash index does not.
 */
export interface IndexProbe {
  covers(field: string): boolean
  sorted(field: string): boolean
}

/**
 * Would #1344's `orderedIndexRows()` serve this plan off a sorted index?
 *
 * Mirrors the cheap half of its preconditions and deliberately stops there:
 * the remaining ones (full index coverage of the snapshot, no Via ordering)
 * cost a snapshot walk to check, and answering "maybe" here only ever costs a
 * fallback. The page it would serve is in stored-key order, and among records
 * with EQUAL keys that order is the index's, not the cache's — which is
 * precisely the tie resolution the maintainer would get wrong.
 */
function servedByOrderedIndex(
  plan: {
    readonly clauses: readonly Clause[]
    readonly orderBy: readonly OrderBy[]
    readonly limit?: number | undefined
  },
  indexes: IndexProbe | null,
): boolean {
  if (!indexes) return false
  if (plan.limit === undefined) return false
  if (plan.clauses.length > 0 || plan.orderBy.length !== 1) return false
  const order = plan.orderBy[0]!
  return order.by !== 'label' && indexes.sorted(order.field)
}

function clausesMaintainable(clauses: readonly Clause[]): boolean {
  for (const clause of clauses) {
    if (clause.type === 'crossJoin' || clause.type === 'filter') return false
    if (clause.type === 'group' && !clausesMaintainable(clause.clauses)) return false
  }
  return true
}

/**
 * Would `candidateRecords()` take the index fast path for this plan?
 *
 * Deliberately more eager to say "yes" than `candidateRecords` itself (which
 * additionally requires the index probe to return a hit set) — erring that way
 * costs a fallback, never a wrong answer.
 */
function isIndexDriven(clauses: readonly Clause[], indexes: IndexProbe | null): boolean {
  if (!indexes) return false
  for (const clause of clauses) {
    if (clause.type !== 'field') continue
    if (!indexes.covers(clause.field) && !indexes.sorted(clause.field)) continue
    // #1344: a range probe reads the SORTED index, and only for a clause the
    // Via layer has not claimed — mirroring `candidateRecords`'s own branch.
    // On a hash-only field `lookupRange` returns null and the plan scans, so
    // that case is left maintainable.
    if (clause.via === undefined && RANGE_OPS.has(clause.op)) return indexes.sorted(clause.field)
    if (clause.via && clause.via.indexValue === undefined) continue
    const probe = clause.via ? clause.via.indexValue : clause.value
    if (clause.op === '==') return true
    if (clause.op === 'in' && Array.isArray(probe)) return true
  }
  return false
}

/** The operators #1344's `lookupRange` serves off a sorted index. */
const RANGE_OPS: ReadonlySet<string> = new Set(['<', '<=', '>', '>=', 'between', 'startsWith'])

/**
 * The maintained result set behind one live query.
 *
 * Lifecycle: `attach()` when a subscription opens, `apply(change)` per upstream
 * event, `rows()` to read the current window. Before `attach()` (and after any
 * fallback) `rows()` recomputes from the snapshot, so a detached maintainer is
 * simply an eager executor and is safe to read at any time.
 */
export class LiveMaintainer {
  private entries: Entry[] = []
  private readonly memberById = new Map<string, Entry>()
  private seqById = new Map<string, number>()
  private maxSeq = -1
  /** Maintained state is stale — the next `rows()` rebuilds from the snapshot. */
  private stale = true
  /** True once a subscription is driving `apply()`. */
  private attached = false

  constructor(private readonly cfg: MaintainerConfig) {}

  /**
   * Start accepting deltas. Every read before this rebuilds from the snapshot,
   * so a detached maintainer is just an eager executor.
   *
   * ⚠️ Call this in the SAME synchronous turn as a read — either immediately
   * before the first `rows()` (the `.live()` path) or immediately after the
   * initial one (the `.aggregate().live()` path, where the reduction computes
   * before it subscribes). Attaching in a turn of its own would let a mutation
   * slip past unrecorded: it arrives with no subscription to `apply()` it, and
   * the maintained state would then be trusted while already behind.
   */
  attach(): void {
    this.attached = true
  }

  /**
   * Stop accepting deltas — the subscription feeding them has gone. Every
   * later read rebuilds, because nothing is keeping the state current any
   * more. Without this, a `Reduction` whose `.live()` was stopped would keep
   * serving its last maintained value from `.run()`.
   */
  detach(): void {
    this.attached = false
  }

  /** Force the next read to rebuild — the caller saw something it can't patch. */
  invalidate(): void {
    this.stale = true
  }

  /**
   * Fold one upstream change into the maintained set. A change with no
   * payload (the source could not say which record moved) invalidates
   * instead — the next read pays for a full rebuild.
   */
  apply(change: SourceChange | undefined): void {
    if (!this.attached || this.stale) return
    if (!change) {
      this.stale = true
      return
    }
    try {
      this.patch(change)
    } catch (err) {
      // A predicate threw mid-patch: the maintained set may be half-updated,
      // so drop it rather than serve a set we can no longer vouch for. The
      // error still reaches the consumer — the rebuild on the next read runs
      // the same predicate and throws the same way.
      this.stale = true
      throw err
    }
  }

  /** The current result window — a fresh array on every call. */
  rows(): unknown[] {
    if (!this.attached || this.stale) this.rebuild()
    const { offset, limit } = this.cfg
    const end = limit === undefined ? this.entries.length : offset + limit
    const window: unknown[] = []
    for (let i = offset; i < end && i < this.entries.length; i++) {
      window.push(this.entries[i]!.record)
    }
    return this.cfg.decode ? this.cfg.decode(window) : window
  }

  /**
   * Full recompute from the source snapshot. Equivalent to the eager path by
   * construction: filter in snapshot order, then sort with snapshot sequence
   * as the tiebreak — which is what a stable sort of the same input does.
   */
  private rebuild(): void {
    const snapshot = this.cfg.snapshotEntries()
    this.entries = []
    this.memberById.clear()
    this.seqById = new Map()
    for (let i = 0; i < snapshot.length; i++) {
      const { id, record } = snapshot[i]!
      this.seqById.set(id, i)
      if (this.cfg.matches(record)) {
        const entry: Entry = { id, seq: i, record, key: this.keyOf(record) }
        this.entries.push(entry)
        this.memberById.set(id, entry)
      }
    }
    this.maxSeq = snapshot.length - 1
    this.entries.sort((a, b) => this.compareEntries(a, b))
    this.stale = false
  }

  private patch(change: SourceChange): void {
    const { id } = change
    const previous = this.memberById.get(id)
    const record = change.action === 'delete' ? undefined : this.cfg.lookupById(id)

    if (record === undefined) {
      // Gone. Its snapshot slot is released too: a later re-add of the same id
      // appends to the cache's Map, so it must earn a fresh sequence number.
      this.seqById.delete(id)
      if (previous) this.removeEntry(previous)
      return
    }

    let seq = this.seqById.get(id)
    if (seq === undefined) {
      // A key the snapshot did not carry — `Map.set` appended it, so it sorts
      // after every record we have seen.
      seq = ++this.maxSeq
      this.seqById.set(id, seq)
    }

    const matches = this.cfg.matches(record)
    if (previous) this.removeEntry(previous)
    if (!matches) return

    const entry: Entry = { id, seq, record, key: this.keyOf(record) }
    this.entries.splice(this.lowerBound(entry), 0, entry)
    this.memberById.set(id, entry)
  }

  private removeEntry(entry: Entry): void {
    // The comparator is a total order (sequence numbers are unique), so the
    // binary search lands exactly on the entry. The linear scan is a belt-and-
    // braces fallback for a source that broke the ordering assumption.
    const at = this.lowerBound(entry)
    const index = this.entries[at] === entry ? at : this.entries.indexOf(entry)
    if (index >= 0) this.entries.splice(index, 1)
    this.memberById.delete(entry.id)
  }

  /** First index whose entry does not sort before `probe`. */
  private lowerBound(probe: Entry): number {
    let lo = 0
    let hi = this.entries.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (this.compareEntries(this.entries[mid]!, probe) < 0) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  private keyOf(record: unknown): readonly unknown[] {
    return this.cfg.order ? this.cfg.order.keyOf(record) : EMPTY_KEY
  }

  /**
   * The eager path's ordering, made total.
   *
   * `order.compare` is the query's own `compareOrderKeys`, the identical
   * function `sortRecords` sorts with, so sort keys cannot be read or ranked
   * differently here. It returns 0 for equal keys — it can do nothing else,
   * having been handed the keys rather than the records — and the eager sort
   * then leaves those in the order they arrived, which is candidate order,
   * which is snapshot order given `canMaintainIncrementally` has refused every
   * plan whose candidates arrive in index order. The sequence number below is
   * that same resolution, made explicit so a binary search has an exact
   * position to find. ⚠️ If the eager path ever grows a tiebreak of its own
   * (an id, say), this stops agreeing with it — which is what
   * `__tests__/query-incremental.test.ts`'s "inherits an order key plan that
   * leaves equal keys to the tiebreak" is there to catch.
   */
  private compareEntries(a: Entry, b: Entry): number {
    if (this.cfg.order) {
      const cmp = this.cfg.order.compare(a.key, b.key)
      if (cmp !== 0) return cmp
    }
    return a.seq - b.seq
  }
}
