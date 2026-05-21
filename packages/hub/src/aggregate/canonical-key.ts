/**
 * Canonicalise a group-key tuple to a stable string for dedup hashing.
 *
 * Sorts field names lexicographically before serialising, so that
 * `.groupBy('a', 'b')` and `.groupBy('b', 'a')` produce identical
 * keys for the same logical group. Values are JSON-stringified;
 * `undefined` and `null` are distinguished (matching the Map-key
 * semantics in `groupAndReduce`).
 *
 * NOT part of the public API. Used by:
 *   - `groupAndReduce` for the dedup Map's key
 *   - `materialized-views/query-hash` for UNION MV cross-arm row-key dedup (PR 2)
 *
 * Pure: same input → same output, no side effects.
 */
export function canonicalGroupKey(
  fields: readonly string[],
  row: Record<string, unknown>,
): string {
  const sorted = [...fields].sort()
  const parts: string[] = []
  for (const name of sorted) {
    const v = row[name]
    const serialised =
      v === undefined ? 'undefined' : JSON.stringify(v)
    parts.push(`${name}=${serialised}`)
  }
  return parts.join('|')
}
