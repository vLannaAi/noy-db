/**
 * The parts of `.groupBy()` that BOTH the eager pipeline and the incremental
 * one need — the cardinality guards and the per-bucket fold.
 *
 * ⭐ It exists for one reason: `groupby.ts` (eager) and `incremental-group.ts`
 * (delta-maintained) must produce byte-identical rows, and the cheapest way to
 * guarantee that is for them to share the CODE rather than agree by
 * convention. Putting it here also breaks what would otherwise be an import
 * cycle between those two files.
 *
 * @internal — `groupby.ts` re-exports the public names, so the module graph
 * below this file is invisible to consumers.
 */

import type { ReduceSpec } from './reduction.js'

/**
 * Cardinality thresholds for `.groupBy()`. The warn threshold gives
 * consumers a heads-up before the hard error; the cap is a fixed
 * constant (not overridable). A `{ maxGroups }` override
 * can be added later without a break if a real consumer asks.
 */
export const GROUPBY_WARN_CARDINALITY = 10_000
export const GROUPBY_MAX_CARDINALITY = 100_000

/**
 * One-shot warning dedup per-field-set — reactive dashboards
 * re-executing the same grouped query should produce the warning
 * once, not once per re-fire. Keyed on the sorted JSON of grouping
 * field names so `.groupBy('a', 'b')` and `.groupBy('b', 'a')`
 * share the same dedup slot (their result tuples are isomorphic).
 */
const warnedCardinalityFields = new Set<string>()

export function warnCardinalityApproaching(
  fields: readonly string[],
  observed: number,
): void {
  const key = JSON.stringify([...fields].sort())
  if (warnedCardinalityFields.has(key)) return
  warnedCardinalityFields.add(key)
  const label = `[${fields.join(', ')}]`
  console.warn(
    `[noy-db] .groupBy(${label}) produced ${observed} distinct groups, ` +
      `${Math.round((observed / GROUPBY_MAX_CARDINALITY) * 100)}% of the ` +
      `${GROUPBY_MAX_CARDINALITY}-group ceiling. Narrow the query with ` +
      `.where() before grouping, or switch to a lower-cardinality field.`,
  )
}

/**
 * Test-only: clear the per-field cardinality warning dedup between
 * tests. Production code never calls this — matching the
 * `resetJoinWarnings` pattern in `join.ts`.
 */
export function resetGroupByWarnings(): void {
  warnedCardinalityFields.clear()
}

/** The label a cardinality error names — `"k"` single-key, `[a, b]` multi. */
export function groupFieldLabel(fields: readonly string[]): string {
  return fields.length === 1 ? fields[0]! : `[${fields.join(', ')}]`
}

/**
 * Reduce ONE bucket into its output row: the group keys stamped first in
 * declaration order, then every reducer's finalized value.
 *
 * ⭐ The single definition of a grouped row. `groupAndReduce` calls it once per
 * bucket over the whole record set; the incremental maintainer calls it for
 * the buckets a delta touched and reuses the cached row for the rest. Because
 * the fold is `init → step* → finalize` over the SAME records in the SAME
 * order, an incrementally produced row is not merely equal to a re-run's — it
 * is the identical computation.
 */
export function reduceGroupRow<R>(
  fields: readonly string[],
  keyValues: Record<string, unknown>,
  records: readonly unknown[],
  spec: ReduceSpec,
  reducerKeys: readonly string[],
): R {
  const state: Record<string, unknown> = {}
  for (const rk of reducerKeys) {
    state[rk] = spec[rk]!.init()
  }
  for (const record of records) {
    for (const rk of reducerKeys) {
      state[rk] = spec[rk]!.step(state[rk], record)
    }
  }
  // Stamp grouped fields FIRST, in declaration order — this is
  // tested via `Object.keys(row).slice(0, fields.length)`.
  const row: Record<string, unknown> = {}
  for (const f of fields) {
    row[f] = keyValues[f]
  }
  for (const rk of reducerKeys) {
    row[rk] = spec[rk]!.finalize(state[rk])
  }
  return row as unknown as R
}
