import type { Query, QueryPlan } from '../query/builder.js'
import type { JoinContext } from '../query/join.js'
import type { MaterializedViewStrategy } from './types.js'

/**
 * Walks a `Query<T>` plan and returns the set of source collection
 * names that any source-write should trigger a refresh on.
 *
 * Foundation sub-issue (#150) handles:
 *   - root collection (the one the query was built from)
 *   - FK join targets (`.join(field, { as })`)
 *
 * Deferred to later sub-issues:
 *   - `.crossJoin()` — v3 cross-join spec (separate primitive)
 *   - `.wherePredicate(name)` — v2 predicate primitive, sub-issue #153
 *   - Overlay-name expansion to {base, overlay} — sub-issue #154
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
    clauses: plan.clauses,
    orderBy: plan.orderBy,
    limit: plan.limit ?? null,
    offset: plan.offset,
    joins: plan.joins.map(j => ({ field: j.field, as: j.as, target: j.target, mode: j.mode })),
  })
}

/**
 * Canonical string description of a UNION MV's plan, used as input to
 * `computeQueryHash`. Sorts arm collection names + groupBy fields +
 * aggregate spec keys so structural reorderings produce the same hash
 * (the order of `unionSources` and the field order inside `groupBy`
 * don't change semantics — sorting catches that).
 *
 * Per-arm `map` functions are NOT fingerprinted; consumers must bump
 * the MV's `name` (or rely on application-level cache busting) when
 * `map` semantics change non-equivalently.
 */
export function summarizeUnionPlan<T extends Record<string, unknown>>(
  spec: MaterializedViewStrategy<T>,
): string {
  const arms = [...(spec.unionSources ?? [])]
    .map(s => s.collection)
    .sort()
    .join(',')
  const groupBy = Array.isArray(spec.groupBy)
    ? [...spec.groupBy].sort().join(',')
    : (spec.groupBy ?? '')
  const aggKeys = spec.aggregate ? Object.keys(spec.aggregate).sort().join(',') : ''
  return `union(${arms})|groupBy(${groupBy})|aggregate(${aggKeys})`
}
