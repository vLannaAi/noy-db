/**
 * In-memory inverted index for the L1 lexical retrieval layer (#308). Built
 * client-side from already-decrypted records; nothing touches the store. BM25
 * mirrors src/search/scan.ts; multi-field with max-field combination so a record
 * ranks by its strongest field, which also supplies the snippet location.
 */
import { segmentTokens, segmentTokenizer } from './segment.js'

const K1 = 1.2
const B = 0.75

export interface IndexDoc {
  readonly id: string
  readonly fields: ReadonlyArray<{ readonly field: string; readonly locale?: string; readonly text: string }>
}

export interface IndexHit {
  readonly id: string
  readonly score: number
  readonly field: string
  readonly locale?: string
  readonly text: string
  readonly offset: number
}

export interface QueryOptions {
  readonly limit?: number
  readonly match?: 'any' | 'all'
  readonly prefix?: boolean
}

interface Doc {
  id: string
  field: string
  locale?: string
  text: string
  len: number
  tf: Map<string, number>
  firstOffset: Map<string, number>
}

export class InvertedIndex {
  // per field: df (term -> #docs), N (#docs), totalLen
  private readonly fieldStats = new Map<string, { df: Map<string, number>; n: number; totalLen: number }>()
  private readonly docs: Doc[] = []

  static build(docs: ReadonlyArray<IndexDoc>): InvertedIndex {
    const idx = new InvertedIndex()
    for (const d of docs) {
      for (const f of d.fields) {
        const tokens = segmentTokens(f.text)
        const tf = new Map<string, number>()
        const firstOffset = new Map<string, number>()
        for (const t of tokens) {
          tf.set(t.term, (tf.get(t.term) ?? 0) + 1)
          if (!firstOffset.has(t.term)) firstOffset.set(t.term, t.offset)
        }
        const doc: Doc = { id: d.id, field: f.field, locale: f.locale, text: f.text, len: tokens.length, tf, firstOffset }
        idx.docs.push(doc)
        let s = idx.fieldStats.get(f.field)
        if (!s) { s = { df: new Map(), n: 0, totalLen: 0 }; idx.fieldStats.set(f.field, s) }
        s.n += 1
        s.totalLen += doc.len
        for (const term of tf.keys()) s.df.set(term, (s.df.get(term) ?? 0) + 1)
      }
    }
    return idx
  }

  query(query: string, opts: QueryOptions = {}): IndexHit[] {
    const terms = segmentTokenizer(query)
    if (terms.length === 0) return []
    const usePrefix = opts.prefix ?? false
    const exact = usePrefix ? terms.slice(0, -1) : terms
    const prefix = usePrefix ? terms[terms.length - 1] : undefined
    const match = opts.match ?? 'any'
    const required = exact.length + (prefix !== undefined ? 1 : 0)

    // best (max-score) doc per record
    const best = new Map<string, IndexHit>()
    for (const doc of this.docs) {
      const stats = this.fieldStats.get(doc.field)!
      const avgdl = stats.totalLen / stats.n || 1
      let score = 0
      let matchedCount = 0
      let snippetOffset = -1

      const scoreTerm = (tf: number, df: number, offset: number): void => {
        if (tf <= 0) return
        matchedCount += 1
        if (snippetOffset < 0 && offset >= 0) snippetOffset = offset
        const idf = Math.log(1 + (stats.n - df + 0.5) / (df + 0.5))
        const denom = tf + K1 * (1 - B + B * (doc.len / avgdl))
        score += idf * ((tf * (K1 + 1)) / (denom || 1))
      }

      for (const qt of exact) scoreTerm(doc.tf.get(qt) ?? 0, stats.df.get(qt) ?? 0, doc.firstOffset.get(qt) ?? -1)

      if (prefix !== undefined) {
        let ptf = 0
        let poff = -1
        let pdf = 0
        for (const [term, c] of doc.tf) {
          if (term.startsWith(prefix)) {
            ptf += c
            if (poff < 0) poff = doc.firstOffset.get(term) ?? -1
          }
        }
        if (ptf > 0) {
          // df for the prefix: docs in this field with any term starting with it
          for (const term of stats.df.keys()) if (term.startsWith(prefix)) pdf += stats.df.get(term)!
          scoreTerm(ptf, pdf || 1, poff)
        }
      }

      if (matchedCount === 0) continue
      if (match === 'all' && matchedCount < required) continue

      const hit: IndexHit = {
        id: doc.id, score, field: doc.field, text: doc.text,
        offset: snippetOffset < 0 ? 0 : snippetOffset,
        ...(doc.locale !== undefined ? { locale: doc.locale } : {}),
      }
      const prev = best.get(doc.id)
      if (!prev || hit.score > prev.score) best.set(doc.id, hit)
    }

    const results = [...best.values()].sort((a, b) => b.score - a.score)
    return opts.limit !== undefined ? results.slice(0, opts.limit) : results
  }
}
