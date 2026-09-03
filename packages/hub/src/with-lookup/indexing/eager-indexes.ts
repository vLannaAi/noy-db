/**
 * Secondary indexes for the query DSL.
 *
 * ships **in-memory hash indexes**:
 *   - Built during `Collection.ensureHydrated()` from the decrypted cache
 *   - Maintained incrementally on `put` and `delete`
 *   - Consulted by the query executor for `==` and `in` operators on
 *     indexed fields, falling back to a linear scan otherwise
 *   - Live entirely in memory — no adapter writes for the index itself
 *
 * Persistent encrypted index blobs (the spec's "store as a separate
 * AES-256-GCM blob" note) are deferred to a follow-up issue. The reasons
 * are documented in the PR body — short version: at the target
 * scale of 1K–50K records, building the index during hydrate is free,
 * so persistence buys nothing measurable.
 */

import { readPath } from '../../kernel/query/predicate.js'
import { SortedIndex, buildSortedIndex, type RangeOperator } from './sorted-indexes.js'

/**
 * Index declaration accepted by `Collection`'s constructor.
 *
 * Accepts:
 *   - `string` — a single-field hash index (`'clientId'`)
 *   - `{ fields: [...] }` or `readonly string[]` — a composite index
 *     over an ordered field tuple. Only lazy-mode
 *     collections consume composite declarations today; eager mode
 *     silently treats a composite as equivalent to declaring each
 *     component field as its own single-field index.
 *
 * Additive variants (unique constraints, partial indexes) will land as
 * further union members without breaking existing declarations.
 */
export type IndexDef =
  | string
  | { readonly fields: readonly string[]; readonly unique?: boolean; readonly kind?: IndexKind }
  | readonly string[]

/**
 * The access structure an index declaration asks for (#1344).
 *
 * `'hash'` (the default, and what every pre-#1344 declaration means) is
 * the equality/`in` bucket map. `'sorted'` additionally maintains an
 * ordered array over the same canonicalized keys, which lights up
 * index-driven `<`, `<=`, `>`, `>=`, `between`, `startsWith` and
 * `orderBy(field).limit(n)`. A `'sorted'` declaration keeps the hash
 * index too — `==`/`in` stay O(1).
 */
export type IndexKind = 'hash' | 'sorted'

/**
 * Normalize a declared `IndexDef[]` into a uniform `{ fields, unique? }`
 * shape: `string` → `{fields:[s]}`, `string[]` → `{fields}`, object →
 * passthrough. Pure — used by `Collection`'s sensitive-field leak check
 * and by `getDeclaredIndexes()` (introspection).
 */
export function normalizeIndexDefs(
  defs: readonly IndexDef[],
): ReadonlyArray<{ readonly fields: readonly string[]; readonly unique?: boolean }> {
  return defs.map((def) => {
    if (typeof def === 'string') return { fields: [def] }
    if (Array.isArray(def)) return { fields: def }
    return def as { readonly fields: readonly string[]; readonly unique?: boolean }
  })
}

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
   * Sorted (range) indexes, keyed by field — the #1344 half. Parallel to
   * `indexes` above and maintained at the SAME mutation sites, through the
   * SAME `canonicalize` closure, so the two can never disagree about which
   * key space a field lives in.
   */
  private readonly sorted = new Map<string, SortedIndex>()

  /**
   * Per-field bucket-key canonicalizer (#672 review C1), registered ONCE
   * via {@link setCanonicalizer} when the collection wires indexing up
   * (money-aware via `ViaPipeline.canonicalizeIndexKey`). Consulted by
   * EVERY bucket-mutation site — `build`/`upsert`/`remove` — so bucket
   * membership is symmetric by construction: a value can never be added
   * under a canonical key and later removed under the raw one (or vice
   * versa), which is what stranded ids on `put`/`delete` before this fix.
   */
  private canonicalize?: (field: string, value: unknown) => string | undefined

  /**
   * Register the bucket-key canonicalizer. Called once, where the
   * collection constructs its indexing state — safe to call again (the
   * closure is simply replaced) but there is normally only one caller.
   */
  setCanonicalizer(fn: (field: string, value: unknown) => string | undefined): void {
    this.canonicalize = fn
  }

  /**
   * Declare an index. Subsequent record additions are tracked under it.
   * Calling this twice for the same field is a no-op (idempotent).
   */
  declare(field: string): void {
    if (this.indexes.has(field)) return
    this.indexes.set(field, { field, buckets: new Map() })
  }

  /**
   * Declare a sorted (range) index on a field. Independent of
   * {@link declare} — callers that want both `==` speed and range speed
   * declare both (which is what `withIndexing()` does for a
   * `kind: 'sorted'` declaration). Idempotent.
   */
  declareSorted(field: string): void {
    if (this.sorted.has(field)) return
    this.sorted.set(field, new SortedIndex(field))
  }

  /** True if the given field has a declared SORTED index. */
  hasSorted(field: string): boolean {
    return this.sorted.has(field)
  }

  /** All sorted-index field names, in declaration order. */
  sortedFields(): string[] {
    return [...this.sorted.keys()]
  }

  /** Number of entries in a field's sorted index (0 when undeclared). */
  sortedSize(field: string): number {
    return this.sorted.get(field)?.size ?? 0
  }

  /**
   * Range lookup: ids whose `field` satisfies the operator. Returns
   * `null` when no SORTED index covers the field — the caller falls back
   * to a linear scan. An empty set means "the index covers this field and
   * nothing matches", which is authoritative.
   */
  lookupRange(field: string, op: RangeOperator, value: unknown): ReadonlySet<string> | null {
    return this.sorted.get(field)?.lookup(op, value) ?? null
  }

  /**
   * Ids of every indexed record in `field` order. `null` when no sorted
   * index covers the field. Records whose value is nullish or has no
   * order-defined type are absent — compare against {@link sortedSize}
   * before treating the result as the full collection.
   */
  orderedIds(field: string, direction: 'asc' | 'desc'): readonly string[] | null {
    return this.sorted.get(field)?.orderedIds(direction) ?? null
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
   * Called once per hydration. O(N × indexes.size). Buckets through the
   * registered {@link setCanonicalizer} closure, same as `upsert`/`remove`.
   */
  build<T>(records: ReadonlyArray<{ id: string; record: T }>): void {
    for (const idx of this.indexes.values()) {
      idx.buckets.clear()
      for (const { id, record } of records) {
        addToIndex(idx, id, record, this.canonicalize)
      }
    }
    for (const idx of this.sorted.values()) {
      buildSortedIndex(idx, records, this.canonicalize)
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
    if (this.indexes.size === 0 && this.sorted.size === 0) return
    if (previousRecord !== null) {
      this.remove(id, previousRecord)
    }
    for (const idx of this.indexes.values()) {
      addToIndex(idx, id, newRecord, this.canonicalize)
    }
    for (const idx of this.sorted.values()) {
      const value = readPath(newRecord, idx.field)
      if (value === null || value === undefined) continue
      idx.add(id, value, this.canonicalize?.(idx.field, value))
    }
  }

  /**
   * Remove a record from all indexes. Called by `Collection.delete()`
   * (and as the first half of `upsert` for the update path).
   */
  remove<T>(id: string, record: T): void {
    if (this.indexes.size === 0 && this.sorted.size === 0) return
    for (const idx of this.indexes.values()) {
      removeFromIndex(idx, id, record, this.canonicalize)
    }
    for (const idx of this.sorted.values()) {
      const value = readPath(record, idx.field)
      if (value === null || value === undefined) continue
      idx.remove(id, value, this.canonicalize?.(idx.field, value))
    }
  }

  /** Drop all index data. Called when the collection is invalidated. */
  clear(): void {
    for (const idx of this.indexes.values()) {
      idx.buckets.clear()
    }
    for (const idx of this.sorted.values()) {
      idx.clear()
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

function addToIndex<T>(
  idx: HashIndex,
  id: string,
  record: T,
  canonicalize?: (field: string, value: unknown) => string | undefined,
): void {
  const value = readPath(record, idx.field)
  if (value === null || value === undefined) return
  const key = canonicalize?.(idx.field, value) ?? stringifyKey(value)
  let bucket = idx.buckets.get(key)
  if (!bucket) {
    bucket = new Set()
    idx.buckets.set(key, bucket)
  }
  bucket.add(id)
}

function removeFromIndex<T>(
  idx: HashIndex,
  id: string,
  record: T,
  canonicalize?: (field: string, value: unknown) => string | undefined,
): void {
  const value = readPath(record, idx.field)
  if (value === null || value === undefined) return
  const key = canonicalize?.(idx.field, value) ?? stringifyKey(value)
  const bucket = idx.buckets.get(key)
  if (!bucket) return
  bucket.delete(id)
  // Clean up empty buckets so the Map doesn't accumulate dead keys.
  if (bucket.size === 0) idx.buckets.delete(key)
}
