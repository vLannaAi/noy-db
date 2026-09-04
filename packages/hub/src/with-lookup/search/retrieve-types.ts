/**
 * Public option / result types for `collection.retrieve()` (L1). Kept in
 * the search service so collection.ts holds only thin call-sites; re-exported
 * from the search barrel and the hub root.
 */
import type { Query } from '../../kernel/query/builder.js'

export interface RetrieveOptions<T = unknown> {
  readonly limit?: number
  readonly match?: 'any' | 'all'
  readonly prefix?: boolean
  readonly snippetWindow?: number
  readonly fields?: readonly string[]
  readonly includeRecord?: boolean
  /** Retrieval strategy; defaults to 'lexical'. 'hybrid' fuses lexical+semantic (L3). */
  readonly mode?: 'lexical' | 'semantic' | 'hybrid'
  /** L2 — minimum cosine score for semantic hits (semantic mode only). */
  readonly minScore?: number
  /**
   * L3 — intersect hits with a structured query (retrieve ∩ where). Eager-mode
   * only. Also the typed half of retrieval (#1343): money / number / date /
   * boolean fields are not tokenised into the lexical index, so a typed match
   * is expressed here as a `Query` and compared in the field's canonical space
   * by the query engine. Scoring stays global, `limit` counts NARROWED hits,
   * an empty result set yields no hits, and an empty text query paired with a
   * `within` is typed-only retrieval. See `retrieve()` in `collection-facade`.
   */
  readonly within?: Query<T>
  /**
   * Per-field score weights (#1354), e.g. `{ boost: { name: 3, notes: 1 } }`.
   * Query-side only — the index is unchanged, and omitting this leaves every
   * score exactly as it was. Fields not named weigh 1.
   */
  readonly boost?: Readonly<Record<string, number>>
  /**
   * #1360 part 2 — force an EXACT brute-force semantic scan for this call,
   * bypassing any approximate index the collection opted into. Ignored in
   * lexical mode. Exactness must stay reachable per query: a caller who needs
   * a guaranteed complete top-k (an audit, a recall measurement, a test) asks
   * for it here rather than being told to reconfigure the collection.
   */
  readonly exact?: boolean
  /**
   * #1360 part 2 — per-query recall dial for the approximate index (lists
   * probed). Overrides `withVectorIndex({ nprobe })` for this call. No effect
   * when the query is exact.
   */
  readonly nprobe?: number
}

/**
 * Options for `collection.similarTo()` — raw-vector kNN. Lives here beside
 * {@link RetrieveOptions} because it is the same kind of thing: a public
 * option bag on the retrieval surface.
 */
export interface SimilarToOptions {
  readonly k?: number
  readonly minScore?: number
  readonly includeRecord?: boolean
  /** #1360 part 2 — force the exact brute-force scan, whatever the index policy says. */
  readonly exact?: boolean
  /** #1360 part 2 — per-query recall dial (lists probed) for the approximate index. */
  readonly nprobe?: number
}

export interface RetrieveHit<T> {
  readonly id: string
  readonly score: number
  readonly rank: number
  readonly field: string
  readonly snippet: string
  readonly locale?: string
  readonly record?: T
  /**
   * #1360 — for a semantic hit on a CHUNKED record: the winning chunk's id and
   * its `[start, end)` character offsets into
   * `embeddingSourceText(record, descriptor.source)` (the joined source text,
   * not a single field). `snippet` already carries `sourceText.slice(start,
   * end)` when the record is in the eager cache; the offsets are returned so a
   * consumer can highlight in place. Absent for lexical hits and for
   * unchunked (single-vector) semantic hits.
   */
  readonly chunk?: { readonly id: string; readonly start: number; readonly end: number }
}
