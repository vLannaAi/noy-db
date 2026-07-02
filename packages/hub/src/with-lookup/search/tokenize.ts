/**
 * Default text tokenizer for scan-mode search.
 *
 * NFKC-normalize → lowercase → split on Unicode letter/number runs. This is a
 * word-boundary tokenizer: it does **not** segment scripts written without
 * inter-word spaces (Thai, Lao, Khmer, CJK) — those collapse to one token per
 * run. For such data, a dictionary/ICU segmenter is the right `tokenizer`
 * (the engine takes one as a parameter); substring/`contains` matching is the
 * pragmatic fallback until then.
 */
export type Tokenizer = (text: string) => string[]

const WORD = /[\p{L}\p{N}]+/gu

export const tokenize: Tokenizer = (text: string): string[] => {
  if (!text) return []
  return text.normalize('NFKC').toLowerCase().match(WORD) ?? []
}
