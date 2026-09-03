/**
 * `Query.explain()` — a readable execution plan (#1348).
 *
 * `toPlan()` answers *what* the query is; this answers *how it would run*:
 * the dispatch per clause (`index:hash` vs `scan`), row estimates taken from
 * real index cardinalities, join strategy and side sizes against the row
 * ceiling, whether ordering/pagination lands pre- or post-join, and which
 * cardinality caps are close to tripping.
 *
 * ⛔ PURELY OBSERVATIONAL. Every read here is a size probe or an index
 * bucket lookup — both pure. `explain()` must never execute the plan, and a
 * terminal must return the same thing whether or not it was called. The
 * guarantee is pinned by `__tests__/query-explain.test.ts`
 * ("results are identical whether or not explain() was called").
 *
 * ⚠️ DISPATCH SELECTION IS MIRRORED, NOT SHARED. `indexDispatchFor` below
 * reproduces `candidateRecords()` in `builder.ts` — deliberately, so this
 * file stays out of the executor's way. That mirror is not left to trust:
 * the index path never calls `source.snapshot()` and the scan path always
 * does, so a snapshot-call counter is an executor-side witness of dispatch,
 * and the suite asserts the two agree. **A new index kind must land in BOTH
 * places** — a branch here and the matching branch in `candidateRecords` —
 * plus a label on {@link ExplainDispatch}.
 */

import type { Clause } from './predicate.js'
import type { QueryPlan } from './builder.js'
import { DEFAULT_CROSS_JOIN_MAX_ROWS } from './builder.js'
import type { JoinContext, JoinLeg } from './join.js'
import { DEFAULT_JOIN_MAX_ROWS, joinsDropLeftRows, orderReferencesJoinAlias, splitAroundJoins } from './join.js'
import type { ViaPipeline } from '../via/pipeline.js'

/**
 * How a node is executed. An OPEN label set on purpose — a consumer reads
 * these as strings, so a build that knows a dispatch this one does not still
 * type-checks. Only `index:hash` and `scan` exist on this base; a new index
 * kind (a sorted/range index serving `<`/`>`/`between`, or an ordered-index
 * scan that satisfies `orderBy(...).limit(n)` without sorting) adds its label
 * here and its branch in {@link indexDispatchFor} — an ordered scan
 * additionally replaces the `sort` node's dispatch. No consumer shape moves.
 */
export type ExplainDispatch =
  | 'source'
  | 'index:hash'
  | 'scan'
  | 'join:nested'
  | 'join:hash'
  | 'join:reverse-index'
  | 'crossJoin'
  | 'sort'
  | 'page'
  // Keeps the labels above as autocomplete hints while leaving the type open
  // for a dispatch this build does not know about yet.
  | (string & {})

/** One line of the plan. */
export interface ExplainNode {
  /** Pipeline stage: 'source' | 'where' | 'group' | 'filter' | 'wherePredicate' | 'crossJoin' | 'join' | 'orderBy' | 'page'. */
  readonly op: string
  /** How this stage runs. */
  readonly dispatch: ExplainDispatch
  /** One-line, no-op-prefix description, e.g. `status == "open"`. */
  readonly detail: string
  /**
   * Rows this stage is expected to emit. Exact where an index or a snapshot
   * size supplies it; an upper bound (carried through unchanged) where only a
   * scan can answer — the accompanying note says which.
   */
  readonly estimatedRows: number | undefined
  /** Why this dispatch, and anything about to trip. */
  readonly notes: readonly string[]
  /** Sub-clauses of an `and`/`or` group. Empty for every other node. */
  readonly children: readonly ExplainNode[]
}

/** A cardinality ceiling this plan runs against. */
export interface ExplainCap {
  /** e.g. `join:client:right`, `crossJoin:lines`. */
  readonly name: string
  /** The ceiling that would throw. */
  readonly limit: number
  /** The size measured (or estimated) against it. */
  readonly observed: number
  /** `warn` mirrors the executor's 80%-of-ceiling warning; `exceeded` would throw. */
  readonly status: 'ok' | 'warn' | 'exceeded'
}

/** The result of {@link explainPlan}. */
export interface QueryExplanation {
  /** The plan tree, in execution order. */
  readonly nodes: readonly ExplainNode[]
  /** Every cardinality ceiling this plan runs against. */
  readonly caps: readonly ExplainCap[]
  /**
   * Fields this query references whose Via binding rewrites aggregate
   * reducers — money's exact-BigInt sum being the one that ships. Applies to
   * `.aggregate()`/`.groupBy()` over these fields, not to the row pipeline.
   */
  readonly reducerRewrite: readonly { readonly brand: string; readonly field: string }[]
  /** One line per node, depth-indented. Stable for a given plan. */
  readonly text: string
}

/**
 * The slice of a query source `explain()` reads. Structurally satisfied by
 * the builder's internal source; declared here so this module does not
 * depend on the builder's non-exported types.
 */
export interface ExplainSource {
  snapshot(): readonly unknown[]
  getIndexes?(): ExplainIndexProbe | null
  lookupById?(id: string): unknown
  via?: ViaPipeline
}

/**
 * The index-store surface `explain()` probes. Declared structurally rather
 * than importing `CollectionIndexes`: the kernel spine may not statically
 * reach a `with-*` service (`check:architecture`'s port-layering gate), and
 * every method here is a pure read. `CollectionIndexes` satisfies it.
 */
export interface ExplainIndexProbe {
  has(field: string): boolean
  fields(): string[]
  lookupEqual(field: string, value: unknown): ReadonlySet<string> | null
  lookupIn(field: string, values: readonly unknown[]): ReadonlySet<string> | null
}

/** Mirrors join.ts's `JOIN_WARN_FRACTION`. */
const WARN_FRACTION = 0.8

/**
 * Which clause (if any) the index serves, and under which dispatch label.
 *
 * Mirrors `candidateRecords()` in `builder.ts` — including its Via caveat
 * (a covered clause with no `indexValue` probe is not index-eligible) and
 * its "first eligible clause wins" rule. See this file's header for why it
 * is a mirror and how the mirror is policed.
 */
function indexDispatchFor(
  source: ExplainSource,
  clauses: readonly Clause[],
): { readonly clauseIndex: number; readonly dispatch: ExplainDispatch; readonly rows: number } | null {
  const indexes = source.getIndexes?.()
  if (!indexes || !source.lookupById || clauses.length === 0) return null

  for (let i = 0; i < clauses.length; i++) {
    const clause = clauses[i]!
    if (clause.type !== 'field') continue
    if (!indexes.has(clause.field)) continue
    if (clause.via && clause.via.indexValue === undefined) continue
    const probeValue = clause.via ? clause.via.indexValue : clause.value

    let ids: ReadonlySet<string> | null = null
    if (clause.op === '==') {
      ids = indexes.lookupEqual(clause.field, probeValue)
    } else if (clause.op === 'in' && Array.isArray(probeValue)) {
      ids = indexes.lookupIn(clause.field, probeValue)
    }
    if (ids !== null) return { clauseIndex: i, dispatch: 'index:hash', rows: ids.size }
  }
  return null
}

/** `op`-free one-line description of a clause. */
function describeClause(clause: Clause): { op: string; detail: string } {
  switch (clause.type) {
    case 'field': {
      // #1351: an `in`/`!in` operand that came from a SUBQUERY is already a
      // resolved id array by the time explain() sees it, and printing 400 ids
      // is not a readable plan. Name the inner source and the set size — the
      // sentence a reader is after is "the inner query ran once, it produced
      // N ids, and the outer clause is index-served off them".
      const detail =
        clause.subquery !== undefined
          ? `${clause.field} ${clause.op} subquery(${clause.subquery.from}) → ${clause.subquery.ids} ids`
          : `${clause.field} ${clause.op} ${formatValue(clause.value)}`
      return { op: 'where', detail }
    }
    case 'group':
      return { op: 'group', detail: `${clause.op} (${clause.clauses.length} clause${clause.clauses.length === 1 ? '' : 's'})` }
    case 'filter':
      return { op: 'filter', detail: 'fn' }
    case 'wherePredicate':
      return { op: 'wherePredicate', detail: clause.name }
    case 'crossJoin':
      // #1289 — a `crossJoinWith` clause names BOTH sides, because the row it
      // emits has no top level to fall back on. `leftAs x rightAs` is the
      // shape the caller reads back; `as x target` is the asymmetric one.
      return {
        op: clause.leftAs === undefined ? 'crossJoin' : 'crossJoinWith',
        detail:
          (clause.leftAs === undefined
            ? `${clause.as} x ${clause.target}`
            : `${clause.leftAs} x ${clause.as} (self ${clause.target})`) +
          `${clause.on ? ' on fn' : ''}${clause.outer === true ? ' outer' : ''}`,
      }
  }
}

/** Compact, deterministic operand rendering. Never throws. */
function formatValue(value: unknown): string {
  if (typeof value === 'bigint') return `${value.toString()}n`
  try {
    const json = JSON.stringify(value)
    return json === undefined ? String(value) : json
  } catch {
    return '[unserializable]'
  }
}

/** Field paths this query mentions — clause fields plus orderBy fields. */
function referencedFields(plan: QueryPlan): string[] {
  const out: string[] = []
  const walk = (clauses: readonly Clause[]): void => {
    for (const c of clauses) {
      if (c.type === 'field') out.push(c.field)
      else if (c.type === 'group') walk(c.clauses)
    }
  }
  walk(plan.clauses)
  for (const o of plan.orderBy) out.push(o.field)
  return [...new Set(out)]
}

function capStatus(observed: number, limit: number): ExplainCap['status'] {
  if (observed > limit) return 'exceeded'
  if (observed > limit * WARN_FRACTION) return 'warn'
  return 'ok'
}

/** Build the explanation for a plan. Reads sizes and index buckets; runs nothing. */
export function explainPlan(
  source: ExplainSource,
  plan: QueryPlan,
  joinContext?: JoinContext,
): QueryExplanation {
  const nodes: ExplainNode[] = []
  const caps: ExplainCap[] = []

  const indexes = source.getIndexes?.() ?? null
  const indexedFields = indexes ? indexes.fields() : []
  const sourceRows = source.snapshot().length
  let rows: number | undefined = sourceRows

  const reducerRewrite = collectReducerRewrites(source.via, referencedFields(plan))
  const sourceNotes: string[] = []
  for (const r of reducerRewrite) {
    sourceNotes.push(`reducer rewrite: ${r.brand}("${r.field}")`)
  }

  nodes.push({
    op: 'source',
    dispatch: 'source',
    detail: indexedFields.length > 0 ? `snapshot (indexes: ${indexedFields.join(', ')})` : 'snapshot (no indexes)',
    estimatedRows: sourceRows,
    notes: sourceNotes,
    children: [],
  })

  const hasCrossJoin = plan.clauses.some(c => c.type === 'crossJoin')
  const { preJoin, postJoin } = splitAroundJoins(plan.clauses, plan.joins)

  if (hasCrossJoin) {
    // A crossJoin plan runs through `executeClausePipeline`, which starts from
    // the full snapshot — the index fast path is not on that road at all.
    for (const clause of plan.clauses) {
      if (clause.type === 'crossJoin') {
        const rightRows = joinContext?.resolveSource(clause.target)?.snapshot().length
        const limit = clause.maxRows ?? DEFAULT_CROSS_JOIN_MAX_ROWS
        const product: number | undefined =
          rows !== undefined && rightRows !== undefined ? rows * rightRows : undefined
        const { op, detail } = describeClause(clause)
        const notes: string[] = [
          rightRows === undefined ? 'right side unresolved' : `right side ${rightRows} rows`,
          `cap ${limit}`,
        ]
        nodes.push({ op, dispatch: 'crossJoin', detail, estimatedRows: product, notes, children: [] })
        if (product !== undefined) {
          caps.push({ name: `crossJoin:${clause.as}`, limit, observed: product, status: capStatus(product, limit) })
        }
        rows = product
      } else {
        nodes.push(scanNode(clause, rows, ['index fast path unavailable: the plan carries a crossJoin']))
      }
    }
  } else {
    const pick = indexDispatchFor(source, preJoin)
    preJoin.forEach((clause, i) => {
      if (pick && pick.clauseIndex === i) {
        const { op, detail } = describeClause(clause)
        rows = pick.rows
        nodes.push({ op, dispatch: pick.dispatch, detail, estimatedRows: rows, notes: [], children: [] })
        return
      }
      nodes.push(scanNode(clause, rows, scanReason(clause, indexes, pick !== null)))
    })
  }

  // Join legs, then — only when a predicate addresses an alias — the post-join
  // filter. Mirrors `Query.toArray()`: with no post-join clause the legs are
  // applied AFTER ordering and pagination, so they are emitted last below.
  const emitJoins = (): void => {
    for (const leg of plan.joins) {
      nodes.push(joinNode(leg, joinContext, rows, caps))
    }
  }

  // #1337 — an ordering that addresses an alias moves the sort/page after the
  // legs, exactly as a post-join predicate does. The decision is read from the
  // same two helpers `Query.toArray()` routes on, so `explain()` cannot report
  // a placement the executor does not use.
  const orderPostJoin = orderReferencesJoinAlias(plan.orderBy, plan.joins)
  const runsPostJoin = postJoin.length > 0 || orderPostJoin
  // #1361 — an inner leg splits the placement: the SORT stays pre-join (the
  // drop cannot reorder a left-side key) but the PAGE moves behind the legs,
  // because a limit must observe the rows that were dropped. Reported as two
  // words rather than one, because `toArray()` runs it as two steps.
  const innerSplit = !runsPostJoin && plan.joins.length > 0 && joinsDropLeftRows(plan.joins)

  if (runsPostJoin) {
    emitJoins()
    for (const clause of postJoin) {
      nodes.push(scanNode(clause, rows, ['post-join: addresses a join alias, so no index can serve it']))
    }
  }

  const placement = plan.joins.length === 0 ? undefined : runsPostJoin ? 'post-join' : 'pre-join'

  if (plan.orderBy.length > 0) {
    nodes.push({
      op: 'orderBy',
      dispatch: 'sort',
      detail: plan.orderBy.map(o => `${o.field} ${o.direction}${o.by === 'label' ? ' by label' : ''}`).join(', '),
      estimatedRows: rows,
      notes: placement ? [placement] : [],
      children: [],
    })
  }

  if (innerSplit) emitJoins()

  if (plan.offset > 0 || plan.limit !== undefined) {
    const afterOffset = rows === undefined ? undefined : Math.max(0, rows - plan.offset)
    const paged =
      afterOffset === undefined ? undefined : plan.limit === undefined ? afterOffset : Math.min(afterOffset, plan.limit)
    nodes.push({
      op: 'page',
      dispatch: 'page',
      detail: `offset=${plan.offset} limit=${plan.limit ?? 'none'}`,
      estimatedRows: paged,
      notes: innerSplit ? ['post-join'] : placement ? [placement] : [],
      children: [],
    })
    rows = paged
  }

  if (!runsPostJoin && !innerSplit) emitJoins()

  return { nodes, caps, reducerRewrite, text: renderText(nodes) }
}

/** Why this clause fell to a scan — the sentence a consumer is actually after. */
function scanReason(clause: Clause, indexes: ExplainIndexProbe | null, indexAlreadyUsed: boolean): string[] {
  if (indexAlreadyUsed) {
    const residual = 'residual: an earlier clause is already index-served'
    // Still name a missing index — that is the sentence a consumer acts on,
    // and it stays true regardless of which clause won the fast path.
    return clause.type === 'field' && indexes !== null && !indexes.has(clause.field)
      ? [residual, `no index on "${clause.field}"`]
      : [residual]
  }
  if (clause.type !== 'field') return [`${clause.type} clauses are never index-served`]
  if (!indexes) return ['linear scan: no index store on this source']
  if (!indexes.has(clause.field)) return [`linear scan: no index on "${clause.field}"`]
  if (clause.op !== '==' && clause.op !== 'in') {
    return [`linear scan: the hash index on "${clause.field}" serves == and in only, not ${clause.op}`]
  }
  return [`linear scan: the index on "${clause.field}" could not serve this operand`]
}

function scanNode(clause: Clause, rows: number | undefined, notes: readonly string[]): ExplainNode {
  const { op, detail } = describeClause(clause)
  return {
    op,
    dispatch: 'scan',
    detail,
    estimatedRows: rows,
    notes: [...notes, ...(rows === undefined ? [] : ['estimate is an upper bound'])],
    children:
      clause.type === 'group'
        ? clause.clauses.map(c => scanNode(c, rows, ['inside a group: evaluated per record']))
        : [],
  }
}

function joinNode(
  leg: JoinLeg,
  joinContext: JoinContext | undefined,
  leftRows: number | undefined,
  caps: ExplainCap[],
): ExplainNode {
  const right = leg.isDictJoin === true ? joinContext?.resolveDictSource?.(leg.field) : joinContext?.resolveSource(leg.target)
  const rightRows = right?.snapshot().length
  const strategy = leg.strategy ?? (right?.lookupById ? 'nested' : 'hash')
  const limit = leg.maxRows ?? DEFAULT_JOIN_MAX_ROWS

  // #1289 — a right/full leg does not run the forward strategy at all: it
  // builds a reverse index over the left rows and drives off the right
  // snapshot. Reporting `join:nested` for it would name a path that never
  // executes, so the dispatch and the detail both say which join this is.
  const direction = leg.direction ?? 'left'
  const notes: string[] = [
    rightRows === undefined ? 'right side unresolved' : `right side ${rightRows} rows`,
    `cap ${limit}`,
    `ref mode ${leg.mode}`,
  ]
  if (direction !== 'left') {
    notes.push('reverse index over the left rows; right snapshot drives')
  }
  if (leg.inner === true) {
    notes.push('inner: unmatched left rows are dropped, so the estimate is an upper bound')
  }
  if (leg.strategy !== undefined) notes.push('strategy overridden by the caller')

  if (leftRows !== undefined) {
    caps.push({ name: `join:${leg.as}:left`, limit, observed: leftRows, status: capStatus(leftRows, limit) })
  }
  if (rightRows !== undefined) {
    caps.push({ name: `join:${leg.as}:right`, limit, observed: rightRows, status: capStatus(rightRows, limit) })
  }

  // The direction is appended ONLY for a right/full leg. A left leg's detail
  // stays byte-identical to what it rendered before #1289: `.join()` is the
  // left outer join and always was, so labelling it now would churn every
  // consumer's `explain().text` to say nothing new.
  const label = direction === 'left' ? '' : direction === 'right' ? ' right outer' : ' full outer'
  // Row estimate: a LEFT leg is projection-only — it attaches an alias and
  // never filters, so the count passes through. A right/full leg reshapes the
  // relation (a row per unreferenced right record; for 'right', the unmatched
  // left rows drop), so the left count is no longer the answer and the only
  // honest bound without executing is left + right.
  const estimatedRows =
    direction === 'left'
      ? leftRows
      : leftRows === undefined || rightRows === undefined
        ? undefined
        : leftRows + rightRows

  return {
    op: 'join',
    dispatch: direction === 'left' ? `join:${strategy}` : 'join:reverse-index',
    detail: `${leg.as} <- ${leg.field} (${leg.target})${label}`,
    estimatedRows,
    notes,
    children: [],
  }
}

/** Money today: any binding that rewrites reducers and covers a referenced field. */
function collectReducerRewrites(
  via: ViaPipeline | undefined,
  fields: readonly string[],
): { readonly brand: string; readonly field: string }[] {
  if (!via) return []
  const out: { brand: string; field: string }[] = []
  for (const field of fields) {
    for (const binding of via.bindings) {
      if (binding.wrapReducers && binding.covers?.(field) === true) out.push({ brand: binding.brand, field })
    }
  }
  return out
}

/** One line per node, two spaces per level of depth. */
function renderText(nodes: readonly ExplainNode[]): string {
  const lines: string[] = []
  const walk = (ns: readonly ExplainNode[], depth: number): void => {
    for (const n of ns) {
      const rows = n.estimatedRows === undefined ? '' : ` rows=${n.estimatedRows}`
      const notes = n.notes.length > 0 ? ` -- ${n.notes.join('; ')}` : ''
      lines.push(`${'  '.repeat(depth)}${n.op} ${n.detail} [${n.dispatch}]${rows}${notes}`)
      walk(n.children, depth + 1)
    }
  }
  walk(nodes, 0)
  return lines.join('\n')
}
