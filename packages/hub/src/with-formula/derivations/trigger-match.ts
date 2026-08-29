/**
 * Pure helpers behind composite `triggerBy` (#1249).
 *
 * A trigger entry is a CONJUNCTION of equality pairs: a source record
 * matches when EVERY pair satisfies String(source[to]) === String(written[from]).
 * `from: 'id'` reads the written record's id (winning over any stored field
 * named `id`, matching dispatch's `{ ...incoming, id }` convention). The
 * legacy `on` form normalizes to `[{ from: 'id', to: on }]` so everything
 * downstream has ONE shape.
 *
 * Scalar coercion is verbatim from `_findMatchingIds`: both sides must be
 * string | number; anything else fails the pair (never throws).
 * Spec: docs/superpowers/specs/2026-08-29-composite-triggerby-design.md §4-§5.
 * @module
 */

export interface MatchPair { readonly from: string; readonly to: string }

export interface NormalizedTrigger {
  readonly collection: string
  readonly match: ReadonlyArray<MatchPair>
  readonly maxFanout?: number
}

interface RawTrigger {
  readonly collection: string
  readonly on?: string
  readonly match?: ReadonlyArray<MatchPair>
  readonly maxFanout?: number
}

export function normalizeTriggerBy(triggerBy: ReadonlyArray<RawTrigger> | undefined): NormalizedTrigger[] {
  if (triggerBy === undefined) return []
  return triggerBy.map((t) => ({
    collection: t.collection,
    match: t.match ?? [{ from: 'id', to: t.on! }],
    ...(t.maxFanout !== undefined ? { maxFanout: t.maxFanout } : {}),
  }))
}

const scalar = (v: unknown): string | null =>
  (typeof v === 'string' || typeof v === 'number') ? String(v) : null

/**
 * The value tuple a written record presents to one trigger entry.
 * `null` means "this record cannot address any source" (a from-field is
 * absent or non-scalar) — a legitimate no-match, not an error.
 */
export function tupleFromWritten(
  match: ReadonlyArray<MatchPair>,
  writtenId: string,
  record: Record<string, unknown> | null,
): Array<{ field: string; value: string }> | null {
  const out: Array<{ field: string; value: string }> = []
  for (const pair of match) {
    const v = pair.from === 'id' ? writtenId : scalar(record?.[pair.from])
    if (v === null) return null
    out.push({ field: pair.to, value: v })
  }
  return out
}

/** Any single component differing means NOT the same tuple (spec §7). */
export function sameTuple(
  a: Array<{ field: string; value: string }> | null,
  b: Array<{ field: string; value: string }> | null,
): boolean {
  if (a === null || b === null) return a === b
  return a.length === b.length && a.every((p, i) => p.field === b[i]!.field && p.value === b[i]!.value)
}

/** Conjunction over one candidate record, same coercion as tupleFromWritten. */
export function recordMatchesPairs(
  rec: Record<string, unknown>,
  pairs: ReadonlyArray<{ field: string; value: string }>,
): boolean {
  return pairs.every((p) => scalar(rec[p.field]) === p.value)
}

/** Scan/filter core for composite fan-out. `indexCandidates` is the id set
 *  from an equality index for ONE pair (or null when no pair is indexed);
 *  when present only candidates are read, else every id. */
export async function findMatchingIdsByPairs(
  pairs: ReadonlyArray<{ field: string; value: string }>,
  io: {
    indexCandidates: ReadonlyArray<string> | null
    listIds: () => Promise<ReadonlyArray<string>>
    getRecord: (id: string) => Promise<Record<string, unknown> | null>
  },
): Promise<string[]> {
  const ids = io.indexCandidates ?? await io.listIds()
  const out: string[] = []
  for (const id of ids) {
    const rec = await io.getRecord(id)
    if (rec !== null && recordMatchesPairs(rec, pairs)) out.push(id)
  }
  return out
}
