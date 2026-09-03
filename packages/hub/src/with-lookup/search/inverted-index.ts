/**
 * In-memory inverted index for the L1 lexical retrieval layer. Built
 * client-side from already-decrypted records; nothing touches the store. BM25
 * mirrors src/search/scan.ts; multi-field with max-field combination so a record
 * ranks by its strongest field, which also supplies the snippet location.
 *
 * ## Positional postings (#1354)
 *
 * A field named in {@link IndexBuildOptions.positions} additionally records, per
 * term, the ascending token ordinals it occurs at — which is what phrase
 * (`"tax invoice"`) and proximity (`"tax invoice"~3`) clauses match on. That
 * roughly doubles the per-doc payload (one ordinal per token, on top of the
 * existing tf/firstOffset maps), so it is **opt-in per field**: a field absent
 * from `positions` stores nothing extra and a collection that opts none in
 * serializes a snapshot with no `pos` entries at all.
 *
 * ⭐ Char offsets are NOT stored alongside the ordinals. A matched clause needs
 * one offset, for one hit, to place a snippet — re-segmenting that single doc's
 * text (which the snapshot already carries) is cheaper than paying a second
 * number per token in every persisted index.
 */
import { segmentTokens } from './segment.js'
import { parseSearchQuery, matchClause } from './phrase.js'

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

/** Build-time index shape. The only knob is which fields carry positions. */
export interface IndexBuildOptions {
  /** Fields whose postings record token positions (phrase / proximity). Opt-in: index size grows. */
  readonly positions?: readonly string[]
}

export interface QueryOptions {
  readonly limit?: number
  readonly match?: 'any' | 'all'
  readonly prefix?: boolean
  readonly fields?: readonly string[]
  /**
   * Per-field score weights (BM25F-style, #1354). Purely query-side — nothing
   * in the index changes. A field with no entry weighs 1, and the no-boost path
   * performs no multiplication at all, so an unboosted query's scores are
   * bit-for-bit what they were before boosts existed.
   *
   * ⚠️ Textbook BM25F pools term frequencies ACROSS fields before one
   * saturation step. This index scores each field independently and keeps the
   * best (see the class doc), so a boost weights the per-field score instead.
   * Same intent — "a hit in `name` is worth more than a hit in `notes`" —
   * different arithmetic; do not expect Lucene's BM25F numbers.
   */
  readonly boost?: Readonly<Record<string, number>>
}

/**
 * Persisted shape. `v` is the format stamp: an older stamp is REJECTED and the
 * index rebuilt, never migrated or read leniently — see
 * {@link parseIndexSnapshot}. v1 (pre-#1354) had no `posFields` and no `pos`,
 * and a v1 blob read as v2 would silently answer "this doc has no positions",
 * i.e. "your phrase does not match", which is a wrong answer rather than a slow
 * one.
 */
export const INDEX_SNAPSHOT_VERSION = 2

export interface IndexSnapshot {
  readonly v: number
  /** Fields whose docs carry `pos`. Empty ⇒ nobody opted in. */
  readonly posFields: readonly string[]
  readonly fieldStats: ReadonlyArray<[string, { df: [string, number][]; n: number; totalLen: number }]>
  readonly docs: ReadonlyArray<{
    id: string; field: string; locale?: string; text: string; len: number
    tf: [string, number][]; firstOffset: [string, number][]
    /** term -> ascending token ordinals. Present iff `field` ∈ `posFields`. */
    pos?: [string, number[]][]
  }>
}

interface Doc {
  id: string
  field: string
  locale?: string
  text: string
  len: number
  tf: Map<string, number>
  firstOffset: Map<string, number>
  pos?: Map<string, number[]>
}

export class InvertedIndex {
  // per field: df (term -> #docs), N (#docs), totalLen
  private readonly fieldStats = new Map<string, { df: Map<string, number>; n: number; totalLen: number }>()
  private readonly docs: Doc[] = []
  private posFields: ReadonlySet<string> = EMPTY_FIELDS

  static build(docs: ReadonlyArray<IndexDoc>, opts: IndexBuildOptions = {}): InvertedIndex {
    const idx = new InvertedIndex()
    const positional = new Set(opts.positions ?? [])
    idx.posFields = positional
    for (const d of docs) {
      for (const f of d.fields) {
        const tokens = segmentTokens(f.text)
        const tf = new Map<string, number>()
        const firstOffset = new Map<string, number>()
        const pos = positional.has(f.field) ? new Map<string, number[]>() : undefined
        for (let i = 0; i < tokens.length; i++) {
          const t = tokens[i]!
          tf.set(t.term, (tf.get(t.term) ?? 0) + 1)
          if (!firstOffset.has(t.term)) firstOffset.set(t.term, t.offset)
          if (pos) {
            const list = pos.get(t.term)
            if (list) list.push(i)
            else pos.set(t.term, [i])
          }
        }
        const doc: Doc = {
          id: d.id, field: f.field, ...(f.locale !== undefined ? { locale: f.locale } : {}),
          text: f.text, len: tokens.length, tf, firstOffset, ...(pos ? { pos } : {}),
        }
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

  /** Fields this index carries positions for (#1354) — the store compares it against the live config. */
  get positionFields(): ReadonlySet<string> { return this.posFields }

  query(query: string, opts: QueryOptions = {}): IndexHit[] {
    const parsed = parseSearchQuery(query)
    if (parsed.phrases.length > 0 && this.posFields.size === 0) {
      throw new Error(
        'A phrase or proximity clause ("…" / "…"~n) needs positional postings, and no indexed field ' +
          'declares them. Add the field to the collection\'s `textIndexPositions` option (opt-in: it grows the index).',
      )
    }
    const terms = parsed.terms
    const usePrefix = (opts.prefix ?? false) && terms.length > 0
    const exact = usePrefix ? terms.slice(0, -1) : terms
    const prefix = usePrefix ? terms[terms.length - 1] : undefined
    if (exact.length === 0 && prefix === undefined && parsed.phrases.length === 0) return []
    const match = opts.match ?? 'any'
    const required = exact.length + (prefix !== undefined ? 1 : 0) + parsed.phrases.length

    // best (max-score) doc per record
    const best = new Map<string, IndexHit>()
    for (const doc of this.docs) {
      if (opts.fields !== undefined && !opts.fields.includes(doc.field)) continue
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

      // Clauses are scored FIRST so a matched phrase — not a stray loose term —
      // decides where the snippet window opens.
      for (const clause of parsed.phrases) {
        if (!doc.pos) continue // this field did not opt in: it cannot satisfy a clause
        const m = matchClause(doc.pos, clause)
        if (m.count === 0) continue
        // df for a clause is bounded above by the rarest of its terms' df; the
        // exact clause df would need a second pass over every doc for every
        // query, which buys precision nobody is asking for at L1.
        let df = Infinity
        for (const t of clause.terms) df = Math.min(df, stats.df.get(t) ?? 0)
        scoreTerm(m.count, df === Infinity ? 1 : df || 1, this.charOffsetAt(doc, m.start))
      }

      for (const qt of exact) scoreTerm(doc.tf.get(qt) ?? 0, stats.df.get(qt) ?? 0, doc.firstOffset.get(qt) ?? -1)

      if (prefix !== undefined) {
        // Build a set of exact query terms so we don't double-count a term that
        // is both an exact match and starts with the prefix (defect 2 fix).
        const exactSet = new Set(exact)
        let ptf = 0
        let poff = -1
        for (const [term, c] of doc.tf) {
          if (term.startsWith(prefix) && !exactSet.has(term)) {
            ptf += c
            if (poff < 0) poff = doc.firstOffset.get(term) ?? -1
          }
        }
        if (ptf > 0) {
          // df for the prefix: count DISTINCT docs in this field that have any
          // prefix-matching term — mirrors scan.ts semantics (defect 1 fix).
          let pdf = 0
          for (const d of this.docs) {
            if (d.field === doc.field && [...d.tf.keys()].some((t) => t.startsWith(prefix))) pdf++
          }
          scoreTerm(ptf, pdf || 1, poff)
        }
      }

      if (matchedCount === 0) continue
      if (match === 'all' && matchedCount < required) continue

      // No boost option, or a weight of exactly 1, performs no arithmetic —
      // that is what makes an unboosted ranking provably unchanged (#1354).
      const boost = opts.boost?.[doc.field]
      if (boost !== undefined && boost !== 1) score *= boost

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

  /** Token ordinal → char offset in the ORIGINAL text, by re-segmenting this one doc. */
  private charOffsetAt(doc: Doc, tokenPos: number): number {
    if (tokenPos < 0) return -1
    return segmentTokens(doc.text)[tokenPos]?.offset ?? -1
  }

  toSnapshot(): IndexSnapshot {
    return {
      v: INDEX_SNAPSHOT_VERSION,
      posFields: [...this.posFields],
      fieldStats: [...this.fieldStats].map(([f, s]) => [f, { df: [...s.df], n: s.n, totalLen: s.totalLen }]),
      docs: this.docs.map((d) => ({
        id: d.id, field: d.field, text: d.text, len: d.len,
        tf: [...d.tf], firstOffset: [...d.firstOffset],
        ...(d.locale !== undefined ? { locale: d.locale } : {}),
        ...(d.pos ? { pos: [...d.pos] as [string, number[]][] } : {}),
      })),
    }
  }

  static fromSnapshot(s: IndexSnapshot): InvertedIndex {
    const idx = new InvertedIndex()
    idx.posFields = new Set(s.posFields)
    for (const [f, st] of s.fieldStats) idx.fieldStats.set(f, { df: new Map(st.df), n: st.n, totalLen: st.totalLen })
    for (const d of s.docs) {
      idx.docs.push({
        id: d.id, field: d.field, text: d.text, len: d.len,
        tf: new Map(d.tf), firstOffset: new Map(d.firstOffset),
        ...(d.locale !== undefined ? { locale: d.locale } : {}),
        ...(d.pos ? { pos: new Map(d.pos.map(([t, l]) => [t, [...l]])) } : {}),
      })
    }
    return idx
  }
}

const EMPTY_FIELDS: ReadonlySet<string> = new Set()
