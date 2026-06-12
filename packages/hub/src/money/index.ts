/**
 * `@noy-db/hub` money subsystem — the `money()` field descriptor for
 * currency-safe, exact decimal storage, formatting, and aggregation.
 *
 * @see ./descriptor for the public `money()` factory.
 */

export { money, isMoneyDescriptor, MoneyPrecisionError, MoneyCurrencyError, MoneyUnsupportedError } from './descriptor.js'
export type {
  MoneyDescriptor,
  MoneyOptions,
  MoneyOptionsFixed,
  MoneyOptionsMulti,
} from './descriptor.js'
export type { RoundingMode } from './fixed-point.js'
export { scaleForCurrency } from './iso4217.js'
export type { FxRates } from './money-reducer.js'
export { mulRate, allocate } from './arith.js'
export type { MulRateOptions, AllocateOptions } from './arith.js'
export { asMoney, isMoneyString, moneyNumber } from './branded.js'
export type { MoneyString } from './branded.js'
