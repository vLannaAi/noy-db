/**
 * Public option / result types for `collection.retrieve()` (#308 L1). Kept in
 * the search subsystem so collection.ts holds only thin call-sites; re-exported
 * from the search barrel and the hub root.
 */
export interface RetrieveOptions {
  readonly limit?: number
  readonly match?: 'any' | 'all'
  readonly prefix?: boolean
  readonly snippetWindow?: number
  readonly fields?: readonly string[]
  readonly includeRecord?: boolean
  /** #308 — retrieval strategy; defaults to 'lexical'. 'hybrid' fuses lexical+semantic (L3). */
  readonly mode?: 'lexical' | 'semantic' | 'hybrid'
  /** #308 L2 — minimum cosine score for semantic hits (semantic mode only). */
  readonly minScore?: number
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
