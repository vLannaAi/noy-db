/**
 * Branded money output type (#338).
 *
 * The decoded read shape of a money field is an exact decimal STRING
 * (`'10000.00'`) — but a hand-written schema types it `string | number`,
 * which is honest about the input side and unhelpful on the output
 * side: every read site hand-coerces, and a missed coercion passes
 * typecheck silently (then surfaces as a runtime template warning, or
 * worse, as `'10000.00' * 100` arithmetic).
 *
 * {@link MoneyString} is the output-side brand: a `string` that has
 * been through noy-db's decode (or {@link asMoney}'s guard). Branding
 * is type-level only — zero runtime cost on the read path.
 *
 * ## Wiring the brand through a validator (the input/output asymmetry)
 *
 * Keep the permissive `string | number` on the INPUT side so write
 * sites are untouched, and brand the OUTPUT side. With Zod:
 *
 * ```ts
 * import type { MoneyString } from '@noy-db/hub'
 *
 * const moneyValue = z.union([z.number(), z.string()]) as unknown as
 *   z.ZodType<MoneyString, z.ZodTypeDef, string | number>
 *
 * const Invoice = z.object({ id: z.string(), total: moneyValue })
 * type InvoiceOut = z.output<typeof Invoice> // total: MoneyString
 * type InvoiceIn  = z.input<typeof Invoice>  // total: string | number
 * ```
 *
 * The cast is sound for fields declared in `moneyFields`: reads pass
 * through `decodeMoneyFields`, which always produces the canonical
 * decimal string.
 */

import { decimalScaleOf } from './fixed-point.js'
import { MoneyUnsupportedError } from './descriptor.js'

declare const MONEY_BRAND: unique symbol

/**
 * An exact decimal string produced by noy-db's money decode
 * (`'10000.00'`). The brand exists only at the type level — at runtime
 * a `MoneyString` is a plain string.
 */
export type MoneyString = string & { readonly [MONEY_BRAND]: true }

/**
 * Runtime-guarded cast to {@link MoneyString}. Accepts a decimal string
 * or a number, returns the canonical decimal string branded — throws
 * `MoneyUnsupportedError` on anything non-finite / non-decimal. Use at
 * trust boundaries (deserialized JSON, route params); values read
 * through `get()`/`list()` are already canonical.
 */
export function asMoney(value: string | number): MoneyString {
  if (!isMoneyLike(value)) {
    throw new MoneyUnsupportedError(`asMoney: ${JSON.stringify(value)} is not a finite decimal`)
  }
  return String(value).trim() as MoneyString
}

/** Type guard: is `value` a decimal string acceptable as money? */
export function isMoneyString(value: unknown): value is MoneyString {
  return typeof value === 'string' && isMoneyLike(value)
}

/**
 * The ONE sanctioned escape hatch to a JS `number` — explicit because
 * the conversion is lossy past 2^53. For display math and chart axes;
 * never feed the result back into stored amounts (use `mulRate` /
 * `allocate` for exact arithmetic).
 */
export function moneyNumber(value: MoneyString | string | number): number {
  if (!isMoneyLike(value)) {
    throw new MoneyUnsupportedError(`moneyNumber: ${JSON.stringify(value)} is not a finite decimal`)
  }
  return Number(value)
}

function isMoneyLike(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'string') return false
  return decimalScaleOf(value) !== null
}
