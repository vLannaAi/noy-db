/**
 * Phrase / proximity clause parsing and matching over positional postings
 * (#1354).
 *
 * ## The query syntax
 *
 * A double-quoted run inside a `retrieve()` query string is a **clause**;
 * everything outside quotes stays a bare term and behaves exactly as it did
 * before this file existed.
 *
 *  - `"tax invoice"`   — PHRASE: the terms must be adjacent, **in the written
 *                        order**, with nothing between them.
 *  - `"tax invoice"~3` — PROXIMITY: the terms must all occur inside a window
 *                        of `k + 3` tokens (`k` = the clause's term count),
 *                        i.e. at most 3 tokens of slack, **in any order**.
 *
 * ⭐ **Proximity is UNORDERED, and that is a deliberate divergence from
 * Lucene.** Lucene's `~n` is an edit distance over positions, so a mere
 * transposition of two adjacent terms costs 2 and `"invoice tax"~0` does NOT
 * match the text `tax invoice`. Here `~n` reads as *"n words of slack, order
 * irrelevant"* (the Meilisearch / Typesense reading), so `"invoice tax"~0`
 * DOES match `tax invoice`. Pinned by
 * `search-phrase-proximity.test.ts` → *"proximity is unordered — the case
 * Lucene disagrees on"*. Callers who want ordering use the unslopped phrase
 * form, which is strictly ordered.
 *
 * A clause matches **within one field posting only** — positions are recorded
 * per `(record, field)`, so a term ending `name` and a term starting `notes`
 * can never form a phrase. That is a property of the data layout, not a check.
 *
 * Repeated terms in a PROXIMITY clause collapse to a set (`"tax tax"~2`
 * requires only that `tax` occur); a PHRASE clause matches repeats exactly,
 * because it tests literal position arithmetic.
 */
import { segmentTokenizer } from './segment.js'

/** One quoted clause. `slop === undefined` ⇒ strict ordered phrase. */
export interface PhraseClause {
  readonly terms: readonly string[]
  readonly slop: number | undefined
}

export interface ParsedQuery {
  /** Unquoted terms — scored exactly as before #1354. */
  readonly terms: readonly string[]
  readonly phrases: readonly PhraseClause[]
}

const QUOTED = /"([^"]*)"(?:~(\d+))?/g

/**
 * Split a raw query into bare terms + quoted clauses. An unterminated quote
 * has no closing delimiter to match, so it never forms a clause and its text
 * falls through to the bare-term tokenizer — a typo degrades to today's
 * behaviour rather than to an error.
 */
export function parseSearchQuery(query: string): ParsedQuery {
  const phrases: PhraseClause[] = []
  const rest = query.replace(QUOTED, (_m, body: string, slop: string | undefined) => {
    const terms = segmentTokenizer(body)
    // A one-term clause is just that term; keep it a clause anyway so `match:'all'`
    // counts it once, and so `"foo"` never silently means something different
    // from `foo`.
    if (terms.length > 0) phrases.push({ terms, slop: slop === undefined ? undefined : Number(slop) })
    return ' '
  })
  return { terms: segmentTokenizer(rest), phrases }
}

/**
 * Occurrences of a clause inside one field's positional postings, plus the
 * token position the first occurrence starts at (`-1` when there is none).
 *
 * `positions` maps term → ascending token ordinals. A term the posting does
 * not carry is an immediate miss.
 */
export function matchClause(
  positions: ReadonlyMap<string, readonly number[]>,
  clause: PhraseClause,
): { count: number; start: number } {
  const lists: (readonly number[])[] = []
  for (const t of clause.terms) {
    const l = positions.get(t)
    if (l === undefined || l.length === 0) return NO_MATCH
    lists.push(l)
  }
  return clause.slop === undefined
    ? matchOrderedAdjacent(lists)
    : matchWindow(dedupeByTerm(clause.terms, lists), clause.terms.length + clause.slop)
}

const NO_MATCH = { count: 0, start: -1 }

/** Strict phrase: positions p, p+1, … p+k-1, one per term, in written order. */
function matchOrderedAdjacent(lists: readonly (readonly number[])[]): { count: number; start: number } {
  const sets = lists.slice(1).map((l) => new Set(l))
  let count = 0
  let start = -1
  for (const p of lists[0]!) {
    let ok = true
    for (let i = 0; i < sets.length; i++) {
      if (!sets[i]!.has(p + i + 1)) { ok = false; break }
    }
    if (ok) { count++; if (start < 0) start = p }
  }
  return { count, start }
}

/** Distinct terms only — a proximity window asks "are they all here", so a
 *  repeated term must not demand two separate occurrences. */
function dedupeByTerm(
  terms: readonly string[],
  lists: readonly (readonly number[])[],
): readonly (readonly number[])[] {
  const seen = new Set<string>()
  const out: (readonly number[])[] = []
  for (let i = 0; i < terms.length; i++) {
    if (seen.has(terms[i]!)) continue
    seen.add(terms[i]!)
    out.push(lists[i]!)
  }
  return out
}

/**
 * Unordered window: count the windows containing every list at least once
 * whose token span is `< size` (span = max − min + 1 ≤ size). One window is
 * counted per right endpoint after shrinking from the left, so overlapping
 * windows do not inflate the count without bound — it is a frequency signal
 * for BM25, not an exact non-overlapping occurrence count.
 */
function matchWindow(
  lists: readonly (readonly number[])[],
  size: number,
): { count: number; start: number } {
  const merged: { pos: number; term: number }[] = []
  for (let t = 0; t < lists.length; t++) for (const p of lists[t]!) merged.push({ pos: p, term: t })
  merged.sort((a, b) => a.pos - b.pos || a.term - b.term)

  const need = lists.length
  const have = new Array<number>(need).fill(0)
  let distinct = 0
  let left = 0
  let count = 0
  let start = -1
  for (let right = 0; right < merged.length; right++) {
    const rt = merged[right]!.term
    if (have[rt]! === 0) distinct++
    have[rt] = have[rt]! + 1
    while (distinct === need && have[merged[left]!.term]! > 1) {
      const lt = merged[left]!.term
      have[lt] = have[lt]! - 1
      left++
    }
    if (distinct === need && merged[right]!.pos - merged[left]!.pos + 1 <= size) {
      count++
      if (start < 0) start = merged[left]!.pos
    }
  }
  return { count, start }
}
