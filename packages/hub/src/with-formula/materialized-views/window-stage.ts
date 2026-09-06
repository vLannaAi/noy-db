/**
 * #1411 — the declared window stage of a materialized view.
 *
 * `unionSources` → `map` → `groupBy` → `aggregate` → **`window`** → `derive`.
 *
 * ## Why a window is safe here when `derive` is deliberately single-row
 *
 * `derive`'s contract is *pure, single-row, no cross-row access* — a window is
 * the opposite of all three. The difference is not caution, it is that
 * materialization is a FULL RECOMPUTE: the executor holds every row the view
 * will store, in one array, before it writes any of them. So an
 * order-dependent, cross-row pass runs exactly once over exactly the rows that
 * get stored, and its output is then an ordinary column. A per-row recompute
 * could not do this — inserting a row early in a partition moves every later
 * row's running total.
 *
 * ## Why this does not simply call `applyWindow`
 *
 * ⚠️ `applyWindow` does no Via rewriting. On the ad-hoc builder,
 * `Query.window().select()` rewrites reducer slots through the COLLECTION's
 * Via pipeline first, which is what makes `runningMoneySum` exact. A UNION-mode
 * MV has no collection — its rows are MAPPED — so it has the same answer
 * `aggregate` already uses: the MV's own `moneyFields` descriptors, bound
 * through the kernel's Via port. This mirrors `groupAndReduce`'s money block
 * line for line, deliberately: two places that must agree about what a money
 * reducer is, doing it the same way.
 *
 * Without that rewrite the failure is silent and specific — a running total
 * over decimal strings accumulates in float and returns
 * `0.6000000000000001` where the aggregate on the same rows returns `'0.60'`.
 */
import { applyWindow } from '../../with-lookup/reduce/window.js'
import type { WindowSelectSpec, WindowSpec } from '../../with-lookup/reduce/window.js'
import { bindDistinctReducers } from '../../with-lookup/reduce/reducers.js'
import type { Reducer } from '../../with-lookup/reduce/reducers.js'
import type { ReduceSpec } from '../../with-lookup/reduce/reduction.js'
import { viaBinder } from '../../kernel/via/index.js'
import type { MaterializedViewWindow, MoneyDescriptorMap } from './types.js'

/** Is this slot a window function rather than a reducer? */
function isWindowFn(v: unknown): boolean {
  return typeof v === 'object' && v !== null && (v as { __window?: unknown }).__window === true
}

/**
 * Apply a declared window to the finished row set.
 *
 * `moneyFields` is the MV's own descriptor map; when present, every REDUCER
 * slot is rewritten exactly as `aggregate`'s are. Window functions
 * (`rowNumber`, `rank`, `lag`, `lead`) are passed through untouched — they
 * navigate rows rather than accumulate values, so there is nothing to make
 * exact.
 */
export function applyDeclaredWindow(
  rows: readonly Record<string, unknown>[],
  window: MaterializedViewWindow,
  moneyFields?: MoneyDescriptorMap,
): ReadonlyArray<Record<string, unknown>> {
  if (rows.length === 0) return rows

  let select: WindowSelectSpec = window.select
  if (moneyFields) {
    const reducersOnly: Record<string, Reducer<unknown, unknown>> = {}
    for (const [k, v] of Object.entries(select)) {
      if (!isWindowFn(v)) reducersOnly[k] = v as Reducer<unknown, unknown>
    }
    if (Object.keys(reducersOnly).length > 0) {
      const binding = viaBinder('money')({ moneyFields })
      let wrapped = binding.wrapReducers!(reducersOnly as ReduceSpec) as Record<
        string,
        Reducer<unknown, unknown>
      >
      wrapped = bindDistinctReducers(wrapped as ReduceSpec, {
        canonicalizeIndexKey: (f, v) => binding.canonicalizeIndexKey?.(f, v),
      }) as Record<string, Reducer<unknown, unknown>>
      select = { ...select, ...wrapped }
    }
  }

  // `applyWindow` takes the partition/order spec and the select list
  // separately, so strip `select` off rather than pass it twice. Built by
  // spreading absent keys away rather than assigning `undefined` — the package
  // compiles under `exactOptionalPropertyTypes`, where the two differ.
  const spec: WindowSpec = {
    ...(window.partitionBy !== undefined && { partitionBy: window.partitionBy }),
    ...(window.orderBy !== undefined && { orderBy: window.orderBy }),
  }
  return applyWindow<Record<string, unknown>>(rows, spec, select)
}
