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
import { stringifyBucketKey } from '../../kernel/query/distinct-key.js'
import { SortedIndex, buildSortedIndex, type RangeOperator } from './sorted-indexes.js'
import {
  CompoundIndex,
  buildCompoundIndex,
  compoundKey,
  probeKeysOf,
  tupleKeyOf,
  type CompoundRangeProbe,
} from './compound-indexes.js'
import {
  compoundIndexKey,
  sortedIndexKey,
  type FieldIndexSnapshot,
} from './index-snapshot.js'

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
  | {
      readonly fields: readonly string[]
      readonly unique?: boolean
      readonly kind?: IndexKind
      /**
       * Persist this index as an encrypted sidecar so a restart reuses it
       * instead of rebuilding (#1359). Only meaningful with `kind: 'sorted'`
       * — the hash index is not persisted. OPT-IN until measured: at the
       * 1K–50K target scale rebuild-on-open is free, and a sidecar is a
       * write on every debounce window plus a blob at rest.
       */
      readonly persist?: boolean
    }
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
   * Compound (tuple-keyed) sorted indexes, keyed by the joined field
   * tuple — the #1345 half. Third parallel map, maintained at the SAME
   * mutation sites through the SAME `canonicalize` closure as the other
   * two, so no field can end up in disagreeing key spaces.
   */
  private readonly compound = new Map<string, CompoundIndex>()

  /**
   * The indexes declared `persist: true` (#1359), keyed by their SIDECAR key
   * (`s:<field>` / `c:<f1>,<f2>`). A separate map rather than a flag on the
   * index classes: persistence is a property of the DECLARATION, and the
   * index classes stay unaware of storage.
   */
  private readonly persistable = new Map<string, SortedIndex | CompoundIndex>()

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
  declareSorted(field: string, opts?: { readonly persist?: boolean }): void {
    let idx = this.sorted.get(field)
    if (!idx) {
      idx = new SortedIndex(field)
      this.sorted.set(field, idx)
    }
    if (opts?.persist) this.persistable.set(sortedIndexKey(field), idx)
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

  /**
   * Declare a compound (multi-field) sorted index over an ordered field
   * tuple. A tuple shorter than two fields is a single-field sorted index
   * and is ignored here. Idempotent.
   */
  declareCompound(fields: readonly string[], opts?: { readonly persist?: boolean }): void {
    if (fields.length < 2) return
    const key = compoundKey(fields)
    let idx = this.compound.get(key)
    if (!idx) {
      idx = new CompoundIndex([...fields])
      this.compound.set(key, idx)
    }
    if (opts?.persist) this.persistable.set(compoundIndexKey(fields), idx)
  }

  /** Every declared field tuple, in declaration order. */
  compoundTuples(): ReadonlyArray<readonly string[]> {
    return [...this.compound.values()].map(idx => idx.fields)
  }

  /**
   * Number of records the tuple's index holds (0 when undeclared). A
   * record with a nullish or non-orderable component is absent, so a
   * caller that removes clauses from the plan MUST compare this against
   * the snapshot size before trusting the result.
   */
  compoundSize(fields: readonly string[]): number {
    return this.compound.get(compoundKey(fields))?.size ?? 0
  }

  /**
   * Compound lookup: ids whose leading components equal `prefixValues`,
   * optionally narrowed by a range on the component just past them.
   * `null` when no compound index covers the tuple, or when an operand
   * has no order-defined type — the caller falls back to a linear scan.
   */
  lookupCompound(
    fields: readonly string[],
    prefixValues: readonly unknown[],
    range?: CompoundRangeProbe,
  ): ReadonlySet<string> | null {
    const idx = this.compound.get(compoundKey(fields))
    if (!idx) return null
    const prefix = probeKeysOf(prefixValues)
    if (!prefix) return null
    return idx.lookup(prefix, range)
  }

  /**
   * Ids matching an equality prefix, ordered by the remaining components.
   * `null` when no compound index covers the tuple or an operand has no
   * order-defined type. See {@link compoundSize} for the coverage caveat.
   */
  compoundOrderedIds(
    fields: readonly string[],
    prefixValues: readonly unknown[],
    direction: 'asc' | 'desc',
  ): readonly string[] | null {
    const idx = this.compound.get(compoundKey(fields))
    if (!idx) return null
    const prefix = probeKeysOf(prefixValues)
    if (!prefix) return null
    return idx.orderedIds(prefix, direction)
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
  build<T>(records: ReadonlyArray<{ id: string; record: T }>, skip: ReadonlySet<string> = EMPTY_KEYS): void {
    for (const idx of this.indexes.values()) {
      idx.buckets.clear()
      for (const { id, record } of records) {
        addToIndex(idx, id, record, this.canonicalize)
      }
    }
    // `skip` names the sidecar keys a persisted snapshot already restored
    // (#1359) — rebuilding them would throw that work away AND renumber every
    // `seq`, which is what the whole ordered fast path rests on.
    for (const [field, idx] of this.sorted) {
      if (skip.has(sortedIndexKey(field))) continue
      buildSortedIndex(idx, records, this.canonicalize)
    }
    for (const idx of this.compound.values()) {
      if (skip.has(compoundIndexKey(idx.fields))) continue
      buildCompoundIndex(idx, records, this.canonicalize)
    }
  }

  /** Sidecar keys of every index declared `persist: true`, in declaration order. */
  persistableKeys(): readonly string[] {
    return [...this.persistable.keys()]
  }

  /** The persistable snapshot behind one sidecar key, or `undefined` if it is not declared. */
  snapshotIndex(key: string): FieldIndexSnapshot | undefined {
    return this.persistable.get(key)?.toSnapshot()
  }

  /**
   * Adopt a validated snapshot into the index behind `key`. `false` means the
   * caller must rebuild that index from the cache — the index is left
   * untouched, never half-loaded.
   */
  restoreIndex(key: string, snap: FieldIndexSnapshot, isLive: (id: string) => boolean): boolean {
    return this.persistable.get(key)?.loadSnapshot(snap, isLive) ?? false
  }

  /**
   * Insert or update a single record across all indexes.
   * Called by `Collection.put()` after the encrypted write succeeds.
   *
   * If `previousRecord` is provided, the record is removed from any old
   * buckets first — this is the update path. Pass `null` for fresh adds.
   */
  upsert<T>(id: string, newRecord: T, previousRecord: T | null): void {
    if (this.indexes.size === 0 && this.sorted.size === 0 && this.compound.size === 0) return
    // Detach the compound and sorted entries FIRST, holding the rank each one had. An
    // in-place `put` does not move a record within `snapshot()`, so it must
    // not move it within a tie run either — otherwise an index-served
    // `orderBy(...).limit(n)` page disagrees with the stable scan-and-sort
    // it is required to reproduce exactly (#1345, #1369). The `this.remove()`
    // below re-runs both removals, which are then no-ops.
    const ranks = new Map<string, number | undefined>()
    const sortedRanks = new Map<string, number | undefined>()
    if (previousRecord !== null) {
      for (const [key, idx] of this.compound) {
        ranks.set(key, idx.remove(id, tupleKeyOf(idx.fields, previousRecord, this.canonicalize)))
      }
      // Same for the single-field sorted indexes (#1369) — the defect and the
      // remedy are identical, and the two implementations must agree.
      for (const [key, idx] of this.sorted) {
        const value = readPath(previousRecord, idx.field)
        if (value === null || value === undefined) continue
        sortedRanks.set(key, idx.remove(id, value, this.canonicalize?.(idx.field, value)))
      }
      this.remove(id, previousRecord)
    }
    for (const idx of this.indexes.values()) {
      addToIndex(idx, id, newRecord, this.canonicalize)
    }
    for (const [key, idx] of this.sorted) {
      const value = readPath(newRecord, idx.field)
      if (value === null || value === undefined) continue
      idx.add(id, value, this.canonicalize?.(idx.field, value), sortedRanks.get(key))
    }
    for (const [key, idx] of this.compound) {
      idx.add(id, tupleKeyOf(idx.fields, newRecord, this.canonicalize), ranks.get(key))
    }
  }

  /**
   * Remove a record from all indexes. Called by `Collection.delete()`
   * (and as the first half of `upsert` for the update path).
   */
  remove<T>(id: string, record: T): void {
    if (this.indexes.size === 0 && this.sorted.size === 0 && this.compound.size === 0) return
    for (const idx of this.indexes.values()) {
      removeFromIndex(idx, id, record, this.canonicalize)
    }
    for (const idx of this.sorted.values()) {
      const value = readPath(record, idx.field)
      if (value === null || value === undefined) continue
      idx.remove(id, value, this.canonicalize?.(idx.field, value))
    }
    for (const idx of this.compound.values()) {
      idx.remove(id, tupleKeyOf(idx.fields, record, this.canonicalize))
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
    for (const idx of this.compound.values()) {
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

  /**
   * One record id per NON-EMPTY bucket of `field`'s hash index, in bucket
   * order — the index-backed spine of `Query.distinct()` (#1347). `null` when
   * no hash index covers the field, so the caller scans instead.
   *
   * The bucket set IS the distinct key set, so this costs O(buckets) rather
   * than O(records). It returns REPRESENTATIVE IDS rather than the keys
   * themselves on purpose: a bucket key is a canonical string (money's
   * BigInt-normalized scaled int, say), and `distinct()` owes its caller the
   * field's real value, which only the record carries.
   *
   * Bucket insertion order is first-seen record order — `build()` walks the
   * snapshot in order and `upsert()` appends — which is why an index-backed
   * `distinct()` and a scanned one agree on ORDER too, not merely on the set.
   * Empty buckets are skipped defensively; `removeFromIndex` already deletes
   * them, so this is belt-and-braces against a future partial removal path.
   */
  bucketRepresentatives(field: string): readonly string[] | null {
    const idx = this.indexes.get(field)
    if (!idx) return null
    const out: string[] = []
    for (const bucket of idx.buckets.values()) {
      for (const id of bucket) {
        out.push(id)
        break
      }
    }
    return out
  }
}

const EMPTY_SET: ReadonlySet<string> = new Set()
const EMPTY_KEYS: ReadonlySet<string> = new Set()

/**
 * Stringify a value into a stable bucket key.
 *
 * ⚠️ The DEFINITION moved to `kernel/query/distinct-key.ts` (#1347) and is
 * only aliased here. `distinct()` / `countDistinct()` recompute this key on
 * the scan path, and an index-backed `distinct()` reads the buckets it made —
 * one definition is what stops those two answers from drifting apart. Change
 * the shared function, not a copy.
 */
const stringifyKey = stringifyBucketKey

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
