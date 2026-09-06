/**
 * Partition pruning — the ONE decision function (#1342, ADR 0007).
 *
 * ADR 0007 rules that a partition is a COLLECTION, not a field lifted out of
 * the ciphertext: `listPage(vault, **collection**, cursor, limit)` already
 * takes the collection name in cleartext, so a partition modelled as its own
 * collection buys the pruning for free — no `@noy-db/hub/to` change, no
 * adapter change, no new leak class. What is left for the kernel is deciding
 * WHICH member collections a query has to read at all, and that is this file.
 *
 * ⭐ **SHARED, NOT MIRRORED.** `explain()` and the executor both call
 * {@link resolvePartitionScope}. `explain.ts`'s header warns that dispatch
 * selection is mirrored between it and `candidateRecords`, and #1375 spent a
 * whole issue deleting one of those mirrors by exporting the classifier from
 * `builder.ts`. Partition dispatch would have been a THIRD site. It is not:
 * there is one function, and both callers import it.
 *
 * ⛔ **SOUND IN ONE DIRECTION ONLY, AND THE ASYMMETRY IS THE DESIGN.** A
 * partition wrongly INCLUDED costs a scan nobody needed. A partition wrongly
 * EXCLUDED is silently missing data — no error, no warning, a short answer
 * that looks complete. So narrowing happens off a WHITELIST of provable
 * shapes, never off a blacklist of known-bad ones:
 *
 *   - `key == "<string>"`            → that one partition
 *   - `key in ["<string>", …]`       → that set
 *   - two of those AND-ed            → their intersection
 *
 * and EVERYTHING else degrades to {@link ALL_PARTITIONS} by falling off the
 * end of the whitelist: `or`/`and` groups (a nested clause is not AND-ed with
 * the top level), `!=`, `!in`, `<`/`<=`/`>`/`>=`/`between`, `contains`,
 * `startsWith`, `matches`, `near`, `filter()` callbacks, `wherePredicate()`,
 * `crossJoin`, a clause on any other field, a non-string operand — and, the
 * one that is easy to miss, **any Via-covered clause** (`clause.via`), whose
 * operand is in STORED form rather than in partition-key space. That is the
 * same reason `candidateRecords()` refuses the index for a Via clause, and
 * getting it wrong here is worse than getting it wrong there: an index miss
 * returns the right rows slowly, a partition miss returns the wrong rows fast.
 *
 * An operator added next year that this function has never heard of degrades
 * to "read everything" without anyone editing this file. That is the whole
 * point of the whitelist, and it is why the tests in
 * `__tests__/partitioned-collection.test.ts` cover the FALLBACKS at least as
 * heavily as the fast path.
 *
 * ⚠️ One narrowing this file does NOT do, deliberately: a RANGE on an ordered
 * partition key (`period >= 'FY2026-Q2'`) intersected against declared
 * partition boundaries. It is sound only once partitions carry declared
 * boundaries AND the open/closed distinction is honoured — an OPEN period's
 * upper bound can still move, so any range whose upper end is unbounded or in
 * the future must keep the open partition. Cheap rule, and the first one a
 * range narrowing gets wrong; it waits for a declaration that carries
 * boundaries.
 */

import type { Clause } from '../predicate.js'

/**
 * "Read every declared partition." The sound fallback, and the value every
 * shape this file cannot PROVE safe resolves to.
 */
export const ALL_PARTITIONS = 'all' as const

/**
 * The partitions a query must read: {@link ALL_PARTITIONS}, or the exact
 * subset — which may be EMPTY, when the predicate names a partition value
 * that has never been declared. An empty scope is a real answer, not a
 * degenerate one: the partition key is the collection a record lives in, so
 * "no such partition" means "no such record".
 */
export type PartitionScope = typeof ALL_PARTITIONS | readonly string[]

/**
 * The operand shapes a partition value can be proved from. Partition values
 * name collections, and a collection name is a string — so a numeric or
 * boolean operand is NOT coerced, it simply fails to narrow. Coercion is the
 * kind of cleverness that produces a wrongly-excluded partition.
 */
function partitionValuesOf(clause: Clause, key: string): readonly string[] | null {
  if (clause.type !== 'field') return null
  if (clause.field !== key) return null
  // Via-covered: the operand is in STORED form, not in partition-key space.
  if (clause.via !== undefined) return null
  if (clause.op === '==') {
    return typeof clause.value === 'string' ? [clause.value] : null
  }
  if (clause.op === 'in') {
    if (!Array.isArray(clause.value)) return null
    if (clause.value.length === 0) return []
    return clause.value.every((v) => typeof v === 'string')
      ? (clause.value as readonly string[])
      : null
  }
  return null
}

/**
 * Narrow `declared` to the partitions `clauses` can PROVE are needed.
 *
 * `clauses` must be the plan's TOP-LEVEL clause list — those are AND-ed, and
 * an intersection across them is therefore sound. Anything nested inside a
 * `group` is not AND-ed with the top level and is ignored by construction
 * (a `group` never matches the whitelist).
 *
 * The result preserves `declared`'s order, so a caller reading partitions in
 * sequence gets a stable, declaration-ordered walk whether or not it pruned.
 */
export function resolvePartitionScope(
  clauses: readonly Clause[],
  key: string,
  declared: readonly string[],
): PartitionScope {
  // One admitted set per whitelisted clause. AND-ed clauses intersect, so a
  // partition survives iff EVERY narrowing clause admits it — collected first
  // and intersected after, rather than folded, so the empty case (no clause
  // narrowed anything) is a length check rather than a null.
  const admitted: ReadonlySet<string>[] = []
  for (const clause of clauses) {
    const values = partitionValuesOf(clause, key)
    if (values === null) continue // off the whitelist — contributes no narrowing
    admitted.push(new Set<string>(values))
  }
  if (admitted.length === 0) return ALL_PARTITIONS
  return declared.filter((p) => admitted.every((set) => set.has(p)))
}

/**
 * The `explain()` line, in the existing vocabulary: `partitions: 3 of 12
 * scanned`. Shared so the executor's accounting and the explanation cannot
 * drift into disagreeing about what "scanned" counts.
 */
export function describePartitionScope(scope: PartitionScope, declared: readonly string[]): string {
  const scanned = scope === ALL_PARTITIONS ? declared.length : scope.length
  return `partitions: ${scanned} of ${declared.length} scanned`
}

/** The member partitions a scope resolves to, in declaration order. */
export function partitionsInScope(scope: PartitionScope, declared: readonly string[]): readonly string[] {
  return scope === ALL_PARTITIONS ? declared : scope
}
