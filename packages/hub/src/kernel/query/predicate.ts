/**
 * Operator implementations for the query DSL.
 *
 * All predicates run client-side, AFTER decryption — they never see ciphertext.
 * Field clauses over a Via-covered field (e.g. money) carry their own
 * evaluator closure (see {@link FieldClause.via}), so this module has no
 * dependency on any Via feature's implementation — still tree-shakeable.
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
  /**
   * Present when `field` is covered by a Via feature binding (e.g. a
   * declared money field): the opaque payload built by the binding's
   * `buildClause` at query BUILD time, plus a closure that evaluates it
   * per record via the binding's `evaluateClause`. Attached by
   * `Query.where()` / `ScanBuilder.where()` when `source.via` covers the
   * field. The closure keeps this module free of any dependency on a
   * Via feature's implementation — clauses are in-memory only, never
   * serialized, so carrying a function here is safe.
   */
  readonly via?: {
    readonly brand: string
    readonly payload: unknown
    readonly evaluate: (actual: unknown, op: string) => boolean
  }
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

/**
 * A declared deterministic predicate reference. The query
 * builder produces this via `.wherePredicate(name, ctx?)` when a
 * Query has been augmented with a predicates map (typically by the
 * materialized-view registry).
 *
 * `predicateHash` is the consumer-supplied stable hash for the
 * function body; `ctxHash` is the canonical-JSON SHA-256 of `ctx`.
 * Both fold into the MV's `queryHash` so a function or ctx change
 * forces refresh on next visit.
 *
 * `fn` is resolved at builder time from the predicates map and
 * embedded directly — so `evaluateClause` can fire it without a
 * runtime lookup.
 */
export interface WherePredicateClause {
  readonly type: 'wherePredicate'
  readonly name: string
  readonly ctx: unknown
  readonly predicateHash: string
  readonly ctxHash: string
  readonly fn: (record: unknown, ctx?: unknown) => boolean
}

/** A logical group of clauses combined by AND or OR. */
export interface GroupClause {
  readonly type: 'group'
  readonly op: 'and' | 'or'
  readonly clauses: readonly Clause[]
}

/**
 * Cartesian-product expansion clause. Appended to `QueryPlan.clauses`
 * by `Query.crossJoin()`. Processed in declaration order by
 * `executeClausePipeline` — NOT by `evaluateClause` (which is a
 * per-record predicate and throws on this type).
 */
export interface CrossJoinClause {
  readonly type: 'crossJoin'
  /** Target collection name to cross-join against. */
  readonly target: string
  /** Alias under which the right-side record is exposed on each result row. */
  readonly as: string
  /**
   * Lateral filter callback. `undefined` → full cartesian product.
   * Two call shapes:
   *   - Subset:    `(left) => TTarget[]`            — returns the right rows for this left row
   *   - Predicate: `(left) => (right) => boolean`   — executor materializes then filters
   */
  readonly on?: (left: unknown) => unknown[] | ((right: unknown) => boolean)
  /** When `on:` was supplied as `{ predicate: name }`, the name is stored here for queryHash. */
  readonly onPredicateName?: string
  /** Per-clause row ceiling override. `undefined` → `DEFAULT_CROSS_JOIN_MAX_ROWS`. */
  readonly maxRows?: number
}

export type Clause = FieldClause | FilterClause | WherePredicateClause | GroupClause | CrossJoinClause

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

  // A Via-covered field (e.g. money) may store a transformed
  // representation (money: BigInt-exact in scaled-integer space) that the
  // generic paths below can't compare correctly — the operand was
  // pre-built at query BUILD time and the binding's own evaluator knows
  // how to compare it against the raw stored value.
  if (clause.via) return clause.via.evaluate(actual, op)

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
 *
 * `fnRecord`, when provided, is the view handed to USER CALLBACK clauses
 * (`filter` / `wherePredicate`) instead of `record` — the executor passes
 * the money-decoded view there so user code never sees the stored
 * scaled-int form, while field clauses keep evaluating against the raw
 * record (their money operands are pre-quantized to that space).
 */
export function evaluateClause(record: unknown, clause: Clause, fnRecord?: unknown): boolean {
  switch (clause.type) {
    case 'field':
      return evaluateFieldClause(record, clause)
    case 'filter':
      return clause.fn(fnRecord !== undefined ? fnRecord : record)
    case 'wherePredicate':
      return clause.fn(fnRecord !== undefined ? fnRecord : record, clause.ctx)
    case 'crossJoin':
      throw new Error(
        `evaluateClause: 'crossJoin' clauses are expansion primitives and are not ` +
          `evaluated per-record. This is a query planner routing error — ` +
          `crossJoin clauses must be extracted from the clause list before calling ` +
          `evaluateClause or filterRecords.`,
      )
    case 'group':
      if (clause.op === 'and') {
        for (const child of clause.clauses) {
          if (!evaluateClause(record, child, fnRecord)) return false
        }
        return true
      } else {
        for (const child of clause.clauses) {
          if (evaluateClause(record, child, fnRecord)) return true
        }
        return false
      }
  }
}

/**
 * Does the clause list contain any user-callback clause (filter /
 * wherePredicate), at any group nesting depth? Used by executors to
 * decide whether the per-record decoded view needs materializing.
 */
export function hasFnClause(clauses: readonly Clause[]): boolean {
  for (const c of clauses) {
    if (c.type === 'filter' || c.type === 'wherePredicate') return true
    if (c.type === 'group' && hasFnClause(c.clauses)) return true
  }
  return false
}
