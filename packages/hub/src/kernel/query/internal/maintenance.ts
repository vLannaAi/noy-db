/**
 * #1458 — the incremental-maintenance methods, shared by Live and Reduce.
 *
 * `incrementalMaintainer` and `groupMaintenance` are Live's machinery, but
 * they are not Live's alone: a live REDUCTION (`aggregate()` /
 * `groupBy()` handed to `withReduce`) maintains its state through exactly the
 * same maintainer, and always has — `Query.aggregate()` called
 * `this.incrementalMaintainer('records')` while both lived in `builder.ts`.
 *
 * ⭐ **So this is a genuine Reduce → Live edge, and it is recorded here rather
 * than hidden.** Both groups' `install()` copy this mixin, so importing
 * `@noy-db/hub/query/reduce` alone still gets a correctly-maintained live
 * reduction — at the cost of `live/incremental.ts` in that bundle. The
 * alternative (a hook that degrades to a full re-run when Live is absent)
 * would make the SAME call site behave differently depending on an unrelated
 * import, which is worse than the bytes.
 */
import type { DateTruncKey } from '../reduce/date-trunc.js'
import { projectDateTruncKeys } from '../reduce/date-trunc.js'
import type { GroupMaintenanceSource } from '../live/incremental.js'
import { LiveMaintainer, canMaintainIncrementally } from '../live/incremental.js'
import type { DeclaredPredicate, InternalSource, QueryPlan } from '../builder.js'
// @internal Find helpers — the maintainer re-runs the same predicate and sort
// the executor does, so it must use the same functions rather than a second
// implementation that can drift from them.
import { buildOrderKeyPlan, compareOrderKeys, filterRecords, fnViewDecoder, orderKeyOf } from '../builder.js'
import type { JoinContext } from '../relate/join.js'
import type { ReduceStrategy } from '../../../with-lookup/reduce/strategy.js'

/** @internal — copied onto `Query.prototype` by both Live and Reduce. */
export class MaintenanceMethods {
  declare protected readonly source: InternalSource
  declare protected readonly plan: QueryPlan
  declare protected readonly joinContext: JoinContext | undefined
  declare protected readonly reduceStrategy: ReduceStrategy
  declare protected readonly predicates: ReadonlyMap<string, DeclaredPredicate> | undefined
  declare protected decodeVia: (records: readonly unknown[], locale?: string) => unknown[]

  /**
   * Build the #1341 delta maintainer for this plan, or `undefined` when the
   * plan shape or the source cannot support one (the query then re-runs in
   * full, exactly as it did before #1341).
   *
   * Everything the maintainer needs is taken from THIS query so the two paths
   * cannot diverge: `matches` is the same `filterRecords` call the eager
   * pipeline makes, `compare` is the same comparator `sortRecords` sorts with,
   * and `decode` is the same Via result decode `toArray()` applies after
   * slicing.
   */
  private incrementalMaintainer(mode: 'rows' | 'records'): LiveMaintainer | undefined {
    const source = this.source
    const snapshotEntries = source.snapshotEntries?.bind(source)
    const lookupById = source.lookupById?.bind(source)
    if (!snapshotEntries || !lookupById) return undefined
    // `.aggregate()` reduces the whole match set in candidate order — it never
    // sorts, offsets, limits or decodes — so its maintainer is the same engine
    // with the ordering/windowing half switched off.
    const orderBy = mode === 'rows' ? this.plan.orderBy : []
    const limit = mode === 'rows' ? this.plan.limit : undefined
    const indexes = source.getIndexes?.()
    const probe = indexes
      ? { covers: (f: string) => indexes.has(f), sorted: (f: string) => indexes.hasSorted(f) }
      : null
    if (!canMaintainIncrementally({ ...this.plan, orderBy, limit }, probe)) return undefined

    const clauses = this.plan.clauses
    const decodeForFns = fnViewDecoder(source)
    const via = source.via
    // The ordering comes from the SAME key plan `sortRecords` builds and the
    // keyset cursor compares against (#1346) — one definition of "what order
    // is this query in", so the maintained order cannot drift from a re-run's.
    // `by: 'label'` is refused above, so no label maps are needed here.
    const keyPlan = orderBy.length > 0 ? buildOrderKeyPlan(orderBy, via) : undefined
    return new LiveMaintainer({
      snapshotEntries,
      lookupById,
      matches: record => filterRecords([record], clauses, decodeForFns).length === 1,
      ...(keyPlan
        ? {
            order: {
              keyOf: (record: unknown) => orderKeyOf(keyPlan, record),
              compare: (a: readonly unknown[], b: readonly unknown[]) => compareOrderKeys(keyPlan, a, b),
            },
          }
        : {}),
      offset: mode === 'rows' ? this.plan.offset : 0,
      limit,
      ...(mode === 'rows' && via?.hasResultDecode
        ? { decode: (rows: readonly unknown[]) => this.decodeVia(rows) }
        : {}),
    })
  }

  /**
   * Build the #1341 grouped-maintenance seam for this plan, or `undefined`
   * when the plan shape or the source cannot support one (a grouped live
   * reduction then re-runs in full, exactly as it did before).
   *
   * Same whitelist and the same three inputs `incrementalMaintainer('records')`
   * uses, for the same reason: `.groupBy()`'s record pipeline IS
   * `.aggregate()`'s — `candidateRecords` + `filterRecords`, with no sort, no
   * window and no Via result decode — so `orderBy`/`limit` are stripped before
   * the whitelist is asked. `matches` is the same `filterRecords` call the
   * eager pipeline makes, which is what stops the two paths from drifting.
   *
   * The one addition is `project`: `.groupBy(dateTrunc(...))` (#1350) stamps a
   * derived key onto each row AFTER filtering and before bucketing, and the
   * maintainer has to stamp it too or it would bucket on a field that is not
   * there. It is a pure per-record map, which is the only kind of projection
   * this hook may carry.
   */
  private groupMaintenance(derived: readonly DateTruncKey[]): GroupMaintenanceSource | undefined {
    const source = this.source
    const snapshotEntries = source.snapshotEntries?.bind(source)
    const lookupById = source.lookupById?.bind(source)
    if (!snapshotEntries || !lookupById) return undefined
    const indexes = source.getIndexes?.()
    const probe = indexes
      ? { covers: (f: string) => indexes.has(f), sorted: (f: string) => indexes.hasSorted(f) }
      : null
    if (!canMaintainIncrementally({ ...this.plan, orderBy: [], limit: undefined }, probe)) {
      return undefined
    }
    const clauses = this.plan.clauses
    const decodeForFns = fnViewDecoder(source)
    return {
      snapshotEntries,
      lookupById,
      matches: (record: unknown) => filterRecords([record], clauses, decodeForFns).length === 1,
      ...(derived.length > 0
        ? { project: (record: unknown) => projectDateTruncKeys([record], derived)[0] }
        : {}),
    }
  }
}
