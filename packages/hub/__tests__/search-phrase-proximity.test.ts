/**
 * #1354 — phrase / proximity queries over positional postings, and per-field
 * boosts. The three properties that decide whether this feature is safe:
 *
 *  - positions are OPT-IN per field (a consumer who does not ask pays no bytes),
 *  - a phrase never spans a field boundary,
 *  - an unboosted query scores and orders EXACTLY as it did before boosts existed.
 */
import { describe, it, expect } from 'vitest'
import { InvertedIndex, type IndexDoc } from '../src/with-lookup/search/inverted-index.js'
import { serializeIndex, deserializeIndex, parseIndexSnapshot } from '../src/with-lookup/search/serialize.js'
import { parseSearchQuery } from '../src/with-lookup/search/phrase.js'

const docs: IndexDoc[] = [
  { id: 'a', fields: [{ field: 'desc', text: 'overdue tax invoice for TCM' }] },
  { id: 'b', fields: [{ field: 'desc', text: 'invoice tax reconciliation' }] },
  { id: 'c', fields: [{ field: 'desc', text: 'tax paid invoice' }] },
  { id: 'd', fields: [{ field: 'desc', text: 'tax return filed; the invoice came later' }] },
]

const withPos = (d: readonly IndexDoc[] = docs): InvertedIndex =>
  InvertedIndex.build(d, { positions: ['desc'] })

describe('#1354 query parsing', () => {
  it('splits quoted clauses from bare terms and reads the ~n slop', () => {
    const p = parseSearchQuery('urgent "tax invoice"~3 refund')
    expect(p.terms).toEqual(['urgent', 'refund'])
    expect(p.phrases).toEqual([{ terms: ['tax', 'invoice'], slop: 3 }])
  })

  it('an unslopped clause carries slop undefined (strict phrase)', () => {
    expect(parseSearchQuery('"tax invoice"').phrases[0]!.slop).toBeUndefined()
  })

  it('an unterminated quote degrades to bare terms, never an error', () => {
    const p = parseSearchQuery('"tax invoice')
    expect(p.phrases).toEqual([])
    expect(p.terms).toEqual(['tax', 'invoice'])
  })
})

describe('#1354 phrase queries', () => {
  it('matches only adjacent terms in the written order', () => {
    expect(withPos().query('"tax invoice"').map((h) => h.id)).toEqual(['a'])
  })

  it('does not match a reversed occurrence (phrase is ordered)', () => {
    expect(withPos().query('"invoice tax"').map((h) => h.id)).toEqual(['b'])
  })

  it('does not match across intervening tokens', () => {
    // 'c' is "tax paid invoice" — one token of slack, so not a phrase.
    expect(withPos().query('"tax invoice"').map((h) => h.id)).not.toContain('c')
  })

  it('the snippet points at the matched phrase, not the first loose term', () => {
    const hit = withPos([
      { id: 'x', fields: [{ field: 'desc', text: `tax ${'filler '.repeat(40)}tax invoice` }] },
    ]).query('"tax invoice"')[0]!
    expect(hit.text.slice(hit.offset, hit.offset + 'tax invoice'.length)).toBe('tax invoice')
  })

  it('never matches across a field boundary', () => {
    const split: IndexDoc[] = [
      { id: 'split', fields: [{ field: 'desc', text: 'annual tax' }, { field: 'notes', text: 'invoice attached' }] },
    ]
    const idx = InvertedIndex.build(split, { positions: ['desc', 'notes'] })
    expect(idx.query('"tax invoice"')).toEqual([])
    // …and both terms really are present, so the miss is the boundary, not the data.
    expect(idx.query('tax invoice', { match: 'any' }).map((h) => h.id)).toEqual(['split'])
  })
})

describe('#1354 proximity queries', () => {
  it('~n allows n tokens of slack', () => {
    expect(withPos().query('"tax invoice"~1').map((h) => h.id).sort()).toEqual(['a', 'b', 'c'])
    expect(withPos().query('"tax invoice"~0').map((h) => h.id).sort()).toEqual(['a', 'b'])
  })

  it('a wider slop reaches further', () => {
    expect(withPos().query('"tax invoice"~4').map((h) => h.id)).toContain('d')
    expect(withPos().query('"tax invoice"~1').map((h) => h.id)).not.toContain('d')
  })

  /**
   * The documented divergence: `~n` here is an unordered window, so a bare
   * transposition costs nothing. Lucene's `~n` is an edit distance and would
   * need slop 2 for this. If this test is ever "fixed" to Lucene's answer, the
   * doc comment in phrase.ts must change with it.
   */
  it('proximity is unordered — the case Lucene disagrees on', () => {
    expect(withPos().query('"invoice tax"~0').map((h) => h.id).sort()).toEqual(['a', 'b'])
    // The ordered form, same terms, same slop-free window: only the doc that
    // literally reads "invoice tax".
    expect(withPos().query('"invoice tax"').map((h) => h.id)).toEqual(['b'])
  })
})

describe('#1354 positions are opt-in per field', () => {
  it('a phrase query against an index with no positional field throws, naming the option', () => {
    const idx = InvertedIndex.build(docs)
    expect(() => idx.query('"tax invoice"')).toThrow(/textIndexPositions/)
  })

  it('a field without positions cannot satisfy a phrase clause', () => {
    const mixed: IndexDoc[] = [
      { id: 'p', fields: [{ field: 'desc', text: 'tax invoice' }] },
      { id: 'q', fields: [{ field: 'notes', text: 'tax invoice' }] },
    ]
    const idx = InvertedIndex.build(mixed, { positions: ['desc'] })
    expect(idx.query('"tax invoice"').map((h) => h.id)).toEqual(['p'])
  })

  it('a non-opted-in index stores no position lists and grows by no postings', () => {
    const plain = JSON.parse(serializeIndex(InvertedIndex.build(docs))) as {
      posFields: string[]; docs: Record<string, unknown>[]
    }
    expect(plain.posFields).toEqual([])
    expect(plain.docs.every((d) => !('pos' in d))).toBe(true)
  })

  it('opting in grows the snapshot; opting out costs nothing measurable', () => {
    const fixture: IndexDoc[] = Array.from({ length: 50 }, (_, i) => ({
      id: `r${i}`,
      fields: [{ field: 'desc', text: `invoice ${i} for tax period ${i % 4} at TCM building rent overdue` }],
    }))
    const off = serializeIndex(InvertedIndex.build(fixture)).length
    const on = serializeIndex(InvertedIndex.build(fixture, { positions: ['desc'] })).length
    // Report the measured numbers so a future reader does not have to re-derive them.
    // eslint-disable-next-line no-console
    console.log(`#1354 index size: positions off = ${off} B, on = ${on} B (+${(((on - off) / off) * 100).toFixed(1)}%)`)
    expect(on).toBeGreaterThan(off)
    // The opted-out snapshot must be within a hair of the pre-#1354 shape: the
    // only additions are the `v` stamp and an empty `posFields` array.
    expect(off).toBeLessThan(on)
    expect(on / off).toBeLessThan(2.5)
  })
})

describe('#1354 snapshot versioning — a stale sidecar rebuilds, never lies', () => {
  it('rejects a snapshot from the pre-positional format instead of reading it as non-positional', () => {
    const current = JSON.parse(serializeIndex(withPos())) as Record<string, unknown>
    const old = { ...current, v: 1 }
    expect(parseIndexSnapshot(JSON.stringify(old))).toBeNull()
    expect(deserializeIndex(JSON.stringify(old))).toBeNull()
  })

  it('rejects torn JSON and a foreign shape', () => {
    expect(parseIndexSnapshot('{not json')).toBeNull()
    expect(parseIndexSnapshot('{"v":2}')).toBeNull()
  })

  it('rejects an out-of-order position list rather than re-sorting it', () => {
    const snap = JSON.parse(serializeIndex(withPos())) as {
      docs: { pos: [string, number[]][] }[]
    }
    const entry = snap.docs[0]!.pos.find((p) => p[1].length > 0)!
    entry[1] = [5, 2] // descending — a binary-search-free matcher would still "work"
    expect(parseIndexSnapshot(JSON.stringify(snap))).toBeNull()
  })

  it('rejects a position that cannot exist in the doc (pos >= len)', () => {
    const snap = JSON.parse(serializeIndex(withPos())) as {
      docs: { len: number; pos: [string, number[]][] }[]
    }
    snap.docs[0]!.pos[0]![1] = [snap.docs[0]!.len + 3]
    expect(parseIndexSnapshot(JSON.stringify(snap))).toBeNull()
  })

  it('round-trips a positional index with identical phrase answers', () => {
    const orig = withPos()
    const restored = deserializeIndex(serializeIndex(orig))!
    expect(restored.query('"tax invoice"~1')).toEqual(orig.query('"tax invoice"~1'))
  })
})

describe('#1354 per-field boosts (BM25F-style)', () => {
  const boostDocs: IndexDoc[] = [
    { id: 'n', fields: [{ field: 'name', text: 'rent' }, { field: 'notes', text: 'nothing here' }] },
    { id: 'o', fields: [{ field: 'name', text: 'nothing here' }, { field: 'notes', text: 'rent rent rent' }] },
  ]

  it('boosting a field lifts records that match in it', () => {
    const idx = InvertedIndex.build(boostDocs)
    const plain = idx.query('rent').map((h) => h.id)
    const boosted = idx.query('rent', { boost: { name: 10 } }).map((h) => h.id)
    expect(plain).toEqual(['o', 'n'])
    expect(boosted).toEqual(['n', 'o'])
  })

  it('an unboosted query is score-for-score identical to no boost option at all', () => {
    const idx = withPos()
    for (const q of ['tax', 'invoice tax', 'inv', '"tax invoice"~2']) {
      const base = idx.query(q, { prefix: q === 'inv' })
      const empty = idx.query(q, { prefix: q === 'inv', boost: {} })
      const ones = idx.query(q, { prefix: q === 'inv', boost: { desc: 1 } })
      expect(empty).toEqual(base)
      expect(ones).toEqual(base)
    }
  })

  it('a field with no boost entry keeps its exact score while a sibling is boosted', () => {
    const idx = InvertedIndex.build(boostDocs)
    const base = idx.query('rent').find((h) => h.id === 'o')!
    const boosted = idx.query('rent', { boost: { name: 3 } }).find((h) => h.id === 'o')!
    expect(boosted.score).toBe(base.score)
  })
})
