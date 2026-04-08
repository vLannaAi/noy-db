/**
 * Secondary indexes for the query DSL.
 *
 * v0.3 ships **in-memory hash indexes**:
 *   - Built during `Collection.ensureHydrated()` from the decrypted cache
 *   - Maintained incrementally on `put` and `delete`
 *   - Consulted by the query executor for `==` and `in` operators on
 *     indexed fields, falling back to a linear scan otherwise
 *   - Live entirely in memory — no adapter writes for the index itself
 *
 * Persistent encrypted index blobs (the spec's "store as a separate
 * AES-256-GCM blob" note) are deferred to a follow-up issue. The reasons
 * are documented in the v0.3 PR body — short version: at the v0.3 target
 * scale of 1K–50K records, building the index during hydrate is free,
 * so persistence buys nothing measurable.
 */

import { readPath } from './predicate.js'

/**
 * Index declaration accepted by `Collection`'s constructor.
 *
 * Today only single-field hash indexes are supported. Future shapes
 * (composite, sorted, unique constraints) will land as additive variants
 * of this discriminated union without breaking existing declarations.
 */
export type IndexDef = string

/**
 * Internal representation of a built hash index.
 *
 * Maps stringified field values to the set of record ids whose value
 * for that field matches. Stringification keeps the index simple and
 * works uniformly for primitives (`'open'`, `'42'`, `'true'`).
 *
 * Records whose indexed field is `undefined` or `null` are NOT inserted
 * — `query().where('field', '==', undefined)` falls back to a linear
 * scan, which is the conservative behavior.
 */
export interface HashIndex {
  readonly field: string
  readonly buckets: Map<string, Set<string>>
}

/**
 * Container for all indexes on a single collection.
 *
 * Methods are pure with respect to the in-memory `buckets` Map — they
 * never touch the adapter or the keyring. The Collection class owns
 * lifecycle (build on hydrate, maintain on put/delete).
 */
export class CollectionIndexes {
  private readonly indexes = new Map<string, HashIndex>()

  /**
   * Declare an index. Subsequent record additions are tracked under it.
   * Calling this twice for the same field is a no-op (idempotent).
   */
  declare(field: string): void {
    if (this.indexes.has(field)) return
    this.indexes.set(field, { field, buckets: new Map() })
  }

  /** True if the given field has a declared index. */
  has(field: string): boolean {
    return this.indexes.has(field)
  }

  /** All declared field names, in declaration order. */
  fields(): string[] {
    return [...this.indexes.keys()]
  }

  /**
   * Build all declared indexes from a snapshot of records.
   * Called once per hydration. O(N × indexes.size).
   */
  build<T>(records: ReadonlyArray<{ id: string; record: T }>): void {
    for (const idx of this.indexes.values()) {
      idx.buckets.clear()
      for (const { id, record } of records) {
        addToIndex(idx, id, record)
      }
    }
  }

  /**
   * Insert or update a single record across all indexes.
   * Called by `Collection.put()` after the encrypted write succeeds.
   *
   * If `previousRecord` is provided, the record is removed from any old
   * buckets first — this is the update path. Pass `null` for fresh adds.
   */
  upsert<T>(id: string, newRecord: T, previousRecord: T | null): void {
    if (this.indexes.size === 0) return
    if (previousRecord !== null) {
      this.remove(id, previousRecord)
    }
    for (const idx of this.indexes.values()) {
      addToIndex(idx, id, newRecord)
    }
  }

  /**
   * Remove a record from all indexes. Called by `Collection.delete()`
   * (and as the first half of `upsert` for the update path).
   */
  remove<T>(id: string, record: T): void {
    if (this.indexes.size === 0) return
    for (const idx of this.indexes.values()) {
      removeFromIndex(idx, id, record)
    }
  }

  /** Drop all index data. Called when the collection is invalidated. */
  clear(): void {
    for (const idx of this.indexes.values()) {
      idx.buckets.clear()
    }
  }

  /**
   * Equality lookup: return the set of record ids whose `field` matches
   * the given value. Returns `null` if no index covers the field — the
   * caller should fall back to a linear scan.
   *
   * The returned Set is a reference to the index's internal storage —
   * callers must NOT mutate it.
   */
  lookupEqual(field: string, value: unknown): ReadonlySet<string> | null {
    const idx = this.indexes.get(field)
    if (!idx) return null
    const key = stringifyKey(value)
    return idx.buckets.get(key) ?? EMPTY_SET
  }

  /**
   * Set lookup: return the union of record ids whose `field` matches any
   * of the given values. Returns `null` if no index covers the field.
   */
  lookupIn(field: string, values: readonly unknown[]): ReadonlySet<string> | null {
    const idx = this.indexes.get(field)
    if (!idx) return null
    const out = new Set<string>()
    for (const value of values) {
      const key = stringifyKey(value)
      const bucket = idx.buckets.get(key)
      if (bucket) {
        for (const id of bucket) out.add(id)
      }
    }
    return out
  }
}

const EMPTY_SET: ReadonlySet<string> = new Set()

/**
 * Stringify a value into a stable bucket key.
 *
 * `null`/`undefined` produce a sentinel that records will never match
 * (so we never index nullish values — `where('x', '==', null)` falls back
 * to a linear scan). Numbers, booleans, strings, and Date objects are
 * coerced via `String()`. Objects produce a sentinel that no real record
 * will match — querying with object values is a code smell.
 */
function stringifyKey(value: unknown): string {
  if (value === null || value === undefined) return '\0NULL\0'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value instanceof Date) return value.toISOString()
  return '\0OBJECT\0'
}

function addToIndex<T>(idx: HashIndex, id: string, record: T): void {
  const value = readPath(record, idx.field)
  if (value === null || value === undefined) return
  const key = stringifyKey(value)
  let bucket = idx.buckets.get(key)
  if (!bucket) {
    bucket = new Set()
    idx.buckets.set(key, bucket)
  }
  bucket.add(id)
}

function removeFromIndex<T>(idx: HashIndex, id: string, record: T): void {
  const value = readPath(record, idx.field)
  if (value === null || value === undefined) return
  const key = stringifyKey(value)
  const bucket = idx.buckets.get(key)
  if (!bucket) return
  bucket.delete(id)
  // Clean up empty buckets so the Map doesn't accumulate dead keys.
  if (bucket.size === 0) idx.buckets.delete(key)
}
