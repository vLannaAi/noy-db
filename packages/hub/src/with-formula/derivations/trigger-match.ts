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

/** One declared hop through an intermediate collection (#1277). */
export interface MatchVia {
  /** The intermediate collection to resolve through. */
  readonly collection: string
  /** Field on the intermediate whose value equals `written[from]`. */
  readonly take: string
  /** Field on the intermediate whose value is compared against `source[to]`. */
  readonly on: string
}

export interface MatchPair {
  readonly from: string
  readonly to: string
  readonly via?: MatchVia
}

/** True when any pair in this trigger resolves through an intermediate. */
export function hasHop(match: ReadonlyArray<MatchPair>): boolean {
  return match.some((p) => p.via !== undefined)
}

/** Every intermediate collection named by a trigger's pairs, deduplicated. */
export function hopCollections(match: ReadonlyArray<MatchPair>): string[] {
  return [...new Set(match.flatMap((p) => (p.via ? [p.via.collection] : [])))]
}

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

/**
 * Resolve one trigger's pairs into the value tuple a written record presents,
 * following any declared hop (#1277).
 *
 * Non-hop pairs behave exactly as {@link tupleFromWritten}. A hop pair reads
 * `written[from]`, finds the intermediate record whose `via.take` equals it,
 * and substitutes that record's `via.on` value — so everything downstream
 * still compares a flat `{ field, value }` tuple against source records and
 * the existing index-backed matcher is unchanged.
 *
 * Returns `null` when ANY pair cannot produce a value — a missing field, a
 * non-scalar, or an intermediate that does not resolve. That is a legitimate
 * no-match, not an error: a dangling reference addresses nothing, and refusing
 * here would turn a data condition into a thrown exception on every write.
 *
 * ONE lookup per hop per written record. `take: 'id'` is a direct `get`; any
 * other `take` is a field match on the intermediate, which uses its index when
 * one is declared.
 */
export async function resolveTuple(
  match: ReadonlyArray<MatchPair>,
  writtenId: string,
  record: Record<string, unknown> | null,
  lookup: (collection: string, field: string, value: string) => Promise<Record<string, unknown> | null>,
): Promise<Array<{ field: string; value: string }> | null> {
  const out: Array<{ field: string; value: string }> = []
  for (const pair of match) {
    const raw = pair.from === 'id' ? writtenId : scalar(record?.[pair.from])
    if (raw === null) return null
    if (pair.via === undefined) {
      out.push({ field: pair.to, value: raw })
      continue
    }
    const intermediate = await lookup(pair.via.collection, pair.via.take, raw)
    if (intermediate === null) return null
    const hopped = scalar(intermediate[pair.via.on])
    if (hopped === null) return null
    out.push({ field: pair.to, value: hopped })
  }
  return out
}

/**
 * The tuple a written INTERMEDIATE record presents (#1277 option 2).
 *
 * When a record of `via.collection` is written, the sources it addresses are
 * those whose `to` equals the intermediate's own `via.on` value — no lookup is
 * needed, because the intermediate IS the written record. Pairs that do not
 * hop through this collection cannot be constrained by such a write and are
 * skipped, which makes the fan-out deliberately WIDER than a trigger write:
 * refreshing too much is recoverable, refreshing too little is the silent
 * staleness this feature exists to remove.
 *
 * Returns `null` when no pair hops through `collection`, or when the
 * intermediate carries no scalar at `via.on`.
 */
export function tupleFromIntermediate(
  match: ReadonlyArray<MatchPair>,
  collection: string,
  record: Record<string, unknown> | null,
): Array<{ field: string; value: string }> | null {
  const out: Array<{ field: string; value: string }> = []
  for (const pair of match) {
    if (pair.via?.collection !== collection) continue
    const v = scalar(record?.[pair.via.on])
    if (v === null) return null
    out.push({ field: pair.to, value: v })
  }
  return out.length > 0 ? out : null
}

/** Any single component differing means NOT the same tuple (spec §7). */
export function sameTuple(
  a: Array<{ field: string; value: string }> | null,
  b: Array<{ field: string; value: string }> | null,
): boolean {
  if (a === null || b === null) return a === b
  return a.length === b.length && a.every((p, i) => p.field === b[i]!.field && p.value === b[i]!.value)
}

/** Moved to the kernel (#1249) so `collection.ts` can import statically without
 *  dragging derivations code into the floor bundle; re-exported here for
 *  compatibility with existing consumers of this module. */
export { recordMatchesPairs, findMatchingIdsByPairs } from '../../kernel/match-pairs.js'
