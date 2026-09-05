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
 *
 * ⭐ #1375 — THE MIRROR IS NOW POLICED EXHAUSTIVELY, and that is the durable
 * half of the fix. `__tests__/query-explain.test.ts` carries a TABLE of query
 * shapes spanning every dispatch kind and asserts, for each, that the label
 * `explain()` claims agrees with an executor-side observation. Add a shape to
 * that table when you add an index kind, and a kind that forgets this file
 * fails a test instead of silently reporting the previous era's answer — which
 * is exactly what #1344 and #1345 did to the pre-#1344 `explain()`.
 *
 * ⚠️ The observation is "did the executor READ RECORDS OUT OF the snapshot",
 * not "did it CALL `snapshot()`". #1344's `orderedIndexRows` and #1345's
 * `compoundCandidates` both call `snapshot()` for their coverage check and
 * read only its `.length`, so the original call-counter witness would now
 * report a scan for two paths that never touch a record.
 */

import type { Clause } from './predicate.js'
import type { QueryPlan } from './builder.js'
import {
  DEFAULT_CROSS_JOIN_MAX_ROWS,
  indexableClauses,
  isRangeOperator,
  pickCompound,
  pickCompoundOrder,
  viaOrdersField,
} from './builder.js'
import type { JoinContext, JoinLeg } from './join.js'
import { DEFAULT_JOIN_MAX_ROWS, joinsDropLeftRows, orderReferencesJoinAlias, splitAroundJoins } from './join.js'
import { describeJoinOn, joinOnDispatch } from './join-on.js'
import type { ViaPipeline } from '../via/pipeline.js'
import { isViaPrefixProbe } from '../via/index.js'

/**
 * How a node is executed. An OPEN label set on purpose — a consumer reads
 * these as strings, so a build that knows a dispatch this one does not still
 * type-checks. A new index kind adds its label here, its branch in
 * {@link indexDispatchFor} (or {@link orderedIndexPick} when it replaces the
 * `sort` node's dispatch), AND a row in the witness table named in this file's
 * header. No consumer shape moves.
 */
export type ExplainDispatch =
  | 'source'
  | 'index:hash'
  /** #1344 — a sorted index served `<` `<=` `>` `>=` `between` `startsWith`. */
  | 'index:range'
  /** #1345 — a compound tuple served an equality prefix (+ an optional range). */
  | 'index:compound'
  /**
   * #1355 — a sorted index served a UNION of `startsWith` slices named by a
   * Via binding's prefix probe (`geo()`'s `near`). Unlike every other index
   * label, the clause is NOT consumed: the cover is a superset and the
   * binding's predicate still runs over the candidates, so `estimatedRows`
   * here is the candidate count, not the answer's.
   */
  | 'index:prefix'
  /**
   * #1344 / #1345 — an ordered index walk answered `orderBy(f).limit(n)`
   * outright: no sort runs, and only the page's worth of records is read.
   */
  | 'index:ordered'
  | 'scan'
  | 'join:nested'
  | 'join:hash'
  | 'join:reverse-index'
  /** #1339 — a declared composite `on`, hashed over a tuple key. */
  | 'join:composite-hash'
  /** #1339 — a declared range `on`, nested-loop over a sorted right side. */
  | 'join:sorted-range'
  | 'crossJoin'
  | 'sort'
  | 'page'
  /**
   * #1342 — a partitioned union read every declared partition, because the
   * predicate proved no narrowing. The SOUND default: everything that is not
   * on `resolvePartitionScope`'s whitelist lands here.
   */
  | 'partitions:all'
  /**
   * #1342 — a top-level AND-ed `==`/`in` on the declared partition key
   * narrowed the set, so the excluded members were never asked for.
   *
   * ⚠️ Unlike every other label in this union, this one is NOT decided in
   * this file. `resolvePartitionScope` (`query/partition.ts`) is called by
   * the executor and by `explain()`, so there is nothing to keep in step —
   * see that module's header for why a third mirror site was refused.
   */
  | 'partitions:pruned'
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
  /**
   * #1414/#1421 — the cold-collection gate. `explain()` is the one terminal
   * that stays answerable while unhydrated (a diagnostic that refuses to
   * diagnose is useless), so it carries the distinction instead: a snapshot
   * of zero rows because nothing has been loaded is NOT the same fact as a
   * snapshot of zero rows because the collection is empty, and only the
   * second one is safe to act on.
   */
  hydration?: { isHydrated(): boolean }
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
  // ── #1375: the dispatch surface #1344 and #1345 added ──────────────────
  // OPTIONAL, every one of them. A probe that predates a kind simply cannot
  // serve it, which is the honest answer and the one this file already gives
  // for a source with no index store at all — never a crash on a build whose
  // index store is older than this module.
  /** #1344 — does a SORTED index cover this field? */
  hasSorted?(field: string): boolean
  /** #1344 — entry count of the sorted index; compare against the snapshot. */
  sortedSize?(field: string): number
  /** #1344 — ids satisfying a range operator, or `null` when unserved. */
  lookupRange?(field: string, op: string, value: unknown): ReadonlySet<string> | null
  /** #1344 — every indexed id in field order, or `null` when unserved. */
  orderedIds?(field: string, direction: 'asc' | 'desc'): readonly string[] | null
  /** #1345 — declared field tuples, in declaration order. */
  compoundTuples?(): ReadonlyArray<readonly string[]>
  /** #1345 — records the tuple's index holds; compare against the snapshot. */
  compoundSize?(fields: readonly string[]): number
  /** #1345 — ids for an equality prefix, optionally narrowed by a range. */
  lookupCompound?(
    fields: readonly string[],
    prefixValues: readonly unknown[],
    range?: { readonly op: string; readonly value: unknown },
  ): ReadonlySet<string> | null
  /** #1345 — an equality prefix ordered by the remaining component. */
  compoundOrderedIds?(
    fields: readonly string[],
    prefixValues: readonly unknown[],
    direction: 'asc' | 'desc',
  ): readonly string[] | null
}

/** Mirrors join.ts's `JOIN_WARN_FRACTION`. */
const WARN_FRACTION = 0.8

/** Which clauses an index consumed, and the label each of their nodes carries. */
interface ClauseDispatchPick {
  readonly consumed: ReadonlyMap<number, ExplainDispatch>
  /** Cardinality of the candidate set the index produced. */
  readonly rows: number
}

/** A `CompoundTupleSource` view of a probe whose compound half may be absent. */
function tupleSourceOf(indexes: ExplainIndexProbe): { compoundTuples(): ReadonlyArray<readonly string[]> } {
  return { compoundTuples: () => indexes.compoundTuples?.() ?? [] }
}

/**
 * Which clauses (if any) the index serves, and under which dispatch labels.
 *
 * Mirrors `candidateRecords()` in `builder.ts` — its compound-first ordering
 * (#1345), its range arm (#1344), its Via caveat (a covered clause with no
 * `indexValue` probe is not index-eligible, and a Via-covered RANGE is never
 * index-served because `indexProbe` yields an equality operand only), and its
 * "first eligible clause wins" rule. See this file's header for why it is a
 * mirror and how the mirror is policed.
 */
function indexDispatchFor(source: ExplainSource, clauses: readonly Clause[]): ClauseDispatchPick | null {
  const indexes = source.getIndexes?.()
  if (!indexes || !source.lookupById || clauses.length === 0) return null

  // #1345 — `candidateRecords()` tries the compound arm FIRST, because an
  // equality prefix removes more clauses from the plan than any single-clause
  // choice below. Reporting the single-clause answer here would name a path
  // the executor did not take even though both are index paths.
  const compound = compoundDispatchFor(source, indexes, clauses)
  if (compound) return compound

  // #1355 — mirrors `prefixCandidates()`, ordering included.
  const prefixed = prefixDispatchFor(indexes, clauses)
  if (prefixed) return prefixed

  for (let i = 0; i < clauses.length; i++) {
    const clause = clauses[i]!
    if (clause.type !== 'field') continue
    if (!indexes.has(clause.field) && indexes.hasSorted?.(clause.field) !== true) continue
    if (clause.via && clause.via.indexValue === undefined) continue
    const probeValue = clause.via ? clause.via.indexValue : clause.value

    let ids: ReadonlySet<string> | null = null
    let dispatch: ExplainDispatch = 'index:hash'
    if (clause.op === '==') {
      ids = indexes.lookupEqual(clause.field, probeValue)
    } else if (clause.op === 'in' && Array.isArray(probeValue)) {
      ids = indexes.lookupIn(clause.field, probeValue)
    } else if (clause.via === undefined && isRangeOperator(clause.op)) {
      // #1344 — `null` both when no sorted index covers the field and when
      // this build's probe predates the method.
      ids = indexes.lookupRange?.(clause.field, clause.op, clause.value) ?? null
      dispatch = 'index:range'
    }
    if (ids !== null) return { consumed: new Map([[i, dispatch]]), rows: ids.size }
  }
  return null
}

/**
 * #1355 — mirrors `prefixCandidates()`. The clause is labelled even though
 * the executor does not consume it: the index really did produce the
 * candidate set, and reporting `scan` for a path that never walks the
 * snapshot is exactly the disagreement the witness table exists to catch.
 */
function prefixDispatchFor(indexes: ExplainIndexProbe, clauses: readonly Clause[]): ClauseDispatchPick | null {
  for (let i = 0; i < clauses.length; i++) {
    const clause = clauses[i]!
    if (clause.type !== 'field' || clause.via === undefined) continue
    const probe = clause.via.indexValue
    if (!isViaPrefixProbe(probe)) continue
    if (indexes.hasSorted?.(clause.field) !== true) continue
    const ids = new Set<string>()
    for (const prefix of probe.prefixes) {
      const hit = indexes.lookupRange?.(clause.field, 'startsWith', prefix) ?? null
      if (hit === null) return null
      for (const id of hit) ids.add(id)
    }
    return { consumed: new Map([[i, 'index:prefix' as ExplainDispatch]]), rows: ids.size }
  }
  return null
}

/** #1345 — mirrors `compoundCandidates()`, coverage guard included. */
function compoundDispatchFor(
  source: ExplainSource,
  indexes: ExplainIndexProbe,
  clauses: readonly Clause[],
): ClauseDispatchPick | null {
  const pick = pickCompound(tupleSourceOf(indexes), clauses)
  if (!pick) return null
  // An under-covering tuple index would silently drop matching records, so the
  // executor declines it — and so must this.
  if (indexes.compoundSize?.(pick.fields) !== source.snapshot().length) return null
  const ids = indexes.lookupCompound?.(pick.fields, pick.values, pick.range) ?? null
  if (!ids) return null
  const consumed = new Map<number, ExplainDispatch>()
  for (const at of pick.consumed) consumed.set(at, 'index:compound')
  return { consumed, rows: ids.size }
}

/** An ordered-index walk that answers `orderBy(f).limit(n)` outright. */
interface OrderedPick {
  readonly rows: number
  /** Label for the clause nodes the compound walk also consumed; `null` when there are none. */
  readonly clauseDispatch: ExplainDispatch | null
  /** Which of the two walks ran, for the node's note. */
  readonly detail: string
}

/**
 * #1344 / #1345 — mirrors `orderedIndexRows() ?? compoundOrderedRows()`, the
 * pair `executePlanWithSource` tries BEFORE `candidateRecords()`. Both return
 * the page directly: no sort runs, and `offset`/`limit` are consumed by the
 * index walk rather than by a slice.
 *
 * Every guard the executor carries is repeated here, because each one is a
 * case where the two answers would otherwise disagree — the coverage checks in
 * particular (`sortedSize` / `compoundSize` against the snapshot size), which
 * is the whole reason a partial index does not take these paths.
 */
function orderedIndexPick(source: ExplainSource, plan: QueryPlan): OrderedPick | null {
  const limit = plan.limit
  if (limit === undefined || plan.orderBy.length !== 1) return null
  const [order] = plan.orderBy
  if (!order || order.by === 'label') return null
  const indexes = source.getIndexes?.()
  if (!indexes || !source.lookupById) return null
  if (viaOrdersField(source.via, order.field)) return null
  const snapshotRows = source.snapshot().length

  if (plan.clauses.length === 0) {
    if (indexes.hasSorted?.(order.field) !== true) return null
    if (indexes.sortedSize?.(order.field) !== snapshotRows) return null
    const ids = indexes.orderedIds?.(order.field, order.direction) ?? null
    if (!ids) return null
    return { rows: pageOf(ids.length, plan.offset, limit), clauseDispatch: null, detail: `sorted index on "${order.field}"` }
  }

  const { eq } = indexableClauses(plan.clauses)
  if (eq.size !== plan.clauses.length) return null
  const match = pickCompoundOrder(tupleSourceOf(indexes), eq, order.field)
  if (!match) return null
  if (indexes.compoundSize?.(match.fields) !== snapshotRows) return null
  const ids = indexes.compoundOrderedIds?.(match.fields, match.values, order.direction) ?? null
  if (!ids) return null
  return {
    rows: pageOf(ids.length, plan.offset, limit),
    clauseDispatch: 'index:compound',
    detail: `compound index on (${match.fields.join(', ')})`,
  }
}

function pageOf(total: number, offset: number, limit: number): number {
  return Math.min(Math.max(0, total - offset), limit)
}

/**
 * Does this dispatch hand back a CANDIDATE set that the clause still filters,
 * rather than the answer?
 *
 * `index:range` is the one index label that is exact — `lookupRange` is served
 * by the sorted index, whose comparisons are the scan's own (#1344, measured
 * on #1415: `!=`, `startsWith` and the range operators never disagreed).
 */
function isSupersetDispatch(dispatch: ExplainDispatch, clause: Clause): boolean {
  if (dispatch === 'index:prefix' || dispatch === 'index:compound') return true
  if (dispatch !== 'index:hash') return false
  return clause.type === 'field' && (clause.op === '==' || clause.op === 'in')
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
  // #1414 — say WHY the snapshot is empty. `rows: 0` on an unhydrated
  // collection is an absence of data in memory, not an absence of records.
  const notHydrated = source.hydration?.isHydrated() === false
  if (notHydrated) {
    sourceNotes.push(
      'collection not hydrated — this plan\'s row estimates are not authoritative; ' +
        'call `await collection.list()` / `await collection.get(id)` first',
    )
  }
  for (const r of reducerRewrite) {
    sourceNotes.push(`reducer rewrite: ${r.brand}("${r.field}")`)
  }

  nodes.push({
    op: 'source',
    dispatch: 'source',
    detail: notHydrated
      ? `snapshot (NOT HYDRATED — nothing has been read yet${indexedFields.length > 0 ? `; indexes: ${indexedFields.join(', ')}` : ''})`
      : indexedFields.length > 0 ? `snapshot (indexes: ${indexedFields.join(', ')})` : 'snapshot (no indexes)',
    estimatedRows: sourceRows,
    notes: sourceNotes,
    children: [],
  })

  const hasCrossJoin = plan.clauses.some(c => c.type === 'crossJoin')
  const { preJoin, postJoin } = splitAroundJoins(plan.clauses, plan.joins)

  // #1337 — an ordering that addresses an alias moves the sort/page after the
  // legs, exactly as a post-join predicate does. #1361 — an inner leg moves
  // only the page. Both decisions are read from the same helpers
  // `Query.toArray()` routes on, so `explain()` cannot report a placement the
  // executor does not use. They are computed HERE, ahead of the clause nodes,
  // because they also decide whether the ordered-index walk is reachable at
  // all: on either reordered path `toArray()` hands the executor a plan with
  // `orderBy: []` / `limit: undefined`, and #1344's fast path declines it.
  const orderPostJoin = orderReferencesJoinAlias(plan.orderBy, plan.joins)
  const runsPostJoin = postJoin.length > 0 || orderPostJoin
  const innerSplit = !runsPostJoin && plan.joins.length > 0 && joinsDropLeftRows(plan.joins)
  let ordered: OrderedPick | null = null

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
    ordered = runsPostJoin || innerSplit ? null : orderedIndexPick(source, plan)
    const pick = ordered ? null : indexDispatchFor(source, preJoin)
    if (ordered) rows = ordered.rows
    preJoin.forEach((clause, i) => {
      const dispatch = ordered ? ordered.clauseDispatch : (pick?.consumed.get(i) ?? null)
      if (dispatch !== null) {
        const { op, detail } = describeClause(clause)
        if (pick) rows = pick.rows
        // Index labels whose clause is NOT consumed. Say so, or
        // `estimatedRows` reads as the answer's size when it is the candidate
        // set's.
        //
        // #1355 started this list with `index:prefix`. #1415 and #1425 then
        // added the equality arms for the same reason from the other end: a
        // hash bucket and a tuple match are both supersets (bucket keys
        // collapse `1`/`'1'`, tuple keys collapse two Dates at one instant),
        // so those clauses stay in the plan and re-filter the candidates.
        // ⚠️ Keeping this list in step is not cosmetic — an explain that says
        // "consumed" for a clause the executor still evaluates is precisely
        // #1375's mirror defect, and it is how a superset arm looks correct.
        const notes = isSupersetDispatch(dispatch, clause)
          ? [`${dispatch === 'index:prefix' ? 'prefix cover' : 'index match'} is a superset: the clause still filters the candidates exactly`]
          : []
        nodes.push({ op, dispatch, detail, estimatedRows: rows, notes, children: [] })
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

  if (runsPostJoin) {
    emitJoins()
    for (const clause of postJoin) {
      nodes.push(scanNode(clause, rows, ['post-join: addresses a join alias, so no index can serve it']))
    }
  }

  const placement = plan.joins.length === 0 ? undefined : runsPostJoin ? 'post-join' : 'pre-join'

  if (plan.orderBy.length > 0) {
    // #1375 — when an ordered index answers the plan there is no sort at all:
    // the walk emits the page in index order. Labelling it `sort` is the
    // sentence a consumer would act on by adding the index they already have.
    const orderNotes = placement ? [placement] : []
    if (ordered) orderNotes.push(`ordered index page off the ${ordered.detail}: no sort runs`)
    nodes.push({
      op: 'orderBy',
      dispatch: ordered ? 'index:ordered' : 'sort',
      detail: plan.orderBy.map(o => `${o.field} ${o.direction}${o.by === 'label' ? ' by label' : ''}`).join(', '),
      estimatedRows: rows,
      notes: orderNotes,
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
      notes: [
        ...(innerSplit ? ['post-join'] : placement ? [placement] : []),
        ...(ordered ? ['consumed by the ordered index walk; no rows are materialized past the page'] : []),
      ],
      children: [],
    })
    rows = paged
  }

  if (!runsPostJoin && !innerSplit) emitJoins()

  return { nodes, caps, reducerRewrite, text: renderExplainText(nodes) }
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
  const sorted = indexes.hasSorted?.(clause.field) === true
  if (!indexes.has(clause.field) && !sorted) return [`linear scan: no index on "${clause.field}"`]
  if (clause.op !== '==' && clause.op !== 'in') {
    // #1375 — a range operator IS index-servable now, but only off a SORTED
    // index. Naming which kind is missing is the sentence a consumer acts on;
    // the pre-#1344 wording said "== and in only" even where the fix is to
    // declare `kind: 'sorted'`.
    if (!isRangeOperator(clause.op)) {
      return [`linear scan: no index serves ${clause.op} on "${clause.field}"`]
    }
    if (!sorted) {
      return [
        `linear scan: the hash index on "${clause.field}" serves == and in only — ` +
          `declare a sorted index on it to serve ${clause.op}`,
      ]
    }
    if (clause.via !== undefined) {
      return [`linear scan: "${clause.field}" is Via-covered, and a Via range operand is evaluated per record`]
    }
    return [`linear scan: the sorted index on "${clause.field}" could not order this operand`]
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

  // #1339 — a declared `on` runs neither forward strategy nor the reverse
  // index, and it is the only join here that can EXPAND the relation, so both
  // the dispatch and the estimate have to say so rather than passing the left
  // count through as `.join()` legitimately does.
  if (leg.on !== undefined) {
    // `ref mode` is meaningless here and actively misleading: a declared join
    // has no ref(), so the leg's `'cascade'` is a placeholder that satisfies
    // the shared `JoinLeg` type, not a policy anything applies.
    notes.splice(notes.findIndex(n => n.startsWith('ref mode')), 1)
    notes.push(
      leg.on.kind === 'composite'
        ? 'declared composite `on`: one hash pass over the right snapshot, keyed on the field tuple'
        : 'declared range `on`: the right snapshot is sorted once, then binary-searched per left row',
    )
    notes.push('many-to-many: one row per match, so the estimate is a lower bound and the output ceiling applies')
    return {
      op: 'join',
      dispatch: joinOnDispatch(leg.on),
      detail: `${leg.as} <- ${describeJoinOn(leg.on)} (${leg.target})`,
      estimatedRows: leftRows,
      notes,
      children: [],
    }
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

/**
 * One line per node, two spaces per level of depth.
 *
 * Exported (#1342) so the partitioned union's `explain()` renders its
 * partition line and the member's nodes with THIS renderer rather than a
 * second one — a consumer diffing two `explain().text` outputs must not be
 * reading two formatters.
 */
export function renderExplainText(nodes: readonly ExplainNode[]): string {
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
