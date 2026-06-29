import { describe, it, expect } from 'vitest'
import { fuseRetrieval } from '../src/search/fuse.js'
import type { RetrieveHit } from '../src/search/retrieve-types.js'

const hit = (id: string, rank: number, field = 'text', snippet = 's'): RetrieveHit<unknown> =>
  ({ id, score: 1 / rank, rank, field, snippet })

describe('fuseRetrieval (RRF)', () => {
  it('fuses two lists by reciprocal rank, default k=60', () => {
    const lex = [hit('a', 1), hit('b', 2)]
    const sem = [hit('b', 1, '(vector)', ''), hit('c', 2, '(vector)', '')]
    const out = fuseRetrieval([lex, sem])
    // b is in both: 1/(60+2) + 1/(60+1) = highest; a: 1/61; c: 1/62
    expect(out.map(h => h.id)).toEqual(['b', 'a', 'c'])
    expect(out[0]!.rank).toBe(1)
    expect(out[1]!.rank).toBe(2)
    expect(out[2]!.rank).toBe(3)
    // RRF score, not BM25/cosine
    expect(out[0]!.score).toBeCloseTo(1 / 62 + 1 / 61, 10)
  })

  it('single list is a rank-restamped passthrough (order preserved)', () => {
    const out = fuseRetrieval([[hit('x', 1), hit('y', 2), hit('z', 3)]])
    expect(out.map(h => h.id)).toEqual(['x', 'y', 'z'])
    expect(out.map(h => h.rank)).toEqual([1, 2, 3])
  })

  it('honors limit', () => {
    const out = fuseRetrieval([[hit('a', 1), hit('b', 2), hit('c', 3)]], { limit: 2 })
    expect(out.map(h => h.id)).toEqual(['a', 'b'])
  })

  it('respects a custom k', () => {
    // with k=0, rank-1 contribution is 1/1=1, dominating
    const out = fuseRetrieval([[hit('a', 2)], [hit('b', 1)]], { k: 0 })
    expect(out[0]!.id).toBe('b')
  })

  it('breaks ties deterministically by id ascending', () => {
    // a and b each appear once at rank 1 → equal score
    const out = fuseRetrieval([[hit('b', 1)], [hit('a', 1)]])
    expect(out.map(h => h.id)).toEqual(['a', 'b'])
  })

  it('a merged hit keeps the lexical field/snippet over the vector placeholder', () => {
    const lex = [hit('a', 2, 'description', 'invoice for X')]
    const sem = [hit('a', 1, '(vector)', '')]
    const out = fuseRetrieval([lex, sem])
    expect(out[0]!.field).toBe('description')
    expect(out[0]!.snippet).toBe('invoice for X')
  })

  it('a merged hit recovers record from whichever list carried it', () => {
    const lex: RetrieveHit<{ n: number }>[] = [{ id: 'a', score: 0.5, rank: 1, field: 'text', snippet: 's' }]
    const sem: RetrieveHit<{ n: number }>[] = [{ id: 'a', score: 0.9, rank: 1, field: '(vector)', snippet: '', record: { n: 7 } }]
    const out = fuseRetrieval([lex, sem])
    expect(out[0]!.record).toEqual({ n: 7 })
  })

  it('empty input yields empty output', () => {
    expect(fuseRetrieval([])).toEqual([])
    expect(fuseRetrieval([[], []])).toEqual([])
  })
})
