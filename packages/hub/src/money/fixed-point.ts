/**
 * Pure fixed-point decimal core for the money descriptor.
 *
 * All conversion goes decimal-string ⇄ scaled `BigInt`. There is no
 * floating-point arithmetic anywhere: a value like `123.45` becomes
 * `12345n` purely by string manipulation, never by `value * 100` (which
 * would reintroduce the very drift money() exists to eliminate). BigInt
 * has no magnitude ceiling, so values past `Number.MAX_SAFE_INTEGER`
 * stay exact end-to-end.
 *
 * This module knows nothing about currencies, descriptors, or storage —
 * it is the isolated, exhaustively-tested arithmetic kernel.
 */

export type RoundingMode =
  | 'half-up'
  | 'half-even'
  | 'half-down'
  | 'up'
  | 'down'
  | 'ceil'
  | 'floor'

export type ParseResult =
  | { ok: true; value: bigint }
  | { ok: false; reason: 'precision' | 'nonfinite' }

/**
 * Expand exponent notation (`1e-7`, `1.5e3`) into a plain decimal
 * string. Returns the input unchanged when it carries no exponent.
 */
function expandExponent(s: string): string {
  const m = /^([+-]?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(s)
  if (!m) return s
  const sign = m[1] === '-' ? '-' : ''
  const intp = m[2]
  const frac = m[3] ?? ''
  const exp = Number(m[4])
  const digits = intp + frac
  const pointPos = intp.length + exp
  let body: string
  if (pointPos <= 0) {
    body = '0.' + '0'.repeat(-pointPos) + digits
  } else if (pointPos >= digits.length) {
    body = digits + '0'.repeat(pointPos - digits.length)
  } else {
    body = digits.slice(0, pointPos) + '.' + digits.slice(pointPos)
  }
  return sign + body
}

/**
 * Normalize an input to a canonical decimal string, or `null` if it is
 * non-finite / not a valid decimal.
 */
function toCanonicalDecimalString(input: number | string): string | null {
  let s: string
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return null
    s = String(input)
  } else {
    s = input.trim()
  }
  s = expandExponent(s)
  if (s.startsWith('+')) s = s.slice(1)
  // optional sign, then digits with at most one dot, at least one digit
  if (!/^-?(\d+(\.\d*)?|\.\d+)$/.test(s)) return null
  return s
}

/**
 * Decide whether the truncated magnitude should be incremented by one
 * minor unit, given the discarded fractional tail. Only called when the
 * tail is known to contain a non-zero digit.
 */
function shouldRoundUp(
  negative: boolean,
  lastKeptDigit: number,
  firstDiscarded: number,
  hasMoreNonZeroAfterFirst: boolean,
  mode: RoundingMode,
): boolean {
  switch (mode) {
    case 'up':
      return true
    case 'down':
      return false
    case 'ceil':
      return !negative
    case 'floor':
      return negative
    case 'half-up':
      return firstDiscarded >= 5
    case 'half-down':
      return firstDiscarded > 5 || (firstDiscarded === 5 && hasMoreNonZeroAfterFirst)
    case 'half-even':
      if (firstDiscarded > 5) return true
      if (firstDiscarded < 5) return false
      // exactly 5 leading the tail
      return hasMoreNonZeroAfterFirst || lastKeptDigit % 2 === 1
  }
}

/**
 * Parse a decimal (`number | string`) into a scaled `BigInt` at the
 * given scale. When the input carries more fractional precision than
 * `scale`:
 *   - `rounding` omitted ⇒ `{ ok: false, reason: 'precision' }`
 *   - `rounding` set ⇒ the tail is rounded per the mode.
 * Non-finite / unparseable input ⇒ `{ ok: false, reason: 'nonfinite' }`.
 */
export function parseToScaledInt(
  input: number | string,
  scale: number,
  rounding?: RoundingMode,
): ParseResult {
  const canonical = toCanonicalDecimalString(input)
  if (canonical === null) return { ok: false, reason: 'nonfinite' }

  const negative = canonical.startsWith('-')
  const unsigned = negative ? canonical.slice(1) : canonical
  const dot = unsigned.indexOf('.')
  const intPart = dot === -1 ? unsigned : unsigned.slice(0, dot)
  const fracPart = dot === -1 ? '' : unsigned.slice(dot + 1)

  const intDigits = intPart === '' ? '0' : intPart

  if (fracPart.length <= scale) {
    const keep = fracPart.padEnd(scale, '0')
    const magnitude = BigInt(intDigits + keep)
    return { ok: true, value: negative && magnitude !== 0n ? -magnitude : magnitude }
  }

  // More precision than scale — inspect the discarded tail.
  const keep = fracPart.slice(0, scale)
  const tail = fracPart.slice(scale)
  const magnitudeDigits = intDigits + keep
  let magnitude = BigInt(magnitudeDigits)

  if (/^0+$/.test(tail)) {
    // tail is all zeros — exact, no rounding required.
    return { ok: true, value: negative && magnitude !== 0n ? -magnitude : magnitude }
  }

  if (rounding === undefined) return { ok: false, reason: 'precision' }

  const lastKeptDigit = Number(magnitudeDigits[magnitudeDigits.length - 1])
  const firstDiscarded = Number(tail[0])
  const hasMoreNonZeroAfterFirst = /[1-9]/.test(tail.slice(1))
  if (shouldRoundUp(negative, lastKeptDigit, firstDiscarded, hasMoreNonZeroAfterFirst, rounding)) {
    magnitude += 1n
  }
  return { ok: true, value: negative && magnitude !== 0n ? -magnitude : magnitude }
}

/**
 * Render a scaled `BigInt` back to its canonical decimal string at the
 * given scale. `(12345n, 2)` → `'123.45'`; `(5n, 0)` → `'5'`;
 * `(-1n, 2)` → `'-0.01'`. Exact for any magnitude.
 */
export function formatScaledInt(value: bigint, scale: number): string {
  const negative = value < 0n
  const abs = (negative ? -value : value).toString()
  if (scale === 0) return (negative ? '-' : '') + abs
  const padded = abs.padStart(scale + 1, '0')
  const cut = padded.length - scale
  const intPart = padded.slice(0, cut)
  const fracPart = padded.slice(cut)
  return (negative ? '-' : '') + intPart + '.' + fracPart
}
