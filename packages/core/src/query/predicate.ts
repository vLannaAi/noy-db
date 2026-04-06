/**
 * Operator implementations for the query DSL.
 *
 * All predicates run client-side, AFTER decryption — they never see ciphertext.
 * This file is dependency-free and tree-shakeable.
 */

/** Comparison operators supported by the where() builder. */
export type Operator =
  | '=='
  | '!='
  | '<'
  | '<='
  | '>'
  | '>='
  | 'in'
  | 'contains'
  | 'startsWith'
  | 'between'

/**
 * A single field comparison clause inside a query plan.
 * Plans are JSON-serializable, so this type uses primitives only.
 */
export interface FieldClause {
  readonly type: 'field'
  readonly field: string
  readonly op: Operator
  readonly value: unknown
}

/**
 * A user-supplied predicate function escape hatch. Not serializable.
 *
 * The predicate accepts `unknown` at the type level so the surrounding
 * Clause type can stay non-parametric — this keeps Collection<T> covariant
 * in T at the public API surface. Builder methods cast user predicates
 * (typed `(record: T) => boolean`) into this shape on the way in.
 */
export interface FilterClause {
  readonly type: 'filter'
  readonly fn: (record: unknown) => boolean
}

/** A logical group of clauses combined by AND or OR. */
export interface GroupClause {
  readonly type: 'group'
  readonly op: 'and' | 'or'
  readonly clauses: readonly Clause[]
}

export type Clause = FieldClause | FilterClause | GroupClause

/**
 * Read a possibly nested field path like "address.city" from a record.
 * Returns undefined if any segment is missing.
 */
export function readPath(record: unknown, path: string): unknown {
  if (record === null || record === undefined) return undefined
  if (!path.includes('.')) {
    return (record as Record<string, unknown>)[path]
  }
  const segments = path.split('.')
  let cursor: unknown = record
  for (const segment of segments) {
    if (cursor === null || cursor === undefined) return undefined
    cursor = (cursor as Record<string, unknown>)[segment]
  }
  return cursor
}

/**
 * Evaluate a single field clause against a record.
 * Returns false on type mismatches rather than throwing — query results
 * exclude non-matching records by definition.
 */
export function evaluateFieldClause(record: unknown, clause: FieldClause): boolean {
  const actual = readPath(record, clause.field)
  const { op, value } = clause

  switch (op) {
    case '==':
      return actual === value
    case '!=':
      return actual !== value
    case '<':
      return isComparable(actual, value) && (actual as number) < (value as number)
    case '<=':
      return isComparable(actual, value) && (actual as number) <= (value as number)
    case '>':
      return isComparable(actual, value) && (actual as number) > (value as number)
    case '>=':
      return isComparable(actual, value) && (actual as number) >= (value as number)
    case 'in':
      return Array.isArray(value) && value.includes(actual)
    case 'contains':
      if (typeof actual === 'string') return typeof value === 'string' && actual.includes(value)
      if (Array.isArray(actual)) return actual.includes(value)
      return false
    case 'startsWith':
      return typeof actual === 'string' && typeof value === 'string' && actual.startsWith(value)
    case 'between': {
      if (!Array.isArray(value) || value.length !== 2) return false
      const [lo, hi] = value
      if (!isComparable(actual, lo) || !isComparable(actual, hi)) return false
      return (actual as number) >= (lo as number) && (actual as number) <= (hi as number)
    }
    default: {
      // Exhaustiveness — TS will error if a new operator is added without a case.
      const _exhaustive: never = op
      void _exhaustive
      return false
    }
  }
}

/**
 * Two values are "comparable" if they share an order-defined runtime type.
 * Strings compare lexicographically; numbers and Dates numerically; otherwise false.
 */
function isComparable(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') return true
  if (typeof a === 'string' && typeof b === 'string') return true
  if (a instanceof Date && b instanceof Date) return true
  return false
}

/**
 * Evaluate any clause (field / filter / group) against a record.
 * The recursion depth is bounded by the user's query expression — no risk of
 * blowing the stack on a 50K-record collection.
 */
export function evaluateClause(record: unknown, clause: Clause): boolean {
  switch (clause.type) {
    case 'field':
      return evaluateFieldClause(record, clause)
    case 'filter':
      return clause.fn(record)
    case 'group':
      if (clause.op === 'and') {
        for (const child of clause.clauses) {
          if (!evaluateClause(record, child)) return false
        }
        return true
      } else {
        for (const child of clause.clauses) {
          if (evaluateClause(record, child)) return true
        }
        return false
      }
  }
}
