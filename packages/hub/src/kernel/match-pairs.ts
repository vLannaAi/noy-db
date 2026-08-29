/**
 * Kernel-side matching primitives for composite `triggerBy` fan-out (#1249).
 *
 * Lives in the kernel (not `with-formula/derivations/`) so `collection.ts` can
 * import it statically without dragging derivations code into the floor
 * bundle — the module used to be dynamically imported from `collection.ts`
 * while also being statically imported by `registry.ts`/`dispatch.ts`,
 * which merged it into a chunk that `dist/index.js` ended up pulling in
 * statically.
 * @module
 */

const scalar = (v: unknown): string | null =>
  (typeof v === 'string' || typeof v === 'number') ? String(v) : null

/** Conjunction over one candidate record, same coercion as tupleFromWritten. */
export function recordMatchesPairs(
  rec: Record<string, unknown>,
  pairs: ReadonlyArray<{ field: string; value: string }>,
): boolean {
  return pairs.every((p) => scalar(rec[p.field]) === p.value)
}

/** Scan/filter core for composite fan-out. `residualPairs` are the pairs NOT
 *  already decided by `indexCandidates` (the id set from an equality index for
 *  ONE pair, or null when no pair is indexed). When the index alone decides
 *  membership (`indexCandidates` non-null and no residual pairs left), this
 *  returns the index's answer verbatim with ZERO record reads — matching the
 *  old single-field `_findMatchingIds`' `[...hit]` fast path exactly. */
export async function findMatchingIdsByPairs(
  residualPairs: ReadonlyArray<{ field: string; value: string }>,
  io: {
    indexCandidates: ReadonlyArray<string> | null
    listIds: () => Promise<ReadonlyArray<string>>
    getRecord: (id: string) => Promise<Record<string, unknown> | null>
  },
): Promise<string[]> {
  if (io.indexCandidates !== null && residualPairs.length === 0) return [...io.indexCandidates]
  const ids = io.indexCandidates ?? await io.listIds()
  const out: string[] = []
  for (const id of ids) {
    const rec = await io.getRecord(id)
    if (rec !== null && recordMatchesPairs(rec, residualPairs)) out.push(id)
  }
  return out
}
