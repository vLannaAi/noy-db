/**
 * #308 L3 — Reciprocal Rank Fusion. Merges N ranked `RetrieveHit` lists into
 * one, scoring each id by Σ 1/(k + rank) across the lists it appears in. Pure,
 * deterministic, no I/O — which is why it serves BOTH hybrid lexical⊕semantic
 * fusion AND klum-db's cross-vault federation (the lists are per-vault). The
 * fused `score` is the RRF score, NOT BM25 or cosine.
 */
import type { RetrieveHit } from './retrieve-types.js'

export interface FuseOptions {
  /** Only 'rrf' in v1 (default). */
  readonly strategy?: 'rrf'
  /** RRF constant; larger flattens the rank weighting. Default 60. */
  readonly k?: number
  /** Truncate the fused output to this many hits. */
  readonly limit?: number
}

export function fuseRetrieval<T>(
  lists: ReadonlyArray<ReadonlyArray<RetrieveHit<T>>>,
  opts: FuseOptions = {},
): RetrieveHit<T>[] {
  const k = opts.k ?? 60
  const acc = new Map<string, { score: number; hit: RetrieveHit<T> }>()
  for (const list of lists) {
    for (const hit of list) {
      const contribution = 1 / (k + hit.rank)
      const prev = acc.get(hit.id)
      if (prev === undefined) {
        acc.set(hit.id, { score: contribution, hit })
      } else {
        prev.score += contribution
        prev.hit = mergePresentation(prev.hit, hit)
      }
    }
  }
  const merged = [...acc.values()].sort(
    (a, b) => b.score - a.score || (a.hit.id < b.hit.id ? -1 : a.hit.id > b.hit.id ? 1 : 0),
  )
  const limited = opts.limit !== undefined ? merged.slice(0, opts.limit) : merged
  return limited.map((m, i) => ({ ...m.hit, score: m.score, rank: i + 1 }))
}

/**
 * When an id appears in multiple lists, prefer the more informative
 * presentation: a real `field`/`snippet`/`locale` (lexical) over the vector
 * placeholder (`'(vector)'` / `''`). Recover `record` from whichever hit has it.
 */
function mergePresentation<T>(a: RetrieveHit<T>, b: RetrieveHit<T>): RetrieveHit<T> {
  const lexical = a.field !== '(vector)' ? a : b
  const other = lexical === a ? b : a
  return {
    ...lexical,
    ...(lexical.record === undefined && other.record !== undefined ? { record: other.record } : {}),
  }
}
