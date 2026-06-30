import { describe, it, expect } from 'vitest'
import { InvertedIndex, type IndexDoc } from '../src/with-lookup/search/inverted-index.js'

const docs: IndexDoc[] = [
  { id: 'a', fields: [{ field: 'desc', text: 'overdue invoice for TCM' }] },
  { id: 'b', fields: [{ field: 'desc', text: 'paid invoice' }, { field: 'notes', text: 'TCM building rent' }] },
  { id: 'c', fields: [{ field: 'desc', text: 'office supplies' }] },
]

describe('InvertedIndex (#308 L1)', () => {
  it('ranks docs containing the query term, best-field score', () => {
    const idx = InvertedIndex.build(docs)
    const hits = idx.query('invoice')
    expect(hits.map((h) => h.id).sort()).toEqual(['a', 'b'])
    expect(hits.every((h) => h.field === 'desc')).toBe(true)
  })

  it('searches across multiple fields and reports the winning field + offset', () => {
    const idx = InvertedIndex.build(docs)
    const hits = idx.query('TCM')
    const b = hits.find((h) => h.id === 'b')!
    expect(b.field).toBe('notes')
    expect(b.text.slice(b.offset, b.offset + 3)).toBe('TCM')
  })

  it("match:'all' requires every term; 'any' is OR", () => {
    const idx = InvertedIndex.build(docs)
    expect(idx.query('overdue invoice', { match: 'all' }).map((h) => h.id)).toEqual(['a'])
    expect(idx.query('overdue paid', { match: 'any' }).map((h) => h.id).sort()).toEqual(['a', 'b'])
  })

  it('prefix matches the last query term as a prefix (typeahead)', () => {
    const idx = InvertedIndex.build(docs)
    expect(idx.query('inv', { prefix: true }).map((h) => h.id).sort()).toEqual(['a', 'b'])
  })

  it('limit caps results', () => {
    const idx = InvertedIndex.build(docs)
    expect(idx.query('invoice', { limit: 1 }).length).toBe(1)
  })

  it('one hit per record (deduped to the best field)', () => {
    const idx = InvertedIndex.build([{ id: 'x', fields: [{ field: 'desc', text: 'TCM' }, { field: 'notes', text: 'TCM TCM' }] }])
    const hits = idx.query('TCM')
    expect(hits.length).toBe(1)
    expect(hits[0]!.field).toBe('notes') // higher tf
  })

  // Defect 1 regression: prefix df must count DISTINCT docs, not sum per-term df.
  // Doc A has "invoice" and "inventory" (both start with "inv"); doc B has "invoice".
  // Correct df for prefix "inv" = 2 (two distinct docs), NOT 3 (sum: A=2, B=1).
  it('prefix df counts distinct docs, not sum of per-term df (#308 L1 defect 1)', () => {
    const prefixDocs: IndexDoc[] = [
      { id: 'A', fields: [{ field: 'text', text: 'invoice inventory' }] },
      { id: 'B', fields: [{ field: 'text', text: 'invoice' }] },
    ]
    const idx = InvertedIndex.build(prefixDocs)
    const hits = idx.query('inv', { prefix: true })
    // Both docs must be returned
    expect(hits.map((h) => h.id).sort()).toEqual(['A', 'B'])
    // Both scores must be finite and positive
    expect(hits.every((h) => h.score > 0 && isFinite(h.score))).toBe(true)
    // Key assertion: with correct distinct-doc df=2, the idf is log(1+(2-2+0.5)/(2+0.5))=log(1+0.2)
    // With wrong sum df=3, idf would be log(1+(2-3+0.5)/(3+0.5))=log(1+(-0.5/3.5)) — negative or near-zero
    // Both scores must be positive, confirming df=2 (distinct) is used, not df=3 (sum).
    // Also: A should not be penalized relative to B purely from df over-count.
    const hitA = hits.find((h) => h.id === 'A')!
    const hitB = hits.find((h) => h.id === 'B')!
    // A has higher combined tf (invoice=1 + inventory=1 = ptf=2), B has ptf=1.
    // With correct df=2, A scores higher than B.
    expect(hitA.score).toBeGreaterThan(hitB.score)
  })

  // Defect 2 regression: exact term must not be double-counted when it also matches the prefix.
  // Query "invoice inv" with prefix:true → exact=["invoice"], prefix="inv".
  // "invoice".startsWith("inv") is true, so without the fix, "invoice" is scored twice.
  // Fix: skip exact terms in the prefix accumulation loop.
  it('exact term not double-counted as prefix match (#308 L1 defect 2)', () => {
    const singleDoc: IndexDoc[] = [
      { id: 'X', fields: [{ field: 'text', text: 'invoice paid' }] },
    ]
    const idx = InvertedIndex.build(singleDoc)
    // Score for exact "invoice" alone
    const scoreExact = idx.query('invoice')[0]!.score
    // Score for "invoice inv" with prefix: "inv" only matches "invoice" (already exact) → no new contribution
    const scorePrefixed = idx.query('invoice inv', { prefix: true, match: 'any' })[0]!.score
    // Without the fix, scorePrefixed > scoreExact because "invoice" is counted twice.
    // With the fix, the prefix adds no new terms, so score equals the exact-only score.
    expect(scorePrefixed).toBeCloseTo(scoreExact, 10)
  })
})
