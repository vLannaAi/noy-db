/**
 * The `money()` field descriptor — a branded schema-layer descriptor, a
 * sibling of `i18nText()` / `dictKey()`. It owns currency, scale, and
 * rounding policy for a field; the pure arithmetic lives in
 * {@link ./fixed-point} and default scale resolution in
 * {@link ./iso4217}.
 *
 * Two modes:
 *   - **fixed**  `money({ currency: 'EUR' })` — one currency for the
 *     field; the value stores a bare scaled-integer string.
 *   - **multi**  `money({ currencies: 'any' | [...] })` — currency travels
 *     per record; the value stores `{ amount, currency }`.
 *
 * `currency` and `currencies` are mutually exclusive.
 */

import type { RoundingMode } from './fixed-point.js'
import { scaleForCurrency } from './iso4217.js'
import { NoydbError } from '../../kernel/errors.js'

export interface MoneyOptionsFixed {
  currency: string
  /** Override the ISO-4217 default scale (required for unlisted codes). */
  scale?: number
  rounding?: RoundingMode
}

export interface MoneyOptionsMulti {
  currencies: 'any' | readonly string[]
  /** Per-currency scale overrides (required for unlisted codes). */
  scaleOverrides?: Record<string, number>
  rounding?: RoundingMode
}

export type MoneyOptions = MoneyOptionsFixed | MoneyOptionsMulti

export interface MoneyDescriptor {
  readonly _noydbMoney: true
  readonly mode: 'fixed' | 'multi'
  readonly options: MoneyOptions
  readonly rounding: RoundingMode | undefined
  /** The currency for fixed mode; `undefined` in multi mode. */
  readonly fixedCurrency: string | undefined
  /** Resolve the scale for a currency, throwing if not allowed / unknown. */
  scaleFor(currency: string): number
  /** Whether this descriptor permits the given currency. */
  allows(currency: string): boolean
  /**
   * The single currency this descriptor implies, if any — fixed mode, or
   * multi mode with exactly one allow-listed currency. Lets a multi field
   * accept a bare amount unambiguously. `undefined` otherwise.
   */
  soleCurrency(): string | undefined
}

/** Raised when a written value carries more precision than `scale` allows. */
export class MoneyPrecisionError extends NoydbError {
  constructor(
    public readonly field: string,
    public readonly value: unknown,
    public readonly scale: number,
  ) {
    super(
      'MONEY_PRECISION',
      `money: value ${JSON.stringify(value)} for field "${field}" exceeds scale ${scale} ` +
        `and no rounding mode is configured`,
    )
    this.name = 'MoneyPrecisionError'
  }
}

/** Raised when a currency is disallowed or has no resolvable scale. */
export class MoneyCurrencyError extends NoydbError {
  constructor(
    public readonly currency: string,
    public readonly reason: 'not-allowed' | 'unknown-scale',
    public readonly field?: string,
  ) {
    super(
      'MONEY_CURRENCY',
      reason === 'not-allowed'
        ? `money: currency "${currency}" is not allowed${field ? ` for field "${field}"` : ''}`
        : `money: no scale known for currency "${currency}"${field ? ` (field "${field}")` : ''} — ` +
            `pass an explicit scale / scaleOverrides`,
    )
    this.name = 'MoneyCurrencyError'
  }
}

/** Raised when an aggregate operation is not supported on a money field. */
export class MoneyUnsupportedError extends NoydbError {
  constructor(
    public readonly field: string,
    message?: string,
  ) {
    super(
      'MONEY_UNSUPPORTED',
      message ??
        `money: operation is not supported on field "${field}" — use sum() and count() and divide at the boundary`,
    )
    this.name = 'MoneyUnsupportedError'
  }
}

function isMultiOptions(o: MoneyOptions): o is MoneyOptionsMulti {
  return 'currencies' in o
}

/** Create a {@link MoneyDescriptor}. */
export function money(options: MoneyOptions): MoneyDescriptor {
  const hasFixed = 'currency' in options
  const hasMulti = 'currencies' in options
  if (hasFixed && hasMulti) {
    throw new TypeError('money: `currency` and `currencies` are mutually exclusive')
  }
  if (!hasFixed && !hasMulti) {
    throw new TypeError('money: one of `currency` or `currencies` is required')
  }

  const rounding = options.rounding

  if (isMultiOptions(options)) {
    const overrides = options.scaleOverrides ?? {}
    const allowList = options.currencies
    const allows = (c: string): boolean =>
      allowList === 'any' ? true : allowList.includes(c)
    const scaleFor = (c: string): number => {
      if (!allows(c)) throw new MoneyCurrencyError(c, 'not-allowed')
      const s = overrides[c] ?? scaleForCurrency(c)
      if (s === null || s === undefined) throw new MoneyCurrencyError(c, 'unknown-scale')
      return s
    }
    // Eagerly validate the allow-list resolves (catch typos at construction).
    if (allowList !== 'any') for (const c of allowList) scaleFor(c)
    const soleCurrency = (): string | undefined =>
      allowList !== 'any' && allowList.length === 1 ? allowList[0] : undefined
    return {
      _noydbMoney: true,
      mode: 'multi',
      options,
      rounding,
      fixedCurrency: undefined,
      scaleFor,
      allows,
      soleCurrency,
    }
  }

  // fixed
  const currency = options.currency
  const resolvedScale = options.scale ?? scaleForCurrency(currency)
  if (resolvedScale === null || resolvedScale === undefined) {
    throw new MoneyCurrencyError(currency, 'unknown-scale')
  }
  return {
    _noydbMoney: true,
    mode: 'fixed',
    options,
    rounding,
    fixedCurrency: currency,
    scaleFor(c: string): number {
      if (c !== currency) throw new MoneyCurrencyError(c, 'not-allowed')
      return resolvedScale
    },
    allows: (c: string): boolean => c === currency,
    soleCurrency: (): string | undefined => currency,
  }
}

/** Runtime predicate for detecting a {@link MoneyDescriptor}. */
export function isMoneyDescriptor(x: unknown): x is MoneyDescriptor {
  return (
    typeof x === 'object' &&
    x !== null &&
    (x as { _noydbMoney?: unknown })._noydbMoney === true
  )
}
