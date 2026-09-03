/**
 * Unique-constraint enforcement.
 *
 * Each `UniqueConstraintSet` holds one or more constraints, each covering
 * an ordered tuple of field names (a one-field tuple is the ordinary
 * single-field case; a multi-field tuple is a COMPOUND unique — uniqueness
 * over the tuple, never over each component separately). On every `put()`
 * the caller invokes `check()` BEFORE the store write; on success it calls
 * `upsert()` to update the maps. `remove()` is called on `delete()`.
 *
 * Null-distinct semantics: if ANY constrained field is `null` or
 * `undefined` in the record, that record is exempt from the constraint —
 * `keyOf` returns `null` and the record is silently skipped.
 * This matches standard SQL NULL-distinct behavior.
 *
 * ## The three modes, and what each one actually promises (#1358)
 *
 * | mode | promise |
 * |---|---|
 * | eager (default) | PREVENTION, from the in-memory map built at hydration. |
 * | lazy (`prefetch:false`) | PREVENTION, from a point lookup through the persisted `_idx/` mirror — see `checkUniqueOnPut` in `collection-facade.ts`. |
 * | CRDT | **NO prevention.** DETECTION only, reported on `unique:violation`. |
 * | tiered | PREVENTION across every tier whose DEK the writer holds. A tier the writer cannot read is outside the guarantee — see `checkUniqueAcrossTiers` in `with-audit/tiers/index.ts`. |
 *
 * ⚠️ **The CRDT row is a distributed-systems fact, not a missing feature.**
 * Two replicas that are offline from each other can both accept the same
 * "unique" value, and no local check can prevent that — the other replica's
 * write does not exist anywhere this one can read. So a CRDT collection
 * never refuses a duplicate; it keeps both records (as CRDT convergence
 * requires) and reports the collision as a `UniqueConstraintError` on the
 * `unique:violation` event, both when it is created and when a later
 * session first sees the two records together. What is guaranteed is
 * uniqueness within what this writer could see at write time, plus
 * detection when the replicas meet. Do not write anything stronger than
 * that into a doc, a type, or an error message.
 *
 * None of the four modes refuses the DECLARATION any more. Compound unique
 * is supported in all of them (the key is the canonical tuple key in every
 * case), so there is no undefined corner left where a declaration is
 * accepted and quietly does nothing.
 */

import { readPath } from '../../kernel/query/predicate.js'
import { canonicalGroupKey } from '../reduce/canonical-key.js'
import { UniqueConstraintError } from '../../kernel/errors.js'
import type { IndexDef } from './eager-indexes.js'

interface Constraint {
  readonly fields: readonly string[]
  /** canonicalKey → id of the record holding that key */
  readonly map: Map<string, string>
}

/**
 * What this collection's write paths are allowed to promise.
 *
 * `'prevent'` — a colliding write throws `UniqueConstraintError` before it
 * lands (eager, lazy and tiered collections).
 * `'detect'` — a colliding write LANDS and is reported afterwards (CRDT).
 * See the module doc for why CRDT cannot be `'prevent'`.
 */
export type UniqueEnforcement = 'prevent' | 'detect'

/** How a detected-but-not-prevented collision is reported to the consumer. */
export type UniqueViolationReporter = (error: UniqueConstraintError) => void

export class UniqueConstraintSet {
  private readonly constraints: Constraint[]

  constructor(
    private readonly collectionName: string,
    uniqueDefs: readonly (readonly string[])[],
    /** See {@link UniqueEnforcement}. Defaults to prevention. */
    readonly enforcement: UniqueEnforcement = 'prevent',
    /** Fired for every collision this set observes but does NOT prevent. */
    private readonly report: UniqueViolationReporter = () => {},
  ) {
    this.constraints = uniqueDefs.map(fields => ({ fields, map: new Map() }))
  }

  get size(): number {
    return this.constraints.length
  }

  /** The declared field tuples, in declaration order. */
  fieldTuples(): readonly (readonly string[])[] {
    return this.constraints.map(c => c.fields)
  }

  /**
   * Compute the canonical key for a record under a given constraint.
   * Returns `null` if any constrained field is `null` or `undefined`
   * (the record is exempt — no constraint is checked).
   *
   * Public because the tier scan (`with-audit/tiers/index.ts`) has to compute
   * the same key for a record it decrypted under a tier DEK, which this class
   * cannot reach — one key function, so the two paths cannot drift.
   */
  keyOf(fields: readonly string[], record: unknown): string | null {
    const row: Record<string, unknown> = {}
    for (const f of fields) {
      const v = readPath(record, f)
      if (v === null || v === undefined) return null
      row[f] = v
    }
    return canonicalGroupKey(fields, row)
  }

  /**
   * Every constraint key `record` would occupy — the probe a checker outside
   * this class (tiers, lazy) compares against its own candidates. Exempt
   * (null-distinct) constraints are omitted, so an empty result means "this
   * record is unconstrained" and the caller can skip its scan entirely.
   */
  probe(record: unknown): ReadonlyArray<{ readonly fields: readonly string[]; readonly key: string }> {
    const out: Array<{ fields: readonly string[]; key: string }> = []
    for (const c of this.constraints) {
      const key = this.keyOf(c.fields, record)
      if (key !== null) out.push({ fields: c.fields, key })
    }
    return out
  }

  /**
   * Throw `UniqueConstraintError` if writing `id` with `record` would
   * collide with a DIFFERENT existing record. Call BEFORE the store write.
   *
   * In `'detect'` mode this is a deliberate NO-OP: a CRDT collection must
   * not refuse a write it has no authority to refuse (module doc). The
   * collision is reported from {@link upsert} / {@link build} instead.
   */
  check(id: string, record: unknown): void {
    if (this.enforcement === 'detect') return
    const clash = this.collision(id, record)
    if (clash) throw clash
  }

  /**
   * The `UniqueConstraintError` a write of `id`/`record` would produce, or
   * `null`. Never throws — the shared core of {@link check} (which throws it)
   * and the detect path (which reports it).
   */
  collision(id: string, record: unknown): UniqueConstraintError | null {
    for (const c of this.constraints) {
      const key = this.keyOf(c.fields, record)
      if (key === null) continue
      const holder = c.map.get(key)
      if (holder !== undefined && holder !== id) {
        return new UniqueConstraintError(this.collectionName, id, c.fields, holder)
      }
    }
    return null
  }

  /**
   * Update the constraint maps after a successful write.
   * Pass `previous` when updating an existing record (so the old key
   * is removed first). Pass `null` or `undefined` for a fresh insert.
   *
   * In `'detect'` mode a collision observed here is REPORTED and the write
   * still stands (both records are kept — see the module doc). In
   * `'prevent'` mode `check()` already ran, so there is nothing to report.
   */
  upsert(id: string, record: unknown, previous?: unknown): void {
    if (previous != null) this.remove(id, previous)
    if (this.enforcement === 'detect') {
      const clash = this.collision(id, record)
      if (clash) this.report(clash)
    }
    for (const c of this.constraints) {
      const key = this.keyOf(c.fields, record)
      if (key !== null) c.map.set(key, id)
    }
  }

  /**
   * Remove a record from all constraint maps.
   * Called by `Collection.delete()`.
   */
  remove(id: string, record: unknown): void {
    for (const c of this.constraints) {
      const key = this.keyOf(c.fields, record)
      if (key !== null && c.map.get(key) === id) c.map.delete(key)
    }
  }

  /**
   * Rebuild all constraint maps from a full snapshot.
   * Called after hydration (ensureHydrated / hydrateFromSnapshot).
   *
   * **In `'prevent'` mode this is last-writer-wins**: it does NOT validate
   * pre-existing data for duplicates. If the store already contains two
   * records sharing a constrained value (written before the unique index was
   * declared), the last one processed wins the map slot and the duplicate is
   * silently displaced — no error is thrown, and the earlier holder is
   * evicted from the map. Callers retrofitting a unique index onto populated
   * data should run a one-time uniqueness scan before relying on enforcement.
   *
   * **In `'detect'` mode this is the MERGE POINT** — the moment a session
   * that wrote neither record first sees them together (a CRDT replica
   * opening a store its peer has written to). Every displaced holder is
   * reported on `unique:violation` instead of being dropped in silence.
   */
  build(entries: Iterable<readonly [string, unknown]>): void {
    for (const c of this.constraints) c.map.clear()
    for (const [id, record] of entries) {
      this.upsert(id, record)
    }
  }
}

/**
 * Build the `UniqueConstraintSet` for a collection from its `IndexDef[]`,
 * or return `null` when no `unique: true` index is declared.
 *
 * `mode` selects the enforcement the collection's write paths can actually
 * deliver (see the module doc's table). Nothing is refused here any more:
 * before #1358 lazy, CRDT and tiered collections threw
 * `UnsupportedIndexOptionError` at registration because their write paths
 * bypassed `check()`/`upsert()`. Lazy and tiered now have real enforcement
 * wired to those paths, and CRDT has honest detection.
 *
 * Kept out of the Collection constructor to keep that always-on kernel file
 * lean (kernel-surface invariant).
 */
export function buildUniqueConstraintSet(
  collectionName: string,
  indexes: readonly IndexDef[] | undefined,
  mode: { readonly lazy: boolean; readonly crdt: boolean; readonly tiered: boolean },
  report?: UniqueViolationReporter,
): UniqueConstraintSet | null {
  const uniqueDefs: (readonly string[])[] = []
  for (const def of indexes ?? []) {
    if (
      def !== null &&
      typeof def === 'object' &&
      !Array.isArray(def) &&
      (def as { unique?: boolean }).unique === true
    ) {
      uniqueDefs.push((def as { fields: readonly string[] }).fields)
    }
  }
  if (uniqueDefs.length === 0) return null

  // `mode.lazy` and `mode.tiered` still prevent — their checks live on the
  // write paths that own them (collection-facade / tiers). Only CRDT changes
  // what the set itself may promise.
  return new UniqueConstraintSet(collectionName, uniqueDefs, mode.crdt ? 'detect' : 'prevent', report)
}
