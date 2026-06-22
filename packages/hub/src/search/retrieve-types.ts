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
}

export interface RetrieveHit<T> {
  readonly id: string
  readonly score: number
  readonly field: string
  readonly snippet: string
  readonly locale?: string
  readonly record?: T
}
