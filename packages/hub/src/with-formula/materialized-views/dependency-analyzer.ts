import type { Query, QueryPlan } from '../../kernel/query/builder.js'
import type { JoinContext } from '../../kernel/query/join.js'
import type { MaterializedViewSpec } from './types.js'

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
    joins: plan.joins.map(j => ({ field: j.field, as: j.as, target: j.target, mode: j.mode })),
  })
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
 *   - `groupBy` fields ARE sorted. Multi-key groupBy buckets are
 *     commutative (`canonicalGroupKey` produces the same composite key
 *     regardless of field order in the input spec).
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
    .map(leg =>
      'collect' in leg
        ? `collect:${leg.collect}.${leg.on}→${leg.as}`
        : `field:${leg.field}→${leg.as}`,
    )
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
      const joins = s.join?.length
        ? `[${s.join.map(j => `${j.field}→${j.as}`).join(';')}]`
        : ''
      return `${s.collection}${joins}`
    })
    .join(',')
}

/**
 * Shared `|groupBy(…)|aggregate(…)|money(…)` tail for the UNION and
 * projection summaries — both feed the same post-map grouping pipeline,
 * so the same spec fields fold into both hashes with the same rules.
 */
function summarizeGroupingTail<T extends Record<string, unknown>>(
  spec: MaterializedViewSpec<T>,
): string {
  const groupBy: string = Array.isArray(spec.groupBy)
    ? [...spec.groupBy].sort().join(',')
    : typeof spec.groupBy === 'string'
      ? spec.groupBy
      : ''
  const aggKeys = spec.aggregate ? Object.keys(spec.aggregate).sort().join(',') : ''
  // `moneyFields` changes reducer semantics (float → exact BigInt), so
  // declaring / removing / re-keying it must bump queryHash. Keys are
  // sorted — they're independent of each other (one descriptor per
  // output field), same rationale as aggregate keys.
  const moneyKeys = spec.moneyFields ? Object.keys(spec.moneyFields).sort().join(',') : ''
  return `|groupBy(${groupBy})|aggregate(${aggKeys})|money(${moneyKeys})`
}
