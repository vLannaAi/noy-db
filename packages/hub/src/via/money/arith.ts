/**
 * Exact money arithmetic helpers — `mulRate` and `allocate`.
 *
 * Both operate on the canonical decoded string form that `get()`
 * returns (`'10000.00'`), entirely in scaled-`BigInt` space — no
 * floating-point step anywhere, exact past 2^53. They are pure
 * functions with no vault or descriptor dependency: the working scale
 * is inferred from the amount's fractional digits (a canonical money
 * string always carries exactly the field's scale) or pinned with
 * `opts.scale`.
 *
 * Why these two: app-side invariants of the form
 * `Σ parts === whole` (receipt totals, net-zero WHT pairs, proration)
 * carry ±0.01 tolerances ONLY because the math is major-unit floats +
 * round2. `mulRate` (VAT-style rate application with explicit
 * rounding) and `allocate` (largest-remainder split — parts sum to the
 * input EXACTLY, by construction) make those tolerances zero.
 */

import {
  parseToScaledInt,
  formatScaledInt,
  rescaleScaledInt,
  decimalScaleOf,
  type RoundingMode,
} from './fixed-point.js'
import { MoneyUnsupportedError } from './descriptor.js'

export interface MulRateOptions {
  /**
   * Output scale (fraction digits). Defaults to the amount's own
   * fractional digits — for a canonical money string that IS the
   * field's scale.
   */
  readonly scale?: number
  /** Rounding for the final re-scale. Default `'half-up'`. */
  readonly rounding?: RoundingMode
}

export interface AllocateOptions {
  /** Working scale. Defaults to the amount's own fractional digits. */
  readonly scale?: number
}

/** Parse `amount` at `scale` or throw the standard money TypeError. */
function parseAmount(label: string, amount: number | string, scale: number, rounding?: RoundingMode): bigint {
  const r = parseToScaledInt(amount, scale, rounding)
  if (!r.ok) {
    throw new MoneyUnsupportedError(
      r.reason === 'precision'
        ? `${label}: amount ${JSON.stringify(amount)} has more precision than scale ${scale} and no rounding mode is configured`
        : `${label}: amount ${JSON.stringify(amount)} is not a finite decimal`,
    )
  }
  return r.value
}

function resolveScale(label: string, amount: number | string, explicit: number | undefined): number {
  if (explicit !== undefined) {
    if (!Number.isInteger(explicit) || explicit < 0) {
      throw new MoneyUnsupportedError(`${label}: scale must be a non-negative integer`)
    }
    return explicit
  }
  const inferred = decimalScaleOf(amount)
  if (inferred === null) {
    throw new MoneyUnsupportedError(`${label}: amount ${JSON.stringify(amount)} is not a finite decimal`)
  }
  return inferred
}

/**
 * Multiply a money amount by a decimal rate, exactly.
 *
 * The rate is parsed at its OWN full precision (`0.07` → `7` at scale
 * 2), the product computed in `BigInt` at `amountScale + rateScale`,
 * then re-scaled back to the output scale with the requested rounding —
 * one rounding step, at the very end.
 *
 * ```ts
 * mulRate('10000.00', 0.07)                       // '700.00'  (VAT)
 * mulRate('33.33', '0.07')                        // '2.33'    (half-up)
 * mulRate('33.33', 0.07, { rounding: 'floor' })   // '2.33'
 * mulRate(100, 0.07, { scale: 2 })                // '7.00'
 * ```
 */
export function mulRate(
  amount: number | string,
  rate: number | string,
  opts: MulRateOptions = {},
): string {
  const scale = resolveScale('mulRate', amount, opts.scale)
  const rounding = opts.rounding ?? 'half-up'
  const a = parseAmount('mulRate', amount, scale, rounding)

  const rateScale = decimalScaleOf(rate)
  if (rateScale === null) {
    throw new MoneyUnsupportedError(`mulRate: rate ${JSON.stringify(rate)} is not a finite decimal`)
  }
  const r = parseToScaledInt(rate, rateScale)
  if (!r.ok) {
    throw new MoneyUnsupportedError(`mulRate: rate ${JSON.stringify(rate)} is not a finite decimal`)
  }

  const product = a * r.value // scaled at scale + rateScale
  return formatScaledInt(rescaleScaledInt(product, scale + rateScale, scale, rounding), scale)
}

/**
 * Split a money amount across weighted buckets with ZERO drift: the
 * returned parts sum to the input exactly, by construction
 * (largest-remainder method).
 *
 * Each bucket gets `floor(amount × weightᵢ / Σweights)`; the leftover
 * minor units (always fewer than the bucket count) go one each to the
 * buckets with the largest truncated remainders — ties broken by
 * position, earlier bucket first. Weights are parsed as exact decimals
 * (no float division anywhere); they must be non-negative with a
 * positive sum.
 *
 * ```ts
 * allocate('100.00', [1, 1, 1])   // ['33.34', '33.33', '33.33']
 * allocate('0.05', [3, 7])        // ['0.02', '0.03']
 * allocate('-100.00', [1, 1, 1])  // ['-33.34', '-33.33', '-33.33']
 * ```
 */
export function allocate(
  amount: number | string,
  weights: ReadonlyArray<number | string>,
  opts: AllocateOptions = {},
): string[] {
  if (weights.length === 0) {
    throw new MoneyUnsupportedError('allocate: weights must not be empty')
  }
  const scale = resolveScale('allocate', amount, opts.scale)
  const a = parseAmount('allocate', amount, scale)

  // Parse every weight as an exact decimal at a common scale, so the
  // proportion arithmetic below is pure BigInt.
  let weightScale = 0
  for (const w of weights) {
    const s = decimalScaleOf(w)
    if (s === null) {
      throw new MoneyUnsupportedError(`allocate: weight ${JSON.stringify(w)} is not a finite decimal`)
    }
    if (s > weightScale) weightScale = s
  }
  const scaledWeights = weights.map(w => {
    const r = parseToScaledInt(w, weightScale)
    if (!r.ok || r.value < 0n) {
      throw new MoneyUnsupportedError(`allocate: weight ${JSON.stringify(w)} must be a non-negative decimal`)
    }
    return r.value
  })
  const sumW = scaledWeights.reduce((acc, w) => acc + w, 0n)
  if (sumW === 0n) {
    throw new MoneyUnsupportedError('allocate: weights must not all be zero')
  }

  // Largest-remainder over the MAGNITUDE; a negative amount negates the
  // parts at the end, so Σparts === amount holds for both signs.
  const negative = a < 0n
  const mag = negative ? -a : a

  const base: bigint[] = []
  const remainders: Array<{ index: number; rem: bigint }> = []
  let distributed = 0n
  for (let i = 0; i < scaledWeights.length; i++) {
    const product = mag * scaledWeights[i]!
    const share = product / sumW
    base.push(share)
    distributed += share
    remainders.push({ index: i, rem: product % sumW })
  }

  // Leftover minor units: strictly fewer than the bucket count.
  let leftover = mag - distributed
  remainders.sort((x, y) => (y.rem > x.rem ? 1 : y.rem < x.rem ? -1 : x.index - y.index))
  for (const { index } of remainders) {
    if (leftover === 0n) break
    base[index] = base[index]! + 1n
    leftover -= 1n
  }

  return base.map(p => formatScaledInt(negative && p !== 0n ? -p : p, scale))
}
