/**
 * Exact decimal arithmetic for post-aggregate row math (#1007).
 *
 * Money leaves a reducer as a `MoneyString` — a decimal string, exact by
 * construction. Doing `Number(a) - Number(b)` on two of those re-introduces
 * binary floating point at the one step the money type exists to protect:
 * `10.05 - 0.10` becomes `9.950000000000001`, which `quantizeMoneyFields`
 * then correctly REFUSES rather than silently storing drift.
 *
 * So `derive` is handed these instead. Everything runs in scaled BigInt at the
 * widest scale of its inputs and formats back to a decimal string, which means
 * no operation here can introduce a representation error. Deliberately just
 * the additive set — `add` / `sub` / `neg` / `min` / `max` / `cmp`. Anything
 * needing multiplication or division needs a rounding policy, and a rounding
 * policy is a decision the caller must make explicitly, not one this module
 * should guess.
 *
 * @module
 */

import { ValidationError } from '../../kernel/errors.js'

/** A value these helpers accept: a decimal string, a number, or a bigint of whole units. */
export type ExactOperand = string | number | bigint

/** Scaled representation: `value` is the integer numerator, `scale` the number of decimal places. */
interface Scaled {
  readonly value: bigint
  readonly scale: number
}

const DECIMAL = /^[+-]?\d+(\.\d+)?$/

function parse(operand: ExactOperand, op: string): Scaled {
  if (typeof operand === 'bigint') return { value: operand, scale: 0 }
  const text = typeof operand === 'number'
    // A non-integer JS number has already lost exactness before it reached us;
    // `toString()` gives the shortest round-trip form, which is the closest
    // honest reading of what the caller actually holds.
    ? String(operand)
    : operand.trim()
  if (!DECIMAL.test(text)) {
    throw new ValidationError(
      `exact.${op}: "${text}" is not a decimal value. Pass a decimal string (the shape money fields ` +
        'carry), a number, or a bigint.',
    )
  }
  const [whole, fraction = ''] = text.split('.')
  const digits = `${whole}${fraction}`
  return { value: BigInt(digits), scale: fraction.length }
}

/** Bring two scaled values onto a common scale without losing a digit. */
function align(a: Scaled, b: Scaled): { a: bigint; b: bigint; scale: number } {
  const scale = Math.max(a.scale, b.scale)
  const lift = (s: Scaled) => s.value * 10n ** BigInt(scale - s.scale)
  return { a: lift(a), b: lift(b), scale }
}

function format({ value, scale }: Scaled): string {
  if (scale === 0) return value.toString()
  const negative = value < 0n
  const digits = (negative ? -value : value).toString().padStart(scale + 1, '0')
  const whole = digits.slice(0, digits.length - scale)
  const fraction = digits.slice(digits.length - scale)
  return `${negative ? '-' : ''}${whole}.${fraction}`
}

function binary(op: string, a: ExactOperand, b: ExactOperand, f: (x: bigint, y: bigint) => bigint): string {
  const aligned = align(parse(a, op), parse(b, op))
  return format({ value: f(aligned.a, aligned.b), scale: aligned.scale })
}

/**
 * Exact decimal helpers handed to an MV `derive` as its second argument.
 *
 * Every result is a decimal string, so results compose without ever passing
 * through a float. Declare the derived field in the MV's `moneyFields` and the
 * final value is quantised to that descriptor's scale on the way to storage.
 */
export interface ExactMath {
  /** `a + b`, exact. */
  add(a: ExactOperand, b: ExactOperand): string
  /** `a - b`, exact. */
  sub(a: ExactOperand, b: ExactOperand): string
  /** `-a`, exact. */
  neg(a: ExactOperand): string
  /** The larger of `a` and `b`. */
  max(a: ExactOperand, b: ExactOperand): string
  /** The smaller of `a` and `b`. */
  min(a: ExactOperand, b: ExactOperand): string
  /** `-1` when `a < b`, `0` when equal, `1` when `a > b`. */
  cmp(a: ExactOperand, b: ExactOperand): -1 | 0 | 1
}

/** The singleton passed to `derive` — stateless, so there is nothing to construct per row. */
export const exactMath: ExactMath = {
  add: (a, b) => binary('add', a, b, (x, y) => x + y),
  sub: (a, b) => binary('sub', a, b, (x, y) => x - y),
  neg: (a) => binary('neg', 0, a, (x, y) => x - y),
  max: (a, b) => binary('max', a, b, (x, y) => (x > y ? x : y)),
  min: (a, b) => binary('min', a, b, (x, y) => (x < y ? x : y)),
  cmp: (a, b) => {
    const { a: x, b: y } = align(parse(a, 'cmp'), parse(b, 'cmp'))
    return x < y ? -1 : x > y ? 1 : 0
  },
}
