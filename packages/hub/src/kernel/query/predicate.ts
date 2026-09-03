/**
 * Operator implementations for the query DSL.
 *
 * All predicates run client-side, AFTER decryption — they never see ciphertext.
 * Field clauses over a Via-covered field (e.g. money) carry their own
 * evaluator closure (see {@link FieldClause.via}), so this module has no
 * dependency on any Via feature's implementation — still tree-shakeable.
 */

import { UnsafePatternError } from '../errors.js'

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
   * Regex / SQL-LIKE pattern match (#1357). Operand: a `RegExp`, or a
   * LIKE string. Normalized at `where()` time by {@link normalizeMatches}
   * — an anchored literal prefix is LOWERED to `startsWith` (so it takes
   * the sorted index), everything else is stored as `{ source, flags }`
   * and evaluated per record.
   */
  | 'matches'

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
    /**
     * The binding's `indexProbe` result for this clause's op/payload
     * (#625) — the STORED-form operand `candidateRecords()` (`kernel/
     * query/builder.ts`) can hand to `CollectionIndexes.lookupEqual`/
     * `lookupIn` for a fast path. `undefined` (no `indexProbe` hook, or
     * the binding declined to probe this op) means the field must fall
     * back to a linear scan via `evaluate` above.
     */
    readonly indexValue?: unknown
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
   * Alias under which the LEFT row is exposed (#1289, `.crossJoinWith()`).
   * `undefined` — every clause `.crossJoin()` builds — spreads the left row's
   * own fields at the top level, which is the pre-#1289 shape.
   *
   * Set, the row becomes `{ [leftAs]: left, [as]: right }` and NO field sits
   * at the top level. That is the whole point (a self-join needs both sides
   * distinguishable) and also its whole cost: Via dressing keys by bare field
   * name, so an aliased row is invisible to the top-level decode and must be
   * dressed per alias instead. See `dressAliases` in `builder.ts`.
   */
  readonly leftAs?: string
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
  /**
   * Left-outer mode (#1130). When the `on:` subset for a left row is empty,
   * emit that row once with `null` under `as` instead of dropping it.
   *
   * Applies to both call shapes. With `on:` the empty thing is that left
   * row's subset; without it, an empty TARGET collection is what would
   * otherwise drop every left row.
   */
  readonly outer?: boolean
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
    case 'matches': {
      if (typeof actual !== 'string') return false
      const re = matchesRegExp(value)
      return re !== null && re.test(actual)
    }
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

// --- 'matches' (#1357) ------------------------------------------------

/**
 * The serialized `matches` operand. Plans are JSON-serializable and an MV's
 * `queryHash` is taken over that JSON — a bare `RegExp` canonicalizes to
 * `{}`, so two different patterns would hash the SAME and a stale view would
 * never refresh. Source + flags is what makes the pattern part of the hash.
 */
interface MatchesOperand {
  readonly source: string
  readonly flags: string
}

/** ReDoS budget. A refusal, not a sanitiser — see {@link UnsafePatternError}. */
const MATCHES_MAX_SOURCE = 200
const MATCHES_MAX_GROUP_DEPTH = 5
const MATCHES_MAX_QUANTIFIERS = 20

function isQuantifier(c: string | undefined): boolean {
  return c === '*' || c === '+' || c === '?' || c === '{'
}

/**
 * Refuse a pattern that could backtrack catastrophically, by budget.
 *
 * Deliberately syntactic and conservative: an unescaped `{` counts as a
 * quantifier even when it is a literal brace, because over-counting only
 * ever costs a refusal the caller can see, while under-counting costs a
 * hang. The one structural rule is the real ReDoS shape — a quantified
 * group whose body itself quantifies, `(a+)+`.
 */
function assertSafePattern(source: string, flags: string): void {
  if (source.length > MATCHES_MAX_SOURCE) {
    throw new UnsafePatternError(
      `where(..., 'matches', ...): pattern is ${source.length} characters, over the ` +
        `${MATCHES_MAX_SOURCE}-character budget. Narrow the pattern, or use .filter(fn) ` +
        `and accept that it cannot use an index.`,
    )
  }
  for (const f of flags) {
    if (f === 'g' || f === 'y') {
      throw new UnsafePatternError(
        `where(..., 'matches', ...): the '${f}' flag makes RegExp.test() stateful across ` +
          `records and would silently drop rows. Remove it from /${source}/${flags}.`,
      )
    }
  }
  let quantifiers = 0
  let inClass = false
  let escaped = false
  const groupQuantified: boolean[] = []
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!
    if (escaped) { escaped = false; continue }
    if (c === '\\') { escaped = true; continue }
    if (inClass) { if (c === ']') inClass = false; continue }
    if (c === '[') { inClass = true; continue }
    if (c === '(') {
      groupQuantified.push(false)
      if (groupQuantified.length > MATCHES_MAX_GROUP_DEPTH) {
        throw new UnsafePatternError(
          `where(..., 'matches', ...): group nesting exceeds the depth-${MATCHES_MAX_GROUP_DEPTH} ` +
            `budget in /${source}/. Flatten the pattern.`,
        )
      }
      // `(?:` / `(?=` / `(?<name>` — that '?' is a group marker, not a quantifier.
      if (source[i + 1] === '?') i++
      continue
    }
    if (c === ')') {
      const bodyQuantified = groupQuantified.pop() ?? false
      if (bodyQuantified && isQuantifier(source[i + 1])) {
        throw new UnsafePatternError(
          `where(..., 'matches', ...): nested quantifier at index ${i + 1} of /${source}/ ` +
            `— a quantified group whose body also quantifies backtracks exponentially. ` +
            `Rewrite it, or use .filter(fn).`,
        )
      }
      continue
    }
    if (isQuantifier(c)) {
      quantifiers++
      if (quantifiers > MATCHES_MAX_QUANTIFIERS) {
        throw new UnsafePatternError(
          `where(..., 'matches', ...): more than ${MATCHES_MAX_QUANTIFIERS} quantifiers in ` +
            `/${source}/. Narrow the pattern, or use .filter(fn).`,
        )
      }
      if (groupQuantified.length > 0) groupQuantified[groupQuantified.length - 1] = true
    }
  }
}

/** Escape one character for literal use inside a RegExp source. */
function escapeRegExpChar(c: string): string {
  return /[.*+?^${}()|[\]\\/]/.test(c) ? `\\${c}` : c
}

/**
 * LIKE semantics, stated once: the pattern is ANCHORED at both ends (SQL
 * `LIKE`, not a substring find), `%` is any run of characters including
 * none, `_` is exactly one, and a BACKSLASH escapes the next character —
 * `\%` and `\_` are literal, `\\` is a literal backslash. Both wildcards
 * match newlines.
 */
function likeToSource(like: string): string {
  let out = '^'
  for (let i = 0; i < like.length; i++) {
    const c = like[i]!
    if (c === '\\') {
      const next = like[i + 1]
      if (next === undefined) {
        throw new UnsafePatternError(
          `where(..., 'matches', ...): LIKE pattern "${like}" ends with a dangling escape.`,
        )
      }
      i++
      out += escapeRegExpChar(next)
      continue
    }
    if (c === '%') { out += '[\\s\\S]*'; continue }
    if (c === '_') { out += '[\\s\\S]'; continue }
    out += escapeRegExpChar(c)
  }
  return `${out}$`
}

/**
 * The literal prefix a pattern is EXACTLY equivalent to, or `null`.
 *
 * Conservative by construction, because a wrong lowering returns wrong rows
 * silently while a missed one only costs a scan. It lowers only when the
 * source is `^` followed by characters that carry no regex meaning at all —
 * no escapes, no classes, no alternation, no quantifiers, no `$` — and the
 * flags are EMPTY. `i` in particular must never lower: the sorted index is
 * case-sensitive, so `/^client-b/i` would lose rows.
 */
function literalPrefixAnchor(source: string, flags: string): string | null {
  if (flags !== '' || !source.startsWith('^')) return null
  const rest = source.slice(1)
  return /^[^\\^$.|?*+()[\]{}]*$/.test(rest) ? rest : null
}

/**
 * Normalize a `where(field, 'matches', operand)` at BUILD time: refuse an
 * unsafe pattern, lower an anchored literal prefix to `startsWith`, and
 * otherwise serialize to `{ source, flags }`. Every other operator passes
 * through untouched.
 *
 * Called by every `where()` (`Query`, `ScanBuilder`, `LazyQuery`) so all
 * three build the same clause for the same call.
 */
export function normalizeMatches(op: Operator, value: unknown): { op: Operator, value: unknown } {
  if (op !== 'matches') return { op, value }
  let source: string
  let flags: string
  if (typeof value === 'string') {
    // `abc%` — a literal run then an open tail — IS startsWith('abc').
    if (/^[^%_\\]*%$/.test(value)) return { op: 'startsWith', value: value.slice(0, -1) }
    source = likeToSource(value)
    flags = ''
  } else if (value instanceof RegExp) {
    source = value.source
    flags = value.flags
  } else {
    throw new UnsafePatternError(
      `where(..., 'matches', ...) needs a RegExp or a LIKE string; received ${typeof value}.`,
    )
  }
  assertSafePattern(source, flags)
  const prefix = literalPrefixAnchor(source, flags)
  if (prefix !== null) return { op: 'startsWith', value: prefix }
  return { op: 'matches', value: { source, flags } satisfies MatchesOperand }
}

/**
 * Compiled-pattern cache, keyed by flags + source. `evaluateFieldClause`
 * runs per record, so recompiling would dominate the scan. Cleared wholesale
 * at a small cap rather than evicting — a query's live patterns recompile
 * once and the map cannot grow without bound.
 */
const MATCHES_CACHE = new Map<string, RegExp>()
const MATCHES_CACHE_MAX = 256

/**
 * The RegExp for a clause operand. Accepts the normalized
 * {@link MatchesOperand} and — for a hand-built plan that never went through
 * `where()` — a raw `RegExp`, whose `g`/`y` flags are stripped so `test()`
 * cannot carry `lastIndex` from one record to the next. Returns `null` for
 * anything else: a clause that cannot compile matches nothing, the same
 * posture as every other type mismatch in this module.
 */
function matchesRegExp(value: unknown): RegExp | null {
  const spec = value instanceof RegExp ? { source: value.source, flags: value.flags } : value
  if (typeof spec !== 'object' || spec === null) return null
  const { source, flags } = spec as Partial<MatchesOperand>
  if (typeof source !== 'string' || typeof flags !== 'string') return null
  const safeFlags = flags.replace(/[gy]/g, '')
  const key = `${safeFlags} ${source}`
  const cached = MATCHES_CACHE.get(key)
  if (cached !== undefined) return cached
  let re: RegExp
  try {
    re = new RegExp(source, safeFlags)
  } catch {
    return null
  }
  if (MATCHES_CACHE.size >= MATCHES_CACHE_MAX) MATCHES_CACHE.clear()
  MATCHES_CACHE.set(key, re)
  return re
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
