/**
 * Lazy-mode query builder (v0.22 #267, #268).
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

import type { Clause, FieldClause, Operator } from './predicate.js'
import { evaluateClause, readPath } from './predicate.js'
import type { PersistedCollectionIndex } from './persisted-indexes.js'
import { IndexRequiredError } from '../errors.js'

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
  /** Ensure `_idx/<field>/*` side-cars have been bulk-loaded into the mirror. */
  ensurePersistedIndexesLoaded(): Promise<void>
  /** Decrypt one record by id, or return null if it's gone. */
  getRecord(id: string): Promise<T | null>
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

export class LazyQuery<T> {
  private readonly source: LazyQuerySource<T>
  private readonly plan: LazyPlan

  constructor(source: LazyQuerySource<T>, plan: LazyPlan = EMPTY_PLAN) {
    this.source = source
    this.plan = plan
  }

  where<V>(field: string, op: Operator, value: V): LazyQuery<T> {
    const clause: FieldClause = { type: 'field', field, op, value }
    return new LazyQuery<T>(this.source, {
      ...this.plan,
      clauses: [...this.plan.clauses, clause],
    })
  }

  orderBy(field: string, direction: 'asc' | 'desc' = 'asc'): LazyQuery<T> {
    return new LazyQuery<T>(this.source, {
      ...this.plan,
      orderBy: [...this.plan.orderBy, { field, direction }],
    })
  }

  limit(n: number): LazyQuery<T> {
    return new LazyQuery<T>(this.source, { ...this.plan, limit: n })
  }

  offset(n: number): LazyQuery<T> {
    return new LazyQuery<T>(this.source, { ...this.plan, offset: n })
  }

  async toArray(): Promise<T[]> {
    await this.source.ensurePersistedIndexesLoaded()

    const touchedFields = collectTouchedFields(this.plan)
    const missingFields = touchedFields.filter(f => !this.source.persistedIndexes.has(f))
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

    const records: T[] = []
    for (const id of candidateIds) {
      const record = await this.source.getRecord(id)
      if (record === null) continue
      if (!matchesAll(record, this.plan.clauses)) continue
      records.push(record)
    }

    const sorted = this.plan.orderBy.length > 0
      ? sortRecords(records, this.plan.orderBy)
      : records

    const offset = this.plan.offset > 0 ? this.plan.offset : 0
    const limited = this.plan.limit === undefined
      ? sorted.slice(offset)
      : sorted.slice(offset, offset + this.plan.limit)

    return limited
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

    for (const clause of this.plan.clauses) {
      if (clause.op === '==') {
        const ids = idx.lookupEqual(clause.field, clause.value)
        if (ids) return [...ids]
      } else if (clause.op === 'in' && Array.isArray(clause.value)) {
        const ids = idx.lookupIn(clause.field, clause.value as readonly unknown[])
        if (ids) return [...ids]
      }
    }

    // No equality driver — try to scope via orderBy.
    if (this.plan.orderBy.length > 0) {
      const primary = this.plan.orderBy[0]!
      const entries = idx.orderedBy(primary.field, primary.direction)
      if (entries) return entries.map(e => e.recordId)
    }

    return null
  }
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

function sortRecords<T>(records: T[], orderBy: readonly LazyOrderBy[]): T[] {
  return [...records].sort((a, b) => {
    for (const { field, direction } of orderBy) {
      const av = readPath(a, field)
      const bv = readPath(b, field)
      const cmp = compareValues(av, bv)
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
