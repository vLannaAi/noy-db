/**
 * Scan-mode full-text search — ranks **already-decrypted** records by
 * BM25 against a tokenized query. Pure client-side: nothing is written to the
 * store, so this adds **zero** leakage (unlike a store-usable blind index,
 * which is a separate, gated opt-in).
 *
 * O(n) over the collection; intended for small/medium collections (the pilot's
 * scale) where moving the existing userland scan into the DB is the win.
 */
import { tokenize, type Tokenizer } from './tokenize.js'

export interface SearchOptions {
  /** Top-N by score (default: all matches). */
  readonly limit?: number
  /** `'any'` (default) = OR of query terms; `'all'` = every term must match. */
  readonly match?: 'any' | 'all'
  /** Treat the LAST query term as a prefix (typeahead). */
  readonly prefix?: boolean
}

export interface SearchResult<T> {
  readonly id: string
  readonly score: number
  readonly record: T
}

export interface SearchEntry<T> {
  readonly id: string
  readonly record: T
}

const K1 = 1.2
const B = 0.75

/** Coerce a field value to searchable text (numbers/booleans stringified). */
function fieldText(record: unknown, field: string): string {
  const v = (record as Record<string, unknown>)[field]
  if (typeof v === 'string') return v
  if (v === null || v === undefined) return ''
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return ''
}

export function searchScan<T>(
  entries: ReadonlyArray<SearchEntry<T>>,
  field: string,
  query: string,
  opts: SearchOptions = {},
  tokenizer: Tokenizer = tokenize,
): SearchResult<T>[] {
  const queryTerms = tokenizer(query)
  if (queryTerms.length === 0) return []

  const match = opts.match ?? 'any'
  const usePrefix = opts.prefix ?? false
  const exactTerms = usePrefix ? queryTerms.slice(0, -1) : queryTerms
  const prefixTerm = usePrefix ? queryTerms[queryTerms.length - 1] : undefined

  // One tokenize pass per doc; collect corpus stats (df, avg length).
  const docs = entries.map((e) => ({ id: e.id, record: e.record, terms: tokenizer(fieldText(e.record, field)) }))
  const N = docs.length || 1
  const df = new Map<string, number>()
  let totalLen = 0
  for (const d of docs) {
    totalLen += d.terms.length
    for (const t of new Set(d.terms)) df.set(t, (df.get(t) ?? 0) + 1)
  }
  const avgdl = totalLen / N || 1

  // Document frequency for the prefix term: docs containing ANY term with it.
  let prefixDf = 0
  if (prefixTerm !== undefined) {
    for (const d of docs) {
      if (d.terms.some((t) => t.startsWith(prefixTerm))) prefixDf++
    }
  }

  const requiredCount = exactTerms.length + (prefixTerm !== undefined ? 1 : 0)
  const results: SearchResult<T>[] = []

  for (const d of docs) {
    const tf = new Map<string, number>()
    for (const t of d.terms) tf.set(t, (tf.get(t) ?? 0) + 1)

    const matched: { tf: number; df: number }[] = []
    for (const qt of exactTerms) {
      const c = tf.get(qt) ?? 0
      if (c > 0) matched.push({ tf: c, df: df.get(qt) ?? 0 })
    }
    if (prefixTerm !== undefined) {
      let ptf = 0
      for (const [t, c] of tf) if (t.startsWith(prefixTerm)) ptf += c
      if (ptf > 0) matched.push({ tf: ptf, df: prefixDf })
    }

    if (matched.length === 0) continue
    if (match === 'all' && matched.length < requiredCount) continue

    let score = 0
    for (const m of matched) {
      const idf = Math.log(1 + (N - m.df + 0.5) / (m.df + 0.5))
      const denom = m.tf + K1 * (1 - B + B * (d.terms.length / avgdl))
      score += idf * ((m.tf * (K1 + 1)) / (denom || 1))
    }
    results.push({ id: d.id, score, record: d.record })
  }

  results.sort((a, b) => b.score - a.score)
  return opts.limit !== undefined ? results.slice(0, opts.limit) : results
}
