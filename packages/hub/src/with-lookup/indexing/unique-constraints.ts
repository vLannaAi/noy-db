/**
 * In-memory unique-constraint enforcement for eager-mode collections.
 *
 * Each `UniqueConstraintSet` holds one or more constraints, each covering
 * an ordered tuple of field names. On every `put()` the caller invokes
 * `check()` BEFORE the store write; on success it calls `upsert()` to
 * update the maps. `remove()` is called on `delete()`.
 *
 * Null-distinct semantics: if ANY constrained field is `null` or
 * `undefined` in the record, that record is exempt from the constraint —
 * `keyFor` returns `null` and the record is silently skipped.
 * This matches standard SQL NULL-distinct behavior.
 *
 * Only used in eager mode (`prefetch !== false`). Lazy-mode collections
 * throw at registration instead (see Collection constructor).
 */

import { readPath } from '../query/predicate.js'
import { canonicalGroupKey } from '../aggregate/canonical-key.js'
import { UniqueConstraintError, UnsupportedIndexOptionError } from '../errors.js'
import type { IndexDef } from './eager-indexes.js'

interface Constraint {
  readonly fields: readonly string[]
  /** canonicalKey → id of the record holding that key */
  readonly map: Map<string, string>
}

export class UniqueConstraintSet {
  private readonly constraints: Constraint[]

  constructor(
    private readonly collectionName: string,
    uniqueDefs: readonly (readonly string[])[],
  ) {
    this.constraints = uniqueDefs.map(fields => ({ fields, map: new Map() }))
  }

  get size(): number {
    return this.constraints.length
  }

  /**
   * Compute the canonical key for a record under a given constraint.
   * Returns `null` if any constrained field is `null` or `undefined`
   * (the record is exempt — no constraint is checked).
   */
  private keyFor(fields: readonly string[], record: unknown): string | null {
    const row: Record<string, unknown> = {}
    for (const f of fields) {
      const v = readPath(record, f)
      if (v === null || v === undefined) return null
      row[f] = v
    }
    return canonicalGroupKey(fields, row)
  }

  /**
   * Throw `UniqueConstraintError` if writing `id` with `record` would
   * collide with a DIFFERENT existing record. Call BEFORE the store write.
   */
  check(id: string, record: unknown): void {
    for (const c of this.constraints) {
      const key = this.keyFor(c.fields, record)
      if (key === null) continue
      const holder = c.map.get(key)
      if (holder !== undefined && holder !== id) {
        throw new UniqueConstraintError(this.collectionName, id, c.fields, holder)
      }
    }
  }

  /**
   * Update the constraint maps after a successful write.
   * Pass `previous` when updating an existing record (so the old key
   * is removed first). Pass `null` or `undefined` for a fresh insert.
   */
  upsert(id: string, record: unknown, previous?: unknown): void {
    if (previous != null) this.remove(id, previous)
    for (const c of this.constraints) {
      const key = this.keyFor(c.fields, record)
      if (key !== null) c.map.set(key, id)
    }
  }

  /**
   * Remove a record from all constraint maps.
   * Called by `Collection.delete()`.
   */
  remove(id: string, record: unknown): void {
    for (const c of this.constraints) {
      const key = this.keyFor(c.fields, record)
      if (key !== null && c.map.get(key) === id) c.map.delete(key)
    }
  }

  /**
   * Rebuild all constraint maps from a full snapshot.
   * Called after hydration (ensureHydrated / hydrateFromSnapshot).
   *
   * **Last-writer-wins**: this method does NOT validate pre-existing data
   * for duplicates. If the store already contains two records sharing a
   * constrained value (written before the unique index was declared), the
   * last one processed wins the map slot and the duplicate is silently
   * displaced — no error is thrown, and the earlier holder is evicted from
   * the map. Callers retrofitting a unique index onto populated data should
   * run a one-time uniqueness scan before relying on enforcement.
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
 * Unique enforcement is **eager-mode only**. If any `unique` index is
 * declared on a lazy (`prefetch:false`), CRDT, or tiered collection, this
 * throws `UnsupportedIndexOptionError` at registration rather than letting
 * those write paths (which bypass `check()`/`upsert()`) silently skip
 * enforcement. Kept out of the Collection constructor to keep that
 * always-on kernel file lean (kernel-surface invariant).
 */
export function buildUniqueConstraintSet(
  collectionName: string,
  indexes: readonly IndexDef[] | undefined,
  mode: { readonly lazy: boolean; readonly crdt: boolean; readonly tiered: boolean },
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

  if (mode.lazy) {
    throw new UnsupportedIndexOptionError(
      'unique',
      `unique indexes are not yet supported in lazy mode (prefetch:false) — use the default eager mode. Collection "${collectionName}".`,
    )
  }
  if (mode.crdt) {
    throw new UnsupportedIndexOptionError(
      'unique',
      `unique indexes are not supported on CRDT collections (crdt mode is incompatible with eager unique enforcement). Collection "${collectionName}".`,
    )
  }
  if (mode.tiered) {
    throw new UnsupportedIndexOptionError(
      'unique',
      `unique indexes are not supported on tiered collections (tier writes use a separate path that bypasses unique enforcement). Collection "${collectionName}".`,
    )
  }
  return new UniqueConstraintSet(collectionName, uniqueDefs)
}
