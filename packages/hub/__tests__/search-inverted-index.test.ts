import { describe, it, expect } from 'vitest'
import { InvertedIndex, type IndexDoc } from '../src/search/inverted-index.js'

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
})
