/**
 * i18n word tokenizer for the L1 lexical index (#308). Uses Intl.Segmenter
 * (standard ECMAScript — hub-portable) to dictionary-segment Thai/Lao/Khmer/CJK,
 * which the word-run `tokenize` cannot. Terms are matched in NFKC-lowercased form;
 * offsets index the ORIGINAL text so snippets slice the user's text.
 */
import type { Tokenizer } from './tokenize.js'

const SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'word' })

export interface Token {
  readonly term: string
  readonly offset: number
}

/** Word-like tokens with NFKC-lowercased terms + original-text char offsets. */
export const segmentTokens = (text: string): Token[] => {
  const out: Token[] = []
  if (!text) return out
  for (const s of SEGMENTER.segment(text)) {
    if (s.isWordLike) out.push({ term: s.segment.normalize('NFKC').toLowerCase(), offset: s.index })
  }
  return out
}

/** Term-only tokenizer (the public `Tokenizer` shape) — for queries. */
export const segmentTokenizer: Tokenizer = (text: string): string[] =>
  segmentTokens(text).map((t) => t.term)
