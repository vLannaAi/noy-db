/**
 * Lazy-mode query builder.
 *
 * Companion to `Query<T>` in `builder.ts`, but built for collections in lazy
 * mode where `snapshot()` is unavailable — records live in the adapter and
 * are pulled on demand. Dispatches through `PersistedCollectionIndex` to
 * resolve a candidate record-id set, then decrypts only those records.
 *
 * Scope:
 *   - `.where(field, '==' | 'in', value)` — dispatched through the index
 *   - `.where(field, other-op, value)` — evaluated against the decrypted
 *     candidate set (non-indexed ops still require the field to be indexed
 *     — we need SOMETHING to scope the candidate set)
 *   - `.orderBy(field, dir?)` — dispatched through `orderedBy` when no
 *     `==`/`in` clause is present; otherwise applied as an in-memory sort
 *     over the candidate set
 *   - `.limit(n)` / `.offset(n)` — page slice after filtering
 *   - `.toArray()` / `.first()` / `.count()` — terminals
 *
 * Every field referenced by a where or orderBy clause MUST be indexed;
 * otherwise `toArray()` throws `IndexRequiredError`. This is deliberate:
 * silent scan-fallback would hide the very performance cliff that lazy-mode
 * indexes exist to prevent (see `docs/architecture.md` §indexes).
 */

import type { Clause, FieldClause, Operator } from '../../kernel/query/predicate.js'
import { evaluateClause, normalizeMatches, readPath } from '../../kernel/query/predicate.js'
import type { PersistedCollectionIndex } from './persisted-indexes.js'
import { IndexRequiredError, FieldNotQueryableError } from '../../kernel/errors.js'
import type { QueryField } from '../../kernel/types.js'
import type { ViaPipeline } from '../../kernel/via/pipeline.js'

export interface LazyOrderBy {
  readonly field: string
  readonly direction: 'asc' | 'desc'
}

/**
 * Source abstraction the LazyQuery runs against. Collection implements it.
 * Kept minimal so the builder stays test-friendly.
 */
export interface LazyQuerySource<T> {
  readonly collectionName: string
  readonly persistedIndexes: PersistedCollectionIndex
  /**
   * Per-field bucket-key canonicalizer (#677 — lazy twin of the eager
   * `candidateRecords()` probe-resolution in `kernel/query/builder.ts`).
   * Consulted in `resolveCandidateIds()` for `==`/`in` clause values
   * BEFORE calling `lookupEqual`/`lookupIn`, so a mixed-era stored value
   * (money) probes the SAME canonical bucket the write path now
   * populates. A narrow closure — not the whole `ViaPipeline` — keeps
   * the with-lookup/kernel seam thin. `undefined` (no via, or no binding
   * covers the field) is the common case: falls back to the raw value,
   * unchanged from today.
   */
  canonicalizeIndexKey?(field: string, value: unknown): string | undefined
  /** Ensure `_idx/<field>/*` side-cars have been bulk-loaded into the mirror. */
  ensurePersistedIndexesLoaded(): Promise<void>
  /**
   * Decrypt one record by id in RAW (pre-`present()`, stored-form) shape,
   * or return null if it's gone (#684 — the raw-fetch seam). Used by the
   * post-filter (`toArray()`) so a `clause.via.evaluate` (e.g. money) sees
   * the same operand/actual-value space as eager's `filterRecords` — the
   * DECODED form (e.g. money's canonical decimal) is only materialized
   * for survivors, via {@link decodeRecord}.
   */
  getRawRecord(id: string): Promise<unknown>
  /**
   * Apply this collection's locale/virtual-field decode (`present()`) to a
   * RAW record already known to match — the output-side twin of
   * {@link getRawRecord}. Mirrors eager's `Query.decodeVia`.
   */
  decodeRecord(record: unknown): Promise<T>
  /**
   * This collection's compiled Via pipeline (money, i18n, …), read lazily
   * (a method, not a captured value) so a late `_setVia` (#666) is honored
   * — same closure discipline as {@link canonicalizeIndexKey}. `undefined`
   * when the collection has no Via-covered fields.
   */
  via(): ViaPipeline | undefined
}

interface LazyPlan {
  readonly clauses: readonly FieldClause[]
  readonly orderBy: readonly LazyOrderBy[]
  readonly limit: number | undefined
  readonly offset: number
}

const EMPTY_PLAN: LazyPlan = {
  clauses: [],
  orderBy: [],
  limit: undefined,
  offset: 0,
}

export class LazyQuery<T, S extends keyof T = never, Q extends keyof T & string = never> {
  private readonly source: LazyQuerySource<T>
  private readonly plan: LazyPlan

  constructor(source: LazyQuerySource<T>, plan: LazyPlan = EMPTY_PLAN) {
    this.source = source
    this.plan = plan
  }

  where<V>(field: QueryField<T, S, Q>, op: Operator, value: V): LazyQuery<T, S, Q> {
    // A Via-covered field (e.g. money) compares in major units, BigInt-exact
    // in scaled space — same build-time operand rewrite + `clause.via`
    // attachment as `Query.where()` (`kernel/query/builder.ts`) and
    // `ScanBuilder.where()` (`kernel/query/scan-builder.ts`). Before #684
    // this method built a bare clause with no `clause.via` at all, so the
    // post-filter fell through to the generic (non-Via-aware) comparison —
    // see `toArray()` below for the raw-record post-filter this feeds.
    const via = this.source.via()
    // Consults the Via pipeline's posture BEFORE building a clause — same
    // gate as `Query.where()` (builder.ts) / `ScanBuilder.where()`
    // (scan-builder.ts): a field whose posture is `queryable: 'none'`
    // (e.g. a `blobFields` slot) throws `FieldNotQueryableError` here, at
    // the call site, instead of building a bare clause that later surfaces
    // as a deferred `IndexRequiredError` from `toArray()`.
    if (via?.postureFor(field)?.queryable === 'none') throw new FieldNotQueryableError(field)
    // #1357: a 'matches' operand is refused-or-normalized HERE, at the call
    // site — an anchored literal prefix lowers to `startsWith` (taking the
    // sorted index), anything else serializes to `{ source, flags }` so the
    // pattern folds into an MV's queryHash. Every other operator is identity.
    const { op: mop, value: mval } = normalizeMatches(op, value)
    const viaClause = via?.buildClause(field, mop, mval)
    const clause: FieldClause = viaClause
      ? {
          type: 'field',
          field,
          op: mop,
          value: mval,
          via: {
            brand: viaClause.brand,
            payload: viaClause.payload,
            evaluate: (actual: unknown, evalOp: string) => via!.evaluateClause(viaClause, actual, evalOp),
            indexValue: via!.indexProbe(viaClause, mop),
          },
        }
      : { type: 'field', field, op: mop, value: mval }
    return new LazyQuery<T, S, Q>(this.source, {
      ...this.plan,
      clauses: [...this.plan.clauses, clause],
    })
  }

  orderBy(field: QueryField<T, S>, direction: 'asc' | 'desc' = 'asc'): LazyQuery<T, S, Q> {
    return new LazyQuery<T, S, Q>(this.source, {
      ...this.plan,
      orderBy: [...this.plan.orderBy, { field, direction }],
    })
  }

  limit(n: number): LazyQuery<T, S, Q> {
    return new LazyQuery<T, S, Q>(this.source, { ...this.plan, limit: n })
  }

  offset(n: number): LazyQuery<T, S, Q> {
    return new LazyQuery<T, S, Q>(this.source, { ...this.plan, offset: n })
  }

  async toArray(): Promise<T[]> {
    await this.source.ensurePersistedIndexesLoaded()

    const touchedFields = collectTouchedFields(this.plan)
    const missingFields = touchedFields.filter(f => !isFieldIndexed(f, this.source.persistedIndexes))
    if (missingFields.length > 0) {
      throw new IndexRequiredError({
        collection: this.source.collectionName,
        touchedFields,
        missingFields,
      })
    }

    const candidateIds = this.resolveCandidateIds()
    if (candidateIds === null) {
      // No usable driver — every touched field is indexed but no clause
      // pins the candidate set. This happens when a query only uses
      // operators other than `==`/`in` and no `orderBy` clause is
      // present — we refuse to enumerate the whole index, because that
      // defeats the purpose of lazy mode.
      throw new IndexRequiredError({
        collection: this.source.collectionName,
        touchedFields,
        missingFields: touchedFields,
      })
    }

    // #684: post-filter the RAW record (mirrors eager's filterRecords on the
    // raw snapshot) so `clause.via.evaluate` sees the same stored-form
    // operand/actual-value space `buildClause` quantized into at where()
    // time. Survivors stay RAW here — #695 sorts them via-aware in that
    // same stored-form space (mirroring eager's `sortRecords(result, ...,
    // source.via, ...)` in `kernel/query/builder.ts`) before anything is
    // decoded (`present()`).
    const survivors: T[] = []
    for (const id of candidateIds) {
      const raw = await this.source.getRawRecord(id)
      if (raw === null) continue
      if (!matchesAll(raw, this.plan.clauses)) continue
      survivors.push(raw as T)
    }

    // #695: sort the RAW survivors via-aware — a money field's stored form
    // (scaled-integer string) sorts lexicographically wrong under the
    // generic comparator ('10.00' < '2.00' once decoded); `via.compareForOrder`
    // compares in the correct (BigInt-exact scaled) space, same as eager.
    const sorted = this.plan.orderBy.length > 0
      ? sortRecords(survivors, this.plan.orderBy, this.source.via())
      : survivors

    const offset = this.plan.offset > 0 ? this.plan.offset : 0
    const page = this.plan.limit === undefined
      ? sorted.slice(offset)
      : sorted.slice(offset, offset + this.plan.limit)

    // Decode only the final page — fewer decodes than the pre-#695 code,
    // which decoded every survivor before sorting/slicing.
    return Promise.all(page.map(r => this.source.decodeRecord(r)))
  }

  async first(): Promise<T | null> {
    const out = await this.limit(1).toArray()
    return out.length > 0 ? out[0]! : null
  }

  async count(): Promise<number> {
    const out = await this.toArray()
    return out.length
  }

  /**
   * Resolve the candidate record-id set to decrypt. Returns null when the
   * query has no usable driver — no `==`/`in` clause and no `orderBy`
   * clause that can scope the scan. Callers interpret null as
   * IndexRequiredError (see `toArray`).
   */
  private resolveCandidateIds(): readonly string[] | null {
    const idx = this.source.persistedIndexes

    // prefer a composite index when the query's `==`
    // clauses cover every field of one declared composite. The
    // composite mirror lookup is O(matches) vs single-field +
    // post-filter on the decrypted candidate set.
    const eqMap = new Map<string, unknown>()
    const viaFields = new Set<string>()
    for (const clause of this.plan.clauses) {
      if (clause.op === '==') {
        eqMap.set(clause.field, clause.value)
        // #696: the composite mirror buckets on `stringifyKey(tuple)` built
        // from the RAW clause values — the per-field money canonicalizer
        // (`canonicalizeIndexKey`) only ever keys off a single field name,
        // never the joined composite key, so a Via-covered field's tuple
        // slot never lands in the same bucket a canonical write produced.
        // Track which `==` fields are Via-covered so the composite branch
        // below can skip them and fall through to the single-field
        // Via-aware path (already correct for money) instead.
        if (clause.via) viaFields.add(clause.field)
      }
    }
    if (eqMap.size >= 2) {
      for (const def of idx.definitions()) {
        if (def.kind !== 'composite') continue
        if (def.fields.some(f => viaFields.has(f))) continue
        if (def.fields.every(f => eqMap.has(f))) {
          const tuple = def.fields.map(f => eqMap.get(f))
          const ids = idx.lookupEqual(def.key, tuple)
          if (ids) return [...ids]
        }
      }
    }

    for (const clause of this.plan.clauses) {
      if (clause.op === '==') {
        if (clause.via) {
          // #684: prefer `clause.via.indexValue` — the same STORED-form
          // probe operand eager's `candidateRecords()` resolves first
          // (`kernel/query/builder.ts`). `undefined` means the binding
          // declined to probe this op/payload (e.g. money multi-mode) — no
          // sound equality bucket exists. Eager's `candidateRecords()`
          // handles this by skipping the index-eligibility check for the
          // clause and falling back to a full scan (`builder.ts:1176`); the
          // lazy equivalent (#684 review-fix 2) is the same move the RANGE branch
          // below already makes — enumerate the field's full indexed id
          // set via `orderedBy` and let the (now via-aware) post-filter in
          // `toArray()` decide, instead of throwing `IndexRequiredError`.
          if (clause.via.indexValue === undefined) {
            const entries = idx.orderedBy(clause.field, 'asc')
            if (entries) return entries.map(e => e.recordId)
            continue
          }
          const ids = idx.lookupEqual(clause.field, clause.via.indexValue)
          if (ids) return [...ids]
          continue
        }
        // #677: canonicalize the probe value BEFORE the lookup — same
        // "resolve before lookupEqual" shape as eager's `candidateRecords()`,
        // but through the narrower `canonicalizeIndexKey` seam, used only on
        // this NON-via path. `undefined` (no via coverage) falls back to the
        // raw clause value, unchanged from today.
        const probe = this.source.canonicalizeIndexKey?.(clause.field, clause.value) ?? clause.value
        const ids = idx.lookupEqual(clause.field, probe)
        if (ids) return [...ids]
      } else if (clause.op === 'in' && Array.isArray(clause.value)) {
        if (clause.via) {
          // Same #684 review-fix 2 fallback as the `==` branch above — a via
          // payload that declines to probe (e.g. money multi-mode) still
          // has a sound candidate superset via `orderedBy`.
          if (clause.via.indexValue === undefined) {
            const entries = idx.orderedBy(clause.field, 'asc')
            if (entries) return entries.map(e => e.recordId)
            continue
          }
          if (!Array.isArray(clause.via.indexValue)) continue
          const ids = idx.lookupIn(clause.field, clause.via.indexValue)
          if (ids) return [...ids]
          continue
        }
        const probes = clause.value.map(v => this.source.canonicalizeIndexKey?.(clause.field, v) ?? v)
        const ids = idx.lookupIn(clause.field, probes)
        if (ids) return [...ids]
      } else if (isRangeOp(clause.op)) {
        if (clause.via) {
          // #684: a Via-covered range clause (e.g. money) cannot trust
          // `lookupRange` — it compares the ORIGINAL TYPED stored value,
          // wrong space for a binding whose stored form isn't directly
          // orderable that way (money: BigInt-exact scaled-int compare).
          // No binding emits a range `indexProbe` either (see
          // `moneyIndexProbe`), so there's no sound bucket lookup at all.
          // Enumerate the field's full indexed id set via `orderedBy` — the
          // same superset a scan would consider, just scoped to indexed ids
          // — and let the (now via-aware) post-filter in `toArray()` apply
          // the correct scaled-space comparison. Replaces the old
          // "always trust lookupRange, no scan fallback" gap.
          const entries = idx.orderedBy(clause.field, 'asc')
          if (entries) return entries.map(e => e.recordId)
          continue
        }
        // range predicates on a NON-via indexed field dispatch through
        // `lookupRange`, which compares on the original typed value (no
        // numeric-lexicographic landmines).
        const ids = idx.lookupRange(clause.field, clause.op, clause.value)
        if (ids) return [...ids]
      }
    }

    // No equality/range driver — try to scope via orderBy.
    if (this.plan.orderBy.length > 0) {
      const primary = this.plan.orderBy[0]!
      const entries = idx.orderedBy(primary.field, primary.direction)
      if (entries) return entries.map(e => e.recordId)
    }

    return null
  }
}

/**
 * True if the given field name is covered by either a single-field
 * index or appears as a component of a declared composite index.
 * Composite coverage is sufficient for the missing-field check because
 * composite writes also maintain the in-memory mirror — the range /
 * orderBy / single-equality lookup paths fall through to decrypted
 * candidates that still get post-filtered by the composite clause.
 */
function isFieldIndexed(field: string, idx: PersistedCollectionIndex): boolean {
  if (idx.has(field)) return true
  for (const def of idx.definitions()) {
    if (def.kind === 'composite' && def.fields.includes(field)) return true
  }
  return false
}

function isRangeOp(op: Operator): op is '<' | '<=' | '>' | '>=' | 'between' {
  return op === '<' || op === '<=' || op === '>' || op === '>=' || op === 'between'
}

function collectTouchedFields(plan: LazyPlan): string[] {
  const seen = new Set<string>()
  for (const c of plan.clauses) seen.add(c.field)
  for (const o of plan.orderBy) seen.add(o.field)
  return [...seen]
}

function matchesAll(record: unknown, clauses: readonly Clause[]): boolean {
  for (const c of clauses) {
    if (!evaluateClause(record, c)) return false
  }
  return true
}

function sortRecords<T>(records: T[], orderBy: readonly LazyOrderBy[], via?: ViaPipeline): T[] {
  return [...records].sort((a, b) => {
    for (const { field, direction } of orderBy) {
      const av = readPath(a, field)
      const bv = readPath(b, field)
      // #695: a Via-covered field (e.g. money) may store a representation
      // the generic comparator would order wrong — ask the pipeline for an
      // exact ordering first, same as eager's `sortRecords` in
      // `kernel/query/builder.ts`. `undefined` (no via, or the field isn't
      // covered) falls back to the generic comparator, unchanged from today.
      const viaCmp = via?.compareForOrder(field, av, bv)
      const cmp = viaCmp !== undefined ? viaCmp : compareValues(av, bv)
      if (cmp !== 0) return direction === 'asc' ? cmp : -cmp
    }
    return 0
  })
}

function compareValues(a: unknown, b: unknown): number {
  if (a === undefined || a === null) return b === undefined || b === null ? 0 : 1
  if (b === undefined || b === null) return -1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime()
  return 0
}
