/**
 * Chainable, immutable query builder.
 *
 * Each builder operation returns a NEW Query — the underlying plan is never
 * mutated. This makes plans safe to share, cache, and serialize.
 */

import type { Clause, FieldClause, FilterClause, GroupClause, Operator } from './predicate.js'
import { evaluateClause } from './predicate.js'

export interface OrderBy {
  readonly field: string
  readonly direction: 'asc' | 'desc'
}

/**
 * A complete query plan: zero-or-more clauses, optional ordering, pagination.
 * Plans are JSON-serializable as long as no FilterClause is present.
 *
 * Plans are intentionally NOT parametric on T — see `predicate.ts` FilterClause
 * for the variance reasoning. The public `Query<T>` API attaches the type tag.
 */
export interface QueryPlan {
  readonly clauses: readonly Clause[]
  readonly orderBy: readonly OrderBy[]
  readonly limit: number | undefined
  readonly offset: number
}

const EMPTY_PLAN: QueryPlan = {
  clauses: [],
  orderBy: [],
  limit: undefined,
  offset: 0,
}

/**
 * Source of records that a query executes against.
 *
 * The interface is non-parametric to keep variance friendly: callers cast
 * their typed source (e.g. `QuerySource<Invoice>`) into this opaque shape.
 */
export interface QuerySource<T> {
  /** Snapshot of all current records. The query never mutates this array. */
  snapshot(): readonly T[]
  /** Subscribe to mutations; returns an unsubscribe function. */
  subscribe?(cb: () => void): () => void
}

interface InternalSource {
  snapshot(): readonly unknown[]
  subscribe?(cb: () => void): () => void
}

/**
 * The chainable builder. All methods return a new Query — the original
 * remains unchanged. Terminal methods (`toArray`, `first`, `count`,
 * `subscribe`) execute the plan against the source.
 *
 * Type parameter T flows through the public API for ergonomics, but the
 * internal storage uses `unknown` so Collection<T> stays covariant.
 */
export class Query<T> {
  private readonly source: InternalSource
  private readonly plan: QueryPlan

  constructor(source: QuerySource<T>, plan: QueryPlan = EMPTY_PLAN) {
    this.source = source as InternalSource
    this.plan = plan
  }

  /** Add a field comparison. Multiple where() calls are AND-combined. */
  where(field: string, op: Operator, value: unknown): Query<T> {
    const clause: FieldClause = { type: 'field', field, op, value }
    return new Query<T>(this.source as QuerySource<T>, {
      ...this.plan,
      clauses: [...this.plan.clauses, clause],
    })
  }

  /**
   * Logical OR group. Pass a callback that builds a sub-query.
   * Each clause inside the callback is OR-combined; the group itself
   * joins the parent plan with AND.
   */
  or(builder: (q: Query<T>) => Query<T>): Query<T> {
    const sub = builder(new Query<T>(this.source as QuerySource<T>))
    const group: GroupClause = {
      type: 'group',
      op: 'or',
      clauses: sub.plan.clauses,
    }
    return new Query<T>(this.source as QuerySource<T>, {
      ...this.plan,
      clauses: [...this.plan.clauses, group],
    })
  }

  /**
   * Logical AND group. Same shape as `or()` but every clause inside the group
   * must match. Useful for explicit grouping inside a larger OR.
   */
  and(builder: (q: Query<T>) => Query<T>): Query<T> {
    const sub = builder(new Query<T>(this.source as QuerySource<T>))
    const group: GroupClause = {
      type: 'group',
      op: 'and',
      clauses: sub.plan.clauses,
    }
    return new Query<T>(this.source as QuerySource<T>, {
      ...this.plan,
      clauses: [...this.plan.clauses, group],
    })
  }

  /** Escape hatch: add an arbitrary predicate function. Not serializable. */
  filter(fn: (record: T) => boolean): Query<T> {
    const clause: FilterClause = {
      type: 'filter',
      fn: fn as (record: unknown) => boolean,
    }
    return new Query<T>(this.source as QuerySource<T>, {
      ...this.plan,
      clauses: [...this.plan.clauses, clause],
    })
  }

  /** Sort by a field. Subsequent calls are tie-breakers. */
  orderBy(field: string, direction: 'asc' | 'desc' = 'asc'): Query<T> {
    return new Query<T>(this.source as QuerySource<T>, {
      ...this.plan,
      orderBy: [...this.plan.orderBy, { field, direction }],
    })
  }

  /** Cap the result size. */
  limit(n: number): Query<T> {
    return new Query<T>(this.source as QuerySource<T>, { ...this.plan, limit: n })
  }

  /** Skip the first N matching records (after ordering). */
  offset(n: number): Query<T> {
    return new Query<T>(this.source as QuerySource<T>, { ...this.plan, offset: n })
  }

  /** Execute the plan and return the matching records. */
  toArray(): T[] {
    return executePlan(this.source.snapshot(), this.plan) as T[]
  }

  /** Return the first matching record, or null. */
  first(): T | null {
    const result = executePlan(this.source.snapshot(), { ...this.plan, limit: 1 })
    return (result[0] as T | undefined) ?? null
  }

  /** Return the number of matching records (after where/filter, before limit). */
  count(): number {
    const filtered = filterRecords(this.source.snapshot(), this.plan.clauses)
    return filtered.length
  }

  /**
   * Re-run the query whenever the source notifies of changes.
   * Returns an unsubscribe function. The callback receives the latest result.
   * Throws if the source does not support subscriptions.
   */
  subscribe(cb: (result: T[]) => void): () => void {
    if (!this.source.subscribe) {
      throw new Error('Query source does not support subscriptions. Pass a source with a subscribe() method.')
    }
    cb(this.toArray())
    return this.source.subscribe(() => cb(this.toArray()))
  }

  /**
   * Return the plan as a JSON-friendly object. FilterClause entries are
   * stripped (their `fn` cannot be serialized) and replaced with
   * { type: 'filter', fn: '[function]' } so devtools can still see them.
   */
  toPlan(): unknown {
    return serializePlan(this.plan)
  }
}

/**
 * Execute a plan against a snapshot of records.
 * Pure function — same input, same output, no side effects.
 *
 * Records are typed as `unknown` because plans are non-parametric; callers
 * cast the return type at the API surface (see `Query.toArray()`).
 */
export function executePlan(records: readonly unknown[], plan: QueryPlan): unknown[] {
  let result = filterRecords(records, plan.clauses)
  if (plan.orderBy.length > 0) {
    result = sortRecords(result, plan.orderBy)
  }
  if (plan.offset > 0) {
    result = result.slice(plan.offset)
  }
  if (plan.limit !== undefined) {
    result = result.slice(0, plan.limit)
  }
  return result
}

function filterRecords(records: readonly unknown[], clauses: readonly Clause[]): unknown[] {
  if (clauses.length === 0) return [...records]
  const out: unknown[] = []
  for (const r of records) {
    let matches = true
    for (const clause of clauses) {
      if (!evaluateClause(r, clause)) {
        matches = false
        break
      }
    }
    if (matches) out.push(r)
  }
  return out
}

function sortRecords(records: unknown[], orderBy: readonly OrderBy[]): unknown[] {
  // Stable sort: Array.prototype.sort is required to be stable since ES2019.
  return [...records].sort((a, b) => {
    for (const { field, direction } of orderBy) {
      const av = readField(a, field)
      const bv = readField(b, field)
      const cmp = compareValues(av, bv)
      if (cmp !== 0) return direction === 'asc' ? cmp : -cmp
    }
    return 0
  })
}

function readField(record: unknown, field: string): unknown {
  if (record === null || record === undefined) return undefined
  if (!field.includes('.')) {
    return (record as Record<string, unknown>)[field]
  }
  const segments = field.split('.')
  let cursor: unknown = record
  for (const segment of segments) {
    if (cursor === null || cursor === undefined) return undefined
    cursor = (cursor as Record<string, unknown>)[segment]
  }
  return cursor
}

function compareValues(a: unknown, b: unknown): number {
  // Nullish goes last in asc order.
  if (a === undefined || a === null) return b === undefined || b === null ? 0 : 1
  if (b === undefined || b === null) return -1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime()
  // Mixed/unsupported types: treat as equal so the sort stays stable.
  // (Deliberate choice — we don't try to coerce arbitrary objects to strings.)
  return 0
}

function serializePlan(plan: QueryPlan): unknown {
  return {
    clauses: plan.clauses.map(serializeClause),
    orderBy: plan.orderBy,
    limit: plan.limit,
    offset: plan.offset,
  }
}

function serializeClause(clause: Clause): unknown {
  if (clause.type === 'filter') {
    return { type: 'filter', fn: '[function]' }
  }
  if (clause.type === 'group') {
    return {
      type: 'group',
      op: clause.op,
      clauses: clause.clauses.map(serializeClause),
    }
  }
  return clause
}
