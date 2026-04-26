/**
 * Persistent, encrypted secondary indexes for lazy-mode collections.
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
 * See the design spec for the full architecture + threat model.
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
 * **Note on `value`:** as of, this is the ORIGINAL TYPED
 * value (number, Date, boolean, etc.), not the stringified bucket key.
 * That's what lets range predicates and `orderedBy` compare numerically
 * instead of stumbling into `'10' < '2'` on `String(n)`.
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
/**
 * Per-field storage: the equality bucket map AND a parallel table of typed
 * values keyed by recordId. The typed table exists so range predicates
 * and `orderedBy` can compare on the original typed value rather
 * than the stringified bucket key — String(10) < String(2) is the classic
 * landmine `stringifyKey` introduces for numeric fields.
 */
interface PersistedFieldState {
  readonly buckets: Map<string, Set<string>>
  readonly values: Map<string, unknown>
}

/**
 * Structured index definition. Single-field indexes carry just a field
 * name; composite indexes carry the ordered list of fields and
 * the synthetic `key` (= fields joined by `COMPOSITE_DELIMITER`) used
 * as the bucket-map key and side-car envelope id segment.
 */
export type PersistedIndexDef =
  | { readonly kind: 'single'; readonly field: string; readonly key: string }
  | { readonly kind: 'composite'; readonly fields: readonly string[]; readonly key: string }

/**
 * Delimiter used to synthesize a composite-index key from an ordered
 * field list. Intentionally a character that is extremely unusual in
 * JavaScript object keys (`|`) so collision with a literal field name
 * is vanishingly rare in practice. Composite declarations whose field
 * names contain `|` are rejected at declare-time with an explicit
 * error.
 */
export const COMPOSITE_DELIMITER = '|'

export function compositeKey(fields: readonly string[]): string {
  return fields.join(COMPOSITE_DELIMITER)
}

export class PersistedCollectionIndex {
  private readonly indexes = new Map<string, PersistedFieldState>()
  private readonly defs = new Map<string, PersistedIndexDef>()

  /**
   * Declare a single-field index. Subsequent `upsert` / `ingest` calls
   * populate the in-memory mirror; calls before `declare` are no-ops
   * (tolerant bulk-load ordering). Idempotent.
   */
  declare(field: string): void {
    if (this.indexes.has(field)) return
    this.indexes.set(field, { buckets: new Map(), values: new Map() })
    this.defs.set(field, { kind: 'single', field, key: field })
  }

  /**
   * Declare a composite (multi-field) index. The synthetic
   * key is `fields.join('|')`; it doubles as the in-memory map key and
   * the `_idx/<key>/<recordId>` side-car field segment. Callers upsert
   * and lookup via the same `key` as single-field indexes, just with a
   * tuple value (JSON-stringified for bucketing).
   */
  declareComposite(fields: readonly string[]): void {
    if (fields.length === 0) {
      throw new Error('declareComposite: fields array must be non-empty')
    }
    for (const f of fields) {
      if (f.includes(COMPOSITE_DELIMITER)) {
        throw new Error(
          `declareComposite: field "${f}" contains the composite delimiter ` +
          `"${COMPOSITE_DELIMITER}" — pick a different field name or open an ` +
          `issue to add hash-based composite keys.`,
        )
      }
    }
    const key = compositeKey(fields)
    if (this.indexes.has(key)) return
    this.indexes.set(key, { buckets: new Map(), values: new Map() })
    this.defs.set(key, { kind: 'composite', fields: [...fields], key })
  }

  /**
   * Every declared index's structured definition. Collection walks this
   * when materialising side-cars on put/delete so it can extract a
   * single-field value or a composite tuple appropriately.
   */
  definitions(): PersistedIndexDef[] {
    return [...this.defs.values()]
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
    const state = this.indexes.get(field)
    if (!state) return
    for (const row of rows) {
      addToState(state, row.recordId, row.value)
    }
  }

  /**
   * Incrementally update a record's index entry for one field. Called by
   * `Collection.put()` after the main write succeeds. If
   * `previousValue` is non-null, the record is removed from the old
   * bucket first — this is the update path. Pass `null` for fresh adds.
   * No-op if the field is not declared.
   */
  upsert(recordId: string, field: string, newValue: unknown, previousValue: unknown): void {
    const state = this.indexes.get(field)
    if (!state) return
    if (previousValue !== null && previousValue !== undefined) {
      removeFromState(state, recordId, previousValue)
    }
    addToState(state, recordId, newValue)
  }

  /**
   * Remove a record from the index for one field. Called by
   * `Collection.delete()`. No-op if the field is not declared or
   * the record isn't in the bucket. Empty buckets are dropped to keep
   * the Map clean.
   */
  remove(recordId: string, field: string, value: unknown): void {
    const state = this.indexes.get(field)
    if (!state) return
    removeFromState(state, recordId, value)
  }

  /**
   * Drop all bucket data while preserving field declarations. Called on
   * invalidation (incoming sync changes, keyring rotation) — the next
   * query re-populates via `ingest`.
   */
  clear(): void {
    for (const state of this.indexes.values()) {
      state.buckets.clear()
      state.values.clear()
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
    const state = this.indexes.get(field)
    if (!state) return null
    const key = stringifyKey(value)
    return state.buckets.get(key) ?? EMPTY_SET
  }

  /**
   * Set lookup — return the union of record ids whose `field` matches any
   * of `values`. Returns `null` if the field is not declared. Returns a
   * fresh (non-shared) Set — safe for the caller to mutate.
   */
  lookupIn(field: string, values: readonly unknown[]): ReadonlySet<string> | null {
    const state = this.indexes.get(field)
    if (!state) return null
    const out = new Set<string>()
    for (const value of values) {
      const bucket = state.buckets.get(stringifyKey(value))
      if (bucket) for (const id of bucket) out.add(id)
    }
    return out
  }

  /**
   * Range lookup. Return record ids whose indexed value
   * satisfies the predicate. Comparison happens on the ORIGINAL TYPED
   * value carried in `state.values` — so numeric `<` sorts numerically,
   * not lexicographically on `String(n)`. Returns `null` if the field
   * is not declared.
   *
   * Supported ops: `'<'`, `'<='`, `'>'`, `'>='`, `'between'`. For
   * `'between'`, `value` is `[lo, hi]` and both bounds are inclusive
   * (matches the eager-mode operator contract in `predicate.ts`).
   */
  lookupRange(
    field: string,
    op: '<' | '<=' | '>' | '>=' | 'between',
    value: unknown,
  ): ReadonlySet<string> | null {
    const state = this.indexes.get(field)
    if (!state) return null
    const out = new Set<string>()
    for (const [recordId, live] of state.values) {
      if (live === undefined || live === null) continue
      if (matchesRange(live, op, value)) out.add(recordId)
    }
    return out
  }

  /**
   * Sorted iteration — return every entry on `field` as an
   * `OrderedEntry[]`, sorted by the ORIGINAL TYPED value (#275: no more
   * `'10' < '2'` surprises on numeric fields). Consumers paginate with
   * a numeric offset. `OrderedEntry.value` is the typed value.
   */
  orderedBy(field: string, dir: 'asc' | 'desc'): readonly OrderedEntry[] | null {
    const state = this.indexes.get(field)
    if (!state) return null
    const entries: OrderedEntry[] = []
    for (const [recordId, value] of state.values) {
      entries.push({ recordId, value })
    }
    entries.sort((a, b) => compareTyped(a.value, b.value))
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
  // composite index values are tuple arrays. JSON.stringify
  // gives a delimiter-safe, order-preserving canonical form so buckets
  // for `['c-A', '2026-Q1']` and `['c-A', '2026-Q2']` never collide.
  if (Array.isArray(value)) {
    const parts: string[] = []
    for (const el of value) parts.push(stringifyKey(el))
    return JSON.stringify(parts)
  }
  return '\0OBJECT\0'
}

function addToState(state: PersistedFieldState, recordId: string, value: unknown): void {
  if (value === null || value === undefined) return
  const key = stringifyKey(value)
  let bucket = state.buckets.get(key)
  if (!bucket) {
    bucket = new Set()
    state.buckets.set(key, bucket)
  }
  bucket.add(recordId)
  state.values.set(recordId, value)
}

function removeFromState(state: PersistedFieldState, recordId: string, value: unknown): void {
  if (value === null || value === undefined) return
  const key = stringifyKey(value)
  const bucket = state.buckets.get(key)
  if (bucket) {
    bucket.delete(recordId)
    if (bucket.size === 0) state.buckets.delete(key)
  }
  state.values.delete(recordId)
}

/**
 * Range-predicate comparator. Runs on the ORIGINAL TYPED value so numeric
 * fields sort numerically (not lexicographically on `String(n)`). ISO-8601
 * date strings already sort correctly lexicographically; Date instances
 * compare via `getTime()` before the string branch to keep the contract
 * honest regardless of which form survived serialization.
 */
function matchesRange(
  live: unknown,
  op: '<' | '<=' | '>' | '>=' | 'between',
  bound: unknown,
): boolean {
  if (op === 'between') {
    if (!Array.isArray(bound) || bound.length !== 2) return false
    return compareTyped(live, bound[0]) >= 0 && compareTyped(live, bound[1]) <= 0
  }
  const cmp = compareTyped(live, bound)
  switch (op) {
    case '<':  return cmp < 0
    case '<=': return cmp <= 0
    case '>':  return cmp > 0
    case '>=': return cmp >= 0
  }
}

function compareTyped(a: unknown, b: unknown): number {
  if (a === undefined || a === null) return b === undefined || b === null ? 0 : 1
  if (b === undefined || b === null) return -1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime()
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0
  if (typeof a === 'boolean' && typeof b === 'boolean') {
    return a === b ? 0 : a ? 1 : -1
  }
  // Mixed/unsupported types: deliberately treat as equal so sort stays
  // stable. Matches the eager-mode `compareValues` contract in
  // builder.ts — we don't silently coerce arbitrary objects to strings
  // (which would be meaningless) nor throw (which would be hostile).
  return 0
}
