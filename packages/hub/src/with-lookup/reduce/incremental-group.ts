/**
 * Per-group incremental maintenance for `groupBy().aggregate().live()` —
 * #1341's second half.
 *
 * #1341 shipped delta maintenance for `live()` and for the UNGROUPED
 * `.aggregate().live()`: the match set is patched per change event instead of
 * re-scanned. A grouped live query got none of it — every change re-ran the
 * whole pipeline: scan N records, re-evaluate every clause, re-bucket the
 * whole match set, and re-fold every bucket. This module closes that.
 *
 * ## What is maintained, and what is not
 *
 * Two layers, and only the outer one is new:
 *
 *   1. **The match set** is maintained by `LiveMaintainer` (the #1341 engine),
 *      unchanged and un-forked. Membership and snapshot sequence are ITS
 *      answers, delegated exactly as the ungrouped path delegates them.
 *   2. **The buckets** are maintained here. A change reaches this layer as a
 *      `PatchOutcome` — a record left the set, joined it, or both — and only
 *      the one or two buckets it touches are marked dirty. A dirty bucket is
 *      re-folded from its own records on the next read; every other bucket
 *      serves the row it already computed.
 *
 * ⛔ **Reducer states are NOT patched, deliberately** — the same call the
 * ungrouped path made. The reducer protocol carries an optional `remove()`,
 * and inverting `sum`/`count`/`avg` per delta would make a change O(1) instead
 * of O(bucket). It is not wired, because *inverting a float `sum` does not
 * reproduce a re-run's answer*: `(a + b + c) - b !== a + c` in IEEE-754, so an
 * inverted state would drift from the eager one and the equivalence property
 * this module is built on would be false. `min`/`max` are not invertible at
 * all. Re-folding a dirty bucket from its records is bit-identical to a
 * re-run by construction, and still turns O(matches) per change into
 * O(largest touched bucket).
 *
 * ## The correctness contract
 *
 * `rows()` must equal `groupAndReduce(<the eager record set>, fields, spec)`
 * at every step. Four things buy that, and three of them are group membership
 * transitions a naive per-group patch gets wrong:
 *
 *   - **Bucket CONTENTS.** A record's group key is read from the record, so a
 *     write that CHANGES the key arrives here as `removed` + `inserted` with
 *     the BEFORE record on one side and the AFTER record on the other. It
 *     leaves the old bucket and joins the new one. Reading the key off the
 *     after-state alone — the obvious shortcut — would leave a ghost row in
 *     the old bucket forever.
 *   - **Bucket DISAPPEARANCE.** A bucket that loses its last member is
 *     deleted, not left empty: `groupAndReduce` never creates a bucket with no
 *     records, so an empty bucket would emit a row that a re-run does not.
 *   - **Bucket APPEARANCE, in the right PLACE.** Buckets are emitted in
 *     first-seen order, which is the order of each bucket's MINIMUM snapshot
 *     sequence — not the order buckets happened to be created in. Those differ
 *     the moment a group key changes: with records at seq 0 (group A) and
 *     seq 1 (group B), rewriting seq 0's key to C makes a re-run emit
 *     `[C, B]`, while appending the new bucket would emit `[B, C]`. So each
 *     bucket keeps its members ordered by sequence and the emission order is
 *     recomputed from `members[0].seq` whenever a membership change could have
 *     moved a minimum.
 *   - **The key VALUES on the row** come from the bucket's first-seen record,
 *     which is `members[0]` — re-read whenever the bucket changes, because the
 *     first-seen record itself can leave.
 *
 * ## The fallback
 *
 * Anything not provably patchable rebuilds: a payload-less change event, a
 * plan `canMaintainIncrementally()` refuses (the maintainer is then never
 * built at all), a `LiveMaintainer` that rebuilt underneath us, an error
 * thrown mid-patch, or an internal inconsistency this module refuses to paper
 * over. `stats()` counts both paths so a test can assert WHICH one ran —
 * without that, a fallback that silently swallowed every case would pass every
 * behavioural test while delivering nothing.
 */

import type {
  GroupMaintenanceSource,
  MaintainedEntry,
  PatchDelta,
  PatchOutcome,
  SourceChange,
} from '../../kernel/query/incremental.js'
import { LiveMaintainer } from '../../kernel/query/incremental.js'
import { readPath } from '../../kernel/query/predicate.js'
import { canonicalGroupKey } from './canonical-key.js'
import { GroupCardinalityError } from '../../kernel/errors.js'
import type { ReduceSpec } from './reduction.js'
import {
  GROUPBY_MAX_CARDINALITY,
  GROUPBY_WARN_CARDINALITY,
  groupFieldLabel,
  reduceGroupRow,
  warnCardinalityApproaching,
} from './group-core.js'

/** Counters exposed by {@link GroupedMaintainer.stats}. */
export interface GroupMaintenanceStats {
  /** Change events folded in as a patch. */
  readonly patches: number
  /** Full rebuilds of the bucket map — the fallback path. */
  readonly rebuilds: number
  /** Buckets re-folded. One per dirty bucket per read, plus one per bucket per rebuild. */
  readonly bucketsReduced: number
  /** Records stepped through a reducer. The work a full re-run would do every time. */
  readonly recordsFolded: number
}

interface Member {
  readonly seq: number
  readonly record: unknown
}

interface Bucket {
  /** Members in ascending snapshot-sequence order — the order a re-run folds them in. */
  members: Member[]
  /** Last computed output row; meaningless while `dirty`. */
  row: unknown
  dirty: boolean
}

/** Everything the grouped maintainer needs, supplied by `GroupedReduction`. */
export interface GroupedMaintainerConfig {
  readonly source: GroupMaintenanceSource
  readonly fields: readonly string[]
  readonly spec: ReduceSpec
}

/**
 * The maintained bucket map behind one grouped live reduction.
 *
 * Lifecycle mirrors `LiveMaintainer`: `attach()` when the subscription opens,
 * `apply(change)` per upstream event, `rows()` to read, `detach()` on
 * teardown. Before `attach()` (and after any fallback) `rows()` rebuilds from
 * the snapshot, so a detached maintainer is simply an eager executor.
 */
export class GroupedMaintainer {
  private readonly inner: LiveMaintainer
  private readonly fields: readonly string[]
  private readonly spec: ReduceSpec
  private readonly reducerKeys: readonly string[]
  private readonly fieldLabel: string
  private readonly project: (record: unknown) => unknown

  private buckets = new Map<string, Bucket>()
  /** Dedup keys in emission (first-seen) order. Recomputed when `orderDirty`. */
  private order: string[] = []
  private orderDirty = true
  private stale = true
  private attached = false

  private patches = 0
  private rebuilds = 0
  private bucketsReduced = 0
  private recordsFolded = 0

  constructor(cfg: GroupedMaintainerConfig) {
    this.fields = cfg.fields
    this.spec = cfg.spec
    this.reducerKeys = Object.keys(cfg.spec)
    this.fieldLabel = groupFieldLabel(cfg.fields)
    const project = cfg.source.project
    this.project = project ? (record: unknown) => project(record) : (record: unknown) => record
    this.inner = new LiveMaintainer({
      snapshotEntries: cfg.source.snapshotEntries,
      lookupById: cfg.source.lookupById,
      matches: cfg.source.matches,
      // Grouping reduces the whole match set in candidate order — it never
      // sorts, offsets, limits or decodes. Same switches the ungrouped
      // `.aggregate()` maintainer runs with.
      offset: 0,
      limit: undefined,
    })
  }

  /**
   * Start accepting deltas. Call in the SAME synchronous turn as the initial
   * read — `LiveReduction` computes its first value in its constructor and
   * subscribes immediately after, so attaching there is that turn.
   */
  attach(): void {
    this.attached = true
    this.inner.attach()
  }

  /** Stop accepting deltas; every later read rebuilds. */
  detach(): void {
    this.attached = false
    this.inner.detach()
  }

  /** Force the next read to rebuild. */
  invalidate(): void {
    this.stale = true
    this.inner.invalidate()
  }

  /** Patch/rebuild counters — the observable difference between the two paths. */
  stats(): GroupMaintenanceStats {
    return {
      patches: this.patches,
      rebuilds: this.rebuilds,
      bucketsReduced: this.bucketsReduced,
      recordsFolded: this.recordsFolded,
    }
  }

  /**
   * Fold one upstream change into the maintained buckets.
   *
   * The match-set layer runs first and unconditionally — even when THIS layer
   * is stale, keeping the inner maintainer current is what makes the rebuild
   * below cost O(matches) instead of O(collection).
   */
  apply(change: SourceChange | undefined): void {
    let outcome: PatchOutcome
    try {
      outcome = this.inner.apply(change)
    } catch (err) {
      this.stale = true
      throw err
    }
    if (!this.attached || this.stale) return
    if (outcome.kind === 'rebuilt') {
      this.stale = true
      return
    }
    try {
      if (outcome.removed) this.leave(outcome.removed)
      if (outcome.inserted) this.join(outcome.inserted)
      this.patches++
    } catch (err) {
      // A reducer or key read threw mid-patch: the bucket map may be
      // half-updated, so drop it rather than serve rows we cannot vouch for.
      // The rebuild on the next read runs the same code and throws the same
      // way, which is where the consumer sees it.
      this.stale = true
      throw err
    }
  }

  /** The current grouped rows — a fresh array on every call. */
  rows(): unknown[] {
    if (!this.attached || this.stale) this.rebuild()
    if (this.buckets.size >= GROUPBY_WARN_CARDINALITY) {
      warnCardinalityApproaching(this.fields, this.buckets.size)
    }
    if (this.orderDirty) {
      // First-seen order === ascending minimum sequence. Sequence numbers are
      // unique, so this is a total order and the sort is deterministic.
      this.order = [...this.buckets.keys()].sort(
        (a, b) => this.buckets.get(a)!.members[0]!.seq - this.buckets.get(b)!.members[0]!.seq,
      )
      this.orderDirty = false
    }
    const out: unknown[] = []
    for (const key of this.order) {
      const bucket = this.buckets.get(key)!
      if (bucket.dirty) {
        bucket.row = this.reduce(bucket)
        bucket.dirty = false
      }
      out.push(bucket.row)
    }
    return out
  }

  /**
   * Rebuild every bucket from the maintained match set. Equivalent to the
   * eager path by construction: the inner maintainer hands back exactly the
   * records `executeRecords()` would produce, in exactly that order, and
   * `join()` below is the same bucketing loop `groupAndReduce` runs.
   */
  private rebuild(): void {
    this.rebuilds++
    this.buckets = new Map()
    const entries: readonly MaintainedEntry[] = this.inner.maintainedEntries()
    for (const entry of entries) this.join({ seq: entry.seq, record: entry.record })
    this.orderDirty = true
    this.stale = false
  }

  /** A record left the match set, or left one group on its way to another. */
  private leave(delta: PatchDelta): void {
    const record = this.project(delta.record)
    const key = this.dedupKey(record)
    const bucket = this.buckets.get(key)
    if (!bucket) {
      // The record we were told left is not in the bucket we compute for it.
      // Something upstream disagrees with us; refuse to guess.
      this.stale = true
      return
    }
    const at = lowerBoundBySeq(bucket.members, delta.seq)
    if (bucket.members[at]?.seq !== delta.seq) {
      this.stale = true
      return
    }
    bucket.members.splice(at, 1)
    if (bucket.members.length === 0) {
      // A group that loses its last row DISAPPEARS. An empty bucket left in
      // place would emit a row `groupAndReduce` never produces.
      this.buckets.delete(key)
      this.orderDirty = true
      return
    }
    // Losing the first-seen member moves the bucket's minimum sequence, which
    // is what decides where it is emitted — and the key values on its row.
    if (at === 0) this.orderDirty = true
    bucket.dirty = true
  }

  /** A record joined the match set, or joined a new group. */
  private join(delta: PatchDelta): void {
    const record = this.project(delta.record)
    const key = this.dedupKey(record)
    let bucket = this.buckets.get(key)
    if (bucket === undefined) {
      if (this.buckets.size >= GROUPBY_MAX_CARDINALITY) {
        throw new GroupCardinalityError(
          this.fieldLabel,
          this.buckets.size + 1,
          GROUPBY_MAX_CARDINALITY,
        )
      }
      // A group that gains its first row APPEARS — but not necessarily last;
      // `orderDirty` sends `rows()` back to minimum-sequence order.
      bucket = { members: [], row: undefined, dirty: true }
      this.buckets.set(key, bucket)
      this.orderDirty = true
    }
    const at = lowerBoundBySeq(bucket.members, delta.seq)
    bucket.members.splice(at, 0, { seq: delta.seq, record })
    if (at === 0) this.orderDirty = true
    bucket.dirty = true
  }

  private reduce(bucket: Bucket): unknown {
    const first = bucket.members[0]!.record
    const keyValues: Record<string, unknown> = {}
    for (const f of this.fields) keyValues[f] = readPath(first, f)
    this.bucketsReduced++
    this.recordsFolded += bucket.members.length
    return reduceGroupRow(
      this.fields,
      keyValues,
      bucket.members.map(m => m.record),
      this.spec,
      this.reducerKeys,
    )
  }

  private dedupKey(record: unknown): string {
    const keyValues: Record<string, unknown> = {}
    for (const f of this.fields) keyValues[f] = readPath(record, f)
    return canonicalGroupKey(this.fields, keyValues)
  }
}

/** First index in `members` whose sequence is not below `seq`. */
function lowerBoundBySeq(members: readonly Member[], seq: number): number {
  let lo = 0
  let hi = members.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (members[mid]!.seq < seq) lo = mid + 1
    else hi = mid
  }
  return lo
}
