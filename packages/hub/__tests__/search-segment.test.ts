import { describe, it, expect } from 'vitest'
import { segmentTokens, segmentTokenizer } from '../src/search/segment.js'

describe('segmentTokenizer (#308 L1)', () => {
  it('segments Latin words and lowercases + NFKC-normalizes the term', () => {
    expect(segmentTokenizer('Overdue Invoice')).toEqual(['overdue', 'invoice'])
  })

  it('segments Thai (no inter-word spaces) into multiple words', () => {
    // 'ใบแจ้งหนี้' = invoice; 'ค้างชำระ' = overdue — should NOT collapse to one token
    const toks = segmentTokenizer('ใบแจ้งหนี้ค้างชำระ')
    expect(toks.length).toBeGreaterThan(1)
    expect(toks.join('')).toContain('ใบแจ้งหนี้')
  })

  it('keeps offsets into the ORIGINAL text (for snippets)', () => {
    const t = segmentTokens('Mr Somchai')
    expect(t[0]).toEqual({ term: 'mr', offset: 0 })
    expect(t[1]!.term).toBe('somchai')
    expect('Mr Somchai'.slice(t[1]!.offset, t[1]!.offset + 7)).toBe('Somchai')
  })

  it('drops whitespace/punctuation (non-word segments)', () => {
    expect(segmentTokenizer('a, b.')).toEqual(['a', 'b'])
  })
})
