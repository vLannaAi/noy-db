/**
 * Deterministic hash of a materialized view strategy's "shape": MV
 * name + canonical query-plan summary + sorted dependency-set.
 *
 * Used to detect strategy drift: a row whose `_materializedFrom.queryHash`
 * doesn't match the current strategy is considered stale.
 *
 * Web Crypto SHA-256 — no extra deps. Mirrors the v1
 * `computeStrategyHash` pattern.
 */
import { sha256Hex } from '../../kernel/enclave/index.js'

export async function computeQueryHash(
  mvName: string,
  /**
   * Source-collection set the query depends on. Sorted before
   * canonicalization so set iteration order doesn't affect the hash.
   */
  dependencies: ReadonlySet<string>,
  /**
   * Stringified query-plan summary. The caller produces this from the
   * `Query<T>` builder — concretely: a JSON serialization of clauses +
   * orderBy + limit + offset + joins. Function bodies inside
   * `wherePredicate` are NOT included here (those carry their own
   * `predicateHash` to be folded in by a later sub-issue).
   */
  queryPlanSummary: string,
): Promise<string> {
  const canonical = JSON.stringify({
    mvName,
    dependencies: [...dependencies].sort(),
    queryPlanSummary,
  })
  const bytes = new TextEncoder().encode(canonical)
  return sha256Hex(bytes)
}

/**
 * Canonicalize a query plan for hashing. Walks the plan structure
 * with sorted keys so insertion order doesn't perturb the result.
 * Lives here rather than in `query/builder.ts` to keep that module
 * stable across MV-specific evolutions.
 *
 * @internal exported for testing
 */
export function canonicalizeQueryPlan(plan: unknown): string {
  return JSON.stringify(plan, (_key, value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const sorted: Record<string, unknown> = {}
      for (const k of Object.keys(value as Record<string, unknown>).sort()) {
        sorted[k] = (value as Record<string, unknown>)[k]
      }
      return sorted
    }
    return value
  })
}
