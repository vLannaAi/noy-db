/**
 * Persistent, encrypted secondary indexes for lazy-mode collections (v0.22).
 *
 * Parallel to the in-memory `CollectionIndexes` used by eager mode (see
 * `packages/hub/src/query/indexes.ts`): same logical surface, but entries
 * are materialised as encrypted side-car records (`_idx/<field>/<recordId>`)
 * and bulk-loaded into an in-memory mirror on first query.
 *
 * This module only owns the id-namespace convention, the in-memory mirror,
 * and the typed errors. Write-path integration (PR 2 / #266), query-planner
 * dispatch (PR 3 / #267, PR 4 / #268), and the rebuild/reconcile utilities
 * (PR 5 / #269) live in other files.
 *
 * See the v0.22 design spec for the full architecture + threat model.
 */

/**
 * Reserved id prefix for encrypted index side-car records.
 * Matches the existing `_keyring`, `_ledger_deltas/…`, `_meta/handle`
 * conventions inside a collection's id namespace.
 */
export const IDX_PREFIX = '_idx/' as const

/**
 * Encode the side-car record id for a (field, recordId) pair.
 *
 * Format: `_idx/<field>/<recordId>` — no escaping. Field names may contain
 * dots (for dotted-path access consistent with eager-mode `readPath`);
 * record ids may contain slashes. The first two slash-separated segments
 * are `_idx` and the field; everything after the *second* slash is the
 * record id verbatim.
 */
export function encodeIdxId(field: string, recordId: string): string {
  return `${IDX_PREFIX}${field}/${recordId}`
}

/**
 * Decode a side-car id back into `{ field, recordId }`, or `null` if the
 * input is not a well-formed idx id. A well-formed id is:
 *   - prefixed with `_idx/`
 *   - contains a field segment (non-empty, no slashes)
 *   - contains a record-id segment (non-empty, may contain slashes)
 */
export function decodeIdxId(id: string): { field: string; recordId: string } | null {
  if (!id.startsWith(IDX_PREFIX)) return null
  const rest = id.slice(IDX_PREFIX.length)
  const firstSlash = rest.indexOf('/')
  if (firstSlash <= 0) return null
  const field = rest.slice(0, firstSlash)
  const recordId = rest.slice(firstSlash + 1)
  if (recordId.length === 0) return null
  return { field, recordId }
}

/**
 * Fast-path predicate for discriminating side-car ids from regular record
 * ids and other reserved namespaces. Used by the hub to filter `list()`
 * results during bulk-load of the in-memory mirror.
 */
export function isIdxId(id: string): boolean {
  return decodeIdxId(id) !== null
}

/**
 * Sorted-value entry returned by `orderedBy()`. Mirrors the body shape
 * used by the write path — but `orderedBy` emits them already sorted by
 * `value` in the requested direction. Consumers (PR 4 / #268) treat the
 * array as immutable and paginate via a numeric offset.
 *
 * **Note on `value`:** this is the canonical bucket-key string
 * (`stringifyKey(originalValue)`), not the original field value. Dates
 * are rendered as ISO strings, numbers/booleans as `String(…)`. The
 * original typed value is not losslessly recoverable here — if PR 4
 * needs the original, it must re-read it from the main record.
 */
export interface OrderedEntry {
  readonly recordId: string
  readonly value: unknown
}

/**
 * Bulk-load row shape accepted by `ingest()`. The `value` field is the
 * decrypted index body's `value` field verbatim.
 */
export interface IngestRow {
  readonly recordId: string
  readonly value: unknown
}

/**
 * In-memory mirror of the persisted index side-car records for a single
 * collection. Populated by bulk-loading `_idx/<field>/*` ids on first
 * query and maintained incrementally by `Collection.put()` / `.delete()`
 * via `upsert()` / `remove()`.
 *
 * API surface is deliberately parallel to `CollectionIndexes` (eager mode)
 * so the query planner in PR 3/4 can dispatch to either polymorphically.
 *
 * Lifecycle:
 *  - `declare(field)` — accept the field as indexable (idempotent)
 *  - `ingest(field, rows[])` — bulk-load from decrypted index bodies
 *  - `upsert(recordId, field, newValue, previousValue)` — incremental update
 *  - `remove(recordId, field, value)` — incremental remove
 *  - `lookupEqual(field, value)` / `lookupIn(field, values)` — equality reads
 *  - `orderedBy(field, dir)` — sorted iteration for orderBy
 *  - `clear()` — drop all buckets (invalidation / rotation)
 */
export class PersistedCollectionIndex {
  private readonly indexes = new Map<string, Map<string, Set<string>>>()

  /**
   * Declare a field as indexable. Subsequent `upsert` / `ingest` calls for
   * this field populate the in-memory mirror; calls before `declare` are
   * no-ops (tolerant bulk-load ordering). Idempotent — re-declaring an
   * existing field does nothing.
   */
  declare(field: string): void {
    if (this.indexes.has(field)) return
    this.indexes.set(field, new Map())
  }

  /** True if `field` has been declared as indexable on this mirror. */
  has(field: string): boolean {
    return this.indexes.has(field)
  }

  /** All declared field names, in declaration order. */
  fields(): string[] {
    return [...this.indexes.keys()]
  }

  /**
   * Bulk-load the mirror from decrypted index bodies. Intended to be
   * called once per field after reading the collection's `_idx/<field>/*`
   * side-cars. Safe to call twice with the same rows — bucket Sets
   * deduplicate recordIds. If `field` is not declared, this is a no-op
   * (tolerates the case where bulk-load runs before `declare()` lands).
   */
  ingest(field: string, rows: readonly IngestRow[]): void {
    const buckets = this.indexes.get(field)
    if (!buckets) return
    for (const row of rows) {
      addToBuckets(buckets, row.recordId, row.value)
    }
  }

  /**
   * Incrementally update a record's index entry for one field. Called by
   * `Collection.put()` (PR 2) after the main write succeeds. If
   * `previousValue` is non-null, the record is removed from the old
   * bucket first — this is the update path. Pass `null` for fresh adds.
   * No-op if the field is not declared.
   */
  upsert(recordId: string, field: string, newValue: unknown, previousValue: unknown | null): void {
    const buckets = this.indexes.get(field)
    if (!buckets) return
    if (previousValue !== null && previousValue !== undefined) {
      removeFromBuckets(buckets, recordId, previousValue)
    }
    addToBuckets(buckets, recordId, newValue)
  }

  /**
   * Remove a record from the index for one field. Called by
   * `Collection.delete()` (PR 2). No-op if the field is not declared or
   * the record isn't in the bucket. Empty buckets are dropped to keep
   * the Map clean.
   */
  remove(recordId: string, field: string, value: unknown): void {
    const buckets = this.indexes.get(field)
    if (!buckets) return
    removeFromBuckets(buckets, recordId, value)
  }

  /**
   * Drop all bucket data while preserving field declarations. Called on
   * invalidation (incoming sync changes, keyring rotation) — the next
   * query re-populates via `ingest`.
   */
  clear(): void {
    for (const buckets of this.indexes.values()) {
      buckets.clear()
    }
  }

  /**
   * Equality lookup — return the set of record ids whose `field` matches
   * `value`. Returns `null` if the field is not declared (caller falls
   * back to scan or throws `IndexRequiredError`). Returns a shared empty
   * set if the field is declared but no record matches — that set MUST
   * NOT be mutated by the caller.
   */
  lookupEqual(field: string, value: unknown): ReadonlySet<string> | null {
    const buckets = this.indexes.get(field)
    if (!buckets) return null
    const key = stringifyKey(value)
    return buckets.get(key) ?? EMPTY_SET
  }

  /**
   * Set lookup — return the union of record ids whose `field` matches any
   * of `values`. Returns `null` if the field is not declared. Returns a
   * fresh (non-shared) Set — safe for the caller to mutate.
   */
  lookupIn(field: string, values: readonly unknown[]): ReadonlySet<string> | null {
    const buckets = this.indexes.get(field)
    if (!buckets) return null
    const out = new Set<string>()
    for (const value of values) {
      const bucket = buckets.get(stringifyKey(value))
      if (bucket) for (const id of bucket) out.add(id)
    }
    return out
  }

  /**
   * Sorted iteration — return every entry on `field` as an
   * `OrderedEntry[]`, sorted by value (`asc` default, `desc` reverses).
   * Returns `null` if the field is not declared. See `OrderedEntry` for
   * the caveat on `value` being the canonical bucket-key form, not the
   * original typed value. Consumers paginate with a numeric offset.
   */
  orderedBy(field: string, dir: 'asc' | 'desc'): readonly OrderedEntry[] | null {
    const buckets = this.indexes.get(field)
    if (!buckets) return null
    const entries: OrderedEntry[] = []
    for (const [key, bucket] of buckets) {
      const value = key
      for (const recordId of bucket) {
        entries.push({ recordId, value })
      }
    }
    entries.sort((a, b) => compareValues(a.value, b.value))
    if (dir === 'desc') entries.reverse()
    return entries
  }
}

const EMPTY_SET: ReadonlySet<string> = new Set()

/**
 * Canonicalize a value into a bucket key. Deliberately identical to the
 * eager-mode `stringifyKey` in `query/indexes.ts` so semantics match. When
 * `query/indexes.ts` changes its coercion rules, update this in lockstep.
 *
 * null / undefined values are NOT indexed — callers who pass them to
 * `upsert` / `remove` short-circuit before reaching this function; the
 * sentinel here exists only to make `lookupEqual(field, null)` return
 * an empty bucket (rather than matching some arbitrary record).
 */
function stringifyKey(value: unknown): string {
  if (value === null || value === undefined) return '\0NULL\0'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value instanceof Date) return value.toISOString()
  return '\0OBJECT\0'
}

function addToBuckets(buckets: Map<string, Set<string>>, recordId: string, value: unknown): void {
  if (value === null || value === undefined) return
  const key = stringifyKey(value)
  let bucket = buckets.get(key)
  if (!bucket) {
    bucket = new Set()
    buckets.set(key, bucket)
  }
  bucket.add(recordId)
}

function removeFromBuckets(buckets: Map<string, Set<string>>, recordId: string, value: unknown): void {
  if (value === null || value === undefined) return
  const key = stringifyKey(value)
  const bucket = buckets.get(key)
  if (!bucket) return
  bucket.delete(recordId)
  if (bucket.size === 0) buckets.delete(key)
}

function compareValues(a: unknown, b: unknown): number {
  // `orderedBy` keys by bucket key (string), so this compares strings.
  // That is intentional — bucket keys are the canonical representation and
  // they already encode Date/number/bool in a byte-comparable-within-type way.
  // Sorting across mixed types is undefined behavior (documented in spec §4.5).
  if (typeof a === 'string' && typeof b === 'string') {
    return a < b ? -1 : a > b ? 1 : 0
  }
  const sa = String(a)
  const sb = String(b)
  return sa < sb ? -1 : sa > sb ? 1 : 0
}
