/**
 * #1458 — the plan-level seam between Find and the Relate extension.
 *
 * Find owns the executor, and the executor has to be able to run a plan that
 * carries join legs or a `crossJoin` clause. Those clauses are Relate's to
 * BUILD but Find's to EXECUTE, so the split cannot be made by moving code:
 * `toArray`, `matchedRecords` and `executeClausePipeline` are Find methods
 * that must call into `relate/join.ts`.
 *
 * ⭐ **The slot is provably full whenever it is read.** Every call site is
 * guarded by `plan.joins.length > 0` or by a `crossJoin` clause being present,
 * and only Relate's builders can put either into a plan — so a Find-only
 * consumer never reaches a hook, which is exactly why Find's import graph can
 * stay free of `relate/`.
 *
 * ⚠️ The one way to reach an empty slot is to hand-build a `QueryPlan` with
 * legs and pass it to the `Query` constructor. `QueryPlan` is a published,
 * consumer-constructible type, so that is a real path rather than a
 * theoretical one — and it is why `relateHooks()` throws
 * {@link QueryExtensionMissingError} instead of asserting non-null.
 */
import { QueryExtensionMissingError } from '../../errors.js'
import type { Clause, CrossJoinClause } from '../predicate.js'
import type { JoinableSource, JoinContext, JoinLeg } from '../relate/join.js'
import type { OrderBy } from '../builder.js'

/** The Relate entry points Find's executor calls. Every one is join-conditional. */
export interface RelateHooks {
  applyJoins(
    rows: readonly unknown[],
    joins: readonly JoinLeg[],
    ctx: JoinContext,
    locale?: string,
  ): unknown[]
  splitAroundJoins(
    clauses: readonly Clause[],
    joins: readonly JoinLeg[],
  ): { preJoin: readonly Clause[]; postJoin: readonly Clause[] }
  orderReferencesJoinAlias(orderBy: readonly OrderBy[], joins: readonly JoinLeg[]): boolean
  joinsDropLeftRows(joins: readonly JoinLeg[]): boolean
  applyCrossJoin(leftRel: unknown[], clause: CrossJoinClause, rightSource: JoinableSource): unknown[]
}

let installed: RelateHooks | undefined

/** Called once by `@noy-db/hub/query/relate` on load. */
export function installRelateHooks(hooks: RelateHooks): void {
  installed = hooks
}

/**
 * The Relate hooks, or the actionable error. Read only from a guarded branch —
 * see this module's header for why that makes the throw unreachable for a
 * consumer who never built a join.
 */
export function relateHooks(): RelateHooks {
  if (installed === undefined) {
    throw new QueryExtensionMissingError('join', '@noy-db/hub/query/relate')
  }
  return installed
}
