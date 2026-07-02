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
  /** L3 — intersect hits with a structured query (retrieve ∩ where). Eager-mode only. */
  readonly within?: Query<T>
}

export interface RetrieveHit<T> {
  readonly id: string
  readonly score: number
  readonly rank: number
  readonly field: string
  readonly snippet: string
  readonly locale?: string
  readonly record?: T
}
