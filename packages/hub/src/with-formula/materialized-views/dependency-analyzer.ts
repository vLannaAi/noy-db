import { describeGroupKey, type GroupKey } from '../../kernel/query/reduce/date-trunc.js'
import type { Query, QueryPlan } from '../../kernel/query/builder.js'
import type { JoinContext, JoinLeg } from '../../kernel/query/relate/join.js'
import type { MaterializedViewSpec } from './types.js'
import { normalizeJoinOn } from '../../kernel/query/relate/join-on.js'

/**
 * Walks a `Query<T>` plan and returns the set of source collection
 * names that any source-write should trigger a refresh on.
 *
 * Handles:
 *   - root collection (the one the query was built from)
 *   - FK join targets (`.join(field, { as })`)
 *
 * Also handles:
 *   - cross-join targets (`.crossJoin(target, { as })`) — v3
 *
 * Deferred:
 *   - `.wherePredicate(name)` — v2 predicate primitive
 *   - Overlay-name expansion to {base, overlay}
 *
 * The set is materialized at MV registration time. The MV registry
 * uses it to (a) dispatch `onSourceWrite` only to MVs that actually
 * care, and (b) contribute edges to the shared cycle-detection graph.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function analyzeDependencies(query: Query<any>): Set<string> {
  const deps = new Set<string>()
  const plan = query._plan()
  const ctx = query._joinContext()

  // The root collection is always a dependency.
  if (ctx?.leftCollection) {
    deps.add(ctx.leftCollection)
  }

  // FK join targets contribute additional sources.
  for (const leg of plan.joins) {
    deps.add(leg.target)
  }

  // Cross-join targets are also dependency sources — writes to either side
  // must trigger MV refresh. Symmetric with FK-join target handling above.
  for (const clause of plan.clauses) {
    if (clause.type === 'crossJoin') {
      deps.add(clause.target)
    }
  }

  // Sub-plans inside OR clauses can carry nested joins. Walk them.
  // (Today only top-level `.join()` populates `plan.joins`, but the
  // OR-group machinery permits sub-plans, so we recurse defensively.)
  walkClausesForJoins(plan, deps, ctx)

  return deps
}

function walkClausesForJoins(
  plan: QueryPlan,
  deps: Set<string>,
  ctx: JoinContext | undefined,
): void {
  void ctx
  // Today `plan.joins` carries all join legs at top level. Sub-plans
  // inside OR groups don't currently support nested joins, so the loop
  // below is a no-op safety net for future builder extensions.
  for (const clause of plan.clauses) {
    if (clause.type === 'group') {
      // Group clauses don't (yet) carry their own joins; this is a
      // forward-compat anchor for when OR-groups support nested
      // sources.
    }
  }
}

/**
 * Convenience: produce a stable string summary of the query plan
 * suitable for `queryHash` derivation. Captures everything the
 * dependency analyzer reads + the where/orderBy/limit/offset
 * structure that affects materialized rows.
 *
 * `joinContext` is intentionally NOT included — the join-resolution
 * function references would defeat hash determinism. The set of join
 * TARGETS (collection names) IS included via the plan.joins legs.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function summarizeQueryPlan(query: Query<any>): string {
  const plan = query._plan()
  const ctx = query._joinContext()
  return JSON.stringify({
    root: ctx?.leftCollection ?? null,
    clauses: plan.clauses.map(c => {
      if (c.type === 'crossJoin') {
        return {
          type: 'crossJoin',
          target: c.target,
          as: c.as,
          // Inline on: callback: use sentinel — drift detection disabled for this MV
          onPredicateName: c.onPredicateName ?? (c.on ? '[inline]' : null),
          maxRows: c.maxRows ?? null,
          // `outer` changes the row set, so it is part of the plan's identity
          // for drift detection, not decoration (#1130).
          outer: c.outer ?? false,
        }
      }
      return c
    }),
    orderBy: plan.orderBy,
    limit: plan.limit ?? null,
    offset: plan.offset,
    joins: plan.joins.map(j => summarizeJoinLeg(j)),
  })
}

/**
 * The per-leg half of {@link summarizeQueryPlan}, split out so the property
 * test in `__tests__/query-join-summary-hash.test.ts` can address it directly.
 *
 * ⭐ **THE RULE FOR GROWING THIS FUNCTION (#1389).** Every key here is inside
 * an already-stored `queryHash`. A key that is emitted unconditionally can
 * never be added, removed, or renamed without moving EVERY joined MV's hash
 * and silently recomputing every one of them. A key that is OMITTED AT ITS
 * DEFAULT can: `JSON.stringify` drops an `undefined` value, so a leg that does
 * not use the feature summarises byte-identically to its pre-change self and
 * only the MVs genuinely using the feature recompute — once, correctly.
 * So: **new keys are omitted at their default, always.** Pinned by the
 * byte-identity test in that file.
 *
 * ⛔ And the converse duty, which is what #1389 actually was: a `JoinLeg` field
 * that changes WHICH ROWS the leg produces and is NOT emitted here makes two
 * semantically different MVs share a hash, so drift detection goes blind and
 * nothing reports it. `direction`, `inner` and `isDictJoin` were all in that
 * state. The exclusion list below is deliberate and each entry states why;
 * the property test fails if a new `JoinLeg` key appears in neither.
 */
function summarizeJoinLeg(j: JoinLeg): Record<string, unknown> {
  return {
    field: j.field,
    as: j.as,
    target: j.target,
    mode: j.mode,
    // #1339 — the declared `on` IS the join's identity: two `.joinOn()`
    // plans differing only here select different rows, and without this key
    // they would hash identically and neither MV would ever be seen as
    // stale. `undefined` for every other leg, and `JSON.stringify` drops an
    // undefined value, so a plan carrying no `joinOn` summarises
    // byte-identically to its pre-#1339 self and no stored hash moves.
    on: j.on,
    // #1389 — `direction` (#1289) decides which SIDE is preserved: a right or
    // full leg emits rows a left leg never produces. Omitted for a left leg,
    // which is `undefined` on the leg itself, so a plain `.join()` plan is
    // byte-identical to its pre-#1389 summary.
    direction: j.direction,
    // #1389 — `inner` (#1361) DROPS every unmatched left row. Only ever
    // `true`; `undefined` on every other leg, so again nothing moves for a
    // plan that does not use it.
    inner: j.inner,
    // #1389 — a dict join attaches `{ ...labels, key }` from the dictionary
    // snapshot instead of a right-side record, and `target` names a
    // dictionary rather than a collection. Two legs can otherwise agree on
    // all four base keys (a dict leg's `target` IS its `field`, which a ref
    // join to a like-named collection reproduces), so without this key they
    // hash identically while materializing different rows. Only ever `true`.
    isDictJoin: j.isDictJoin,
    // ── EXCLUDED, deliberately (#1389). Read before adding one. ──────────
    //
    // `partitionScope` — NOT emitted, and this is the load-bearing one. It is
    //   `'all'` on every leg ever built and the executor never reads it
    //   (#1342), so it cannot change a row. It is also present unconditionally
    //   rather than omitted-at-default, so starting to emit it would move
    //   EVERY joined MV's hash at once for zero semantic gain. If a future
    //   change ever makes it narrowable, emit it only when it is not `'all'`.
    //
    // `strategy` — NOT emitted: a manual planner override picks HOW the same
    //   rows are produced (hash vs lookup), never which. Emitting it would
    //   force a full recompute for a pure performance tweak.
    //
    // `maxRows` — NOT emitted: a per-side ceiling that throws
    //   `JoinTooLargeError` when crossed. A query that succeeds returns the
    //   same rows at any ceiling above its size, so it is not part of the
    //   plan's row identity.
  }
}

/**
 * Canonical string description of a UNION MV's plan, used as input to
 * `computeQueryHash`.
 *
 * Asymmetry note:
 *   - Arm collection names are NOT sorted. Declaration order is
 *     semantically meaningful for the dedup-only UNION path —
 *     `materializeUnionResult` iterates `spec.unionSources` in
 *     declaration order and keeps the first-seen row per composite key
 *     (tie-break precedence). If we sorted arms here, a consumer who
 *     reordered `unionSources` to change precedence would compute the
 *     same `queryHash`, refresh would be a no-op, and stale MV rows
 *     would persist. Hashing in declaration order makes any reorder
 *     trigger a refresh.
 *   - `groupBy` fields ARE sorted, by their canonical `describeGroupKey`
 *     description (which is the field name itself for a plain key). Multi-key
 *     groupBy buckets are commutative (`canonicalGroupKey` produces the same
 *     composite key regardless of field order in the input spec).
 *   - `aggregate` keys ARE sorted. Reducer-spec keys are independent
 *     of each other — order of declaration doesn't change output.
 *
 * Per-arm `map` functions are NOT fingerprinted; consumers must bump
 * the MV's `name` (or rely on application-level cache busting) when
 * `map` semantics change non-equivalently.
 */
export function summarizeUnionPlan<T extends Record<string, unknown>>(
  spec: MaterializedViewSpec<T>,
): string {
  return `union(${summarizeUnionArms(spec)})${summarizeGroupingTail(spec)}`
}

/**
 * Canonical string description of a projection MV's plan (#810), used
 * as input to `computeQueryHash`.
 *
 * Leg descriptors ARE sorted (contrast with UNION arm order): every
 * leg attaches under a distinct `as` alias, forward legs are
 * one-to-one attachments and collect legs are independent
 * hash-grouped passes, so declaration order never changes the
 * materialized rows — a pure reorder must NOT force a refresh.
 * `from` (#1140) constrains the legal orderings (a leg must follow the
 * alias it attaches to) without making order meaningful: each descriptor
 * carries its own `@alias`, and aliases are unique, so the sorted set
 * still determines the leg graph exactly.
 *
 * The projection `map` is NOT fingerprinted (identical limitation as
 * the UNION arm `map`); consumers must bump the MV's `name` when
 * `map` semantics change non-equivalently.
 */
export function summarizeProjectionPlan<T extends Record<string, unknown>>(
  spec: MaterializedViewSpec<T>,
): string {
  const projection = spec.projection!
  const legs = projection.joins
    .map(leg => {
      // #1140 — `from` changes which rows a leg attaches to, so it is part of
      // the plan's identity. Omitting it would let two structurally different
      // projections share a queryHash and silently skip a refresh.
      const at = leg.from !== undefined ? `@${leg.from}` : ''
      return 'collect' in leg
        ? `collect${at}:${leg.collect}.${leg.on}→${leg.as}`
        : `field${at}:${leg.field}→${leg.as}`
    })
    .sort()
  const body = JSON.stringify({ source: projection.source, legs })
  return `projection(${body})${summarizeGroupingTail(spec)}`
}

/** Arm descriptors for `summarizeUnionPlan` — declaration order preserved (see its doc). */
function summarizeUnionArms<T extends Record<string, unknown>>(
  spec: MaterializedViewSpec<T>,
): string {
  return (spec.unionSources ?? [])
    .map(s => {
      // Fold each arm's join legs into the summary so adding or
      // reordering joins (which changes the materialized rows) bumps
      // queryHash. Leg order is declaration-significant (legs chain), so
      // it is NOT sorted — same rationale as arm declaration order.
      // #1411 — a declared leg folds its NORMALISED predicate in (the normal
      // form is what makes two logically identical `on`s hash identically, and
      // `normalizeJoinOn` throwing here is what makes a malformed leg fail at
      // registration rather than at the first refresh).
      const joins = s.join?.length
        ? `[${s.join.map(j => 'on' in j
            ? `${j.target}?${JSON.stringify(normalizeJoinOn(j.on, j.target))}${j.mode === 'inner' ? '!' : ''}→${j.as}`
            : `${j.field}→${j.as}`).join(';')}]`
        : ''
      return `${s.collection}${joins}`
    })
    .join(',')
}


/**
 * #1411 — the window's contribution to `queryHash`.
 *
 * ⚠️ **`partitionBy` and `orderBy` are NOT sorted, unlike the groupBy and
 * aggregate keys beside them.** Group buckets are commutative, so sorting them
 * is what stops a re-ordered declaration from forcing a pointless refresh. A
 * window's keys are not: `orderBy: ['a','b']` walks a partition differently
 * from `['b','a']` and produces different running totals, and a partition list
 * feeds the same key-building order. Sorting them here would let a real
 * semantic change reuse a stored `queryHash`, refresh would be a no-op, and
 * the view would serve numbers computed under the old ordering.
 *
 * ⭐ **Returns the EMPTY STRING when no window is declared**, which is the same
 * omitted-at-default discipline `summarizeJoinLeg` states above and for the
 * same reason: every existing MV's stored `queryHash` must stay byte-identical
 * across this change, so only a view that actually declares a window
 * recomputes — once, correctly.
 *
 * `select` KEYS are sorted — they are independent output columns, same
 * rationale as the aggregate keys. The slot VALUES are functions and cannot be
 * hashed; renaming a column or adding one is what this can see, which is the
 * same limit `aggregate` has.
 */
function summarizeWindow<T extends Record<string, unknown>>(
  spec: MaterializedViewSpec<T>,
): string {
  if (!spec.window) return ''
  const list = (v: unknown): string => {
    if (v === undefined) return ''
    const arr = Array.isArray(v) ? v : [v]
    return arr
      .map((k) =>
        typeof k === 'object' && k !== null && 'field' in (k as Record<string, unknown>)
          ? `${describeGroupKey((k as { field: GroupKey }).field)}:${String((k as { direction?: string }).direction ?? 'asc')}`
          : describeGroupKey(k as GroupKey),
      )
      .join(',')
  }
  const selectKeys = Object.keys(spec.window.select).sort().join(',')
  return `|window(partition(${list(spec.window.partitionBy)})order(${list(spec.window.orderBy)})select(${selectKeys}))`
}

/**
 * Shared `|groupBy(…)|aggregate(…)|money(…)` tail for the UNION and
 * projection summaries — both feed the same post-map grouping pipeline,
 * so the same spec fields fold into both hashes with the same rules.
 */
function summarizeGroupingTail<T extends Record<string, unknown>>(
  spec: MaterializedViewSpec<T>,
): string {
  // `describeGroupKey` is the identity of a group key: a plain field name maps
  // to itself, and a `dateTrunc()` key (#1350) to a canonical string carrying
  // every parameter that decides which bucket a row lands in. Changing a unit,
  // a timezone or the week start therefore bumps the hash and forces a refresh.
  const groupBy: string = Array.isArray(spec.groupBy)
    ? spec.groupBy.map(describeGroupKey).sort().join(',')
    : spec.groupBy === undefined
      ? ''
      : describeGroupKey(spec.groupBy as GroupKey)
  const aggKeys = spec.aggregate ? Object.keys(spec.aggregate).sort().join(',') : ''
  // `moneyFields` changes reducer semantics (float → exact BigInt), so
  // declaring / removing / re-keying it must bump queryHash. Keys are
  // sorted — they're independent of each other (one descriptor per
  // output field), same rationale as aggregate keys.
  const moneyKeys = spec.moneyFields ? Object.keys(spec.moneyFields).sort().join(',') : ''
  return `|groupBy(${groupBy})|aggregate(${aggKeys})|money(${moneyKeys})${summarizeWindow(spec)}`
}
