/**
 * Minimal-disclosure snippet: a char-window around a match offset (#308 L1).
 * Unicode-safe (operates on code points). `…` marks each truncated end.
 */
export function extractSnippet(text: string, offset: number, window = 80): string {
  const chars = Array.from(text)
  if (chars.length <= window) return text
  // offset is a UTF-16 index into `text`; map to a code-point index.
  const cpOffset = Array.from(text.slice(0, Math.max(0, offset))).length
  const half = Math.floor(window / 2)
  let start = Math.max(0, cpOffset - half)
  const end = Math.min(chars.length, start + window)
  start = Math.max(0, end - window)
  const body = chars.slice(start, end).join('')
  return `${start > 0 ? '…' : ''}${body}${end < chars.length ? '…' : ''}`
}
