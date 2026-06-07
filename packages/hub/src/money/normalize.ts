/**
 * Write-side and read-side normalization for money fields.
 *
 * - **Write** ({@link quantizeMoneyFields}): user input (`number | string`,
 *   or `{ amount, currency }` in multi mode) → the canonical *stored*
 *   form — a scaled-integer **digit string** (`'12345'`), or
 *   `{ amount: '12345', currency: 'EUR' }` in multi mode. A JSON number
 *   would truncate past 2^53, so the integer is always stored as a string.
 * - **Read** ({@link decodeMoneyFields}): stored form → an exact decimal
 *   string (`'123.45'`) plus, when formatting is requested, the virtual
 *   `<field>Formatted` (locale currency string) and `<field>Number`
 *   (convenience JS number, explicitly lossy past 2^53).
 *
 * Both return a shallow clone; neither mutates the input record.
 */

import { parseToScaledInt, formatScaledInt } from './fixed-point.js'
import { MoneyPrecisionError, type MoneyDescriptor } from './descriptor.js'

interface MoneyValueObject {
  amount: unknown
  currency: unknown
}

function isMoneyValueObject(v: unknown): v is MoneyValueObject {
  return typeof v === 'object' && v !== null && 'currency' in (v as object)
}

/** Parse one decimal input to a stored digit string at `scale`. */
function quantizeAmount(
  field: string,
  input: number | string,
  scale: number,
  rounding: MoneyDescriptor['rounding'],
): string {
  const r = parseToScaledInt(input, scale, rounding)
  if (!r.ok) {
    if (r.reason === 'precision') throw new MoneyPrecisionError(field, input, scale)
    throw new TypeError(`money: field "${field}" value ${JSON.stringify(input)} is not a finite decimal`)
  }
  return r.value.toString()
}

/**
 * Convert money fields in `record` from user input to their canonical
 * stored form. Returns a shallow clone.
 */
export function quantizeMoneyFields<T extends Record<string, unknown>>(
  record: T,
  moneyFields: Record<string, MoneyDescriptor>,
): T {
  const out: Record<string, unknown> = { ...record }
  for (const [field, desc] of Object.entries(moneyFields)) {
    const raw = out[field]
    if (raw === null || raw === undefined) continue

    if (desc.mode === 'fixed') {
      const currency = desc.fixedCurrency!
      out[field] = quantizeAmount(field, raw as number | string, desc.scaleFor(currency), desc.rounding)
      continue
    }

    // multi mode
    let amount: number | string
    let currency: string
    if (isMoneyValueObject(raw)) {
      currency = String(raw.currency)
      amount = raw.amount as number | string
    } else {
      const sole = desc.soleCurrency()
      if (sole === undefined) {
        throw new TypeError(
          `money: field "${field}" is multi-currency — write { amount, currency }, not a bare amount`,
        )
      }
      currency = sole
      amount = raw as number | string
    }
    const scale = desc.scaleFor(currency) // throws MoneyCurrencyError if disallowed
    out[field] = { amount: quantizeAmount(field, amount, scale, desc.rounding), currency }
  }
  return out as T
}

function formatCurrency(decimal: string, currency: string, scale: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: scale,
    maximumFractionDigits: scale,
  }).format(decimal) // string arg → full precision, exact past 2^53
}

/**
 * Convert money fields in `record` from stored form to the read shape:
 * an exact decimal string, plus `<field>Formatted` / `<field>Number`
 * virtuals when `locale !== 'raw'`. Returns a shallow clone.
 */
export function decodeMoneyFields<T extends Record<string, unknown>>(
  record: T,
  moneyFields: Record<string, MoneyDescriptor>,
  locale: string | undefined,
): T {
  const out: Record<string, unknown> = { ...record }
  const format = locale !== 'raw'
  const fmtLocale = typeof locale === 'string' && locale !== 'raw' ? locale : 'en-US'

  for (const [field, desc] of Object.entries(moneyFields)) {
    const stored = out[field]
    if (stored === null || stored === undefined) continue

    let currency: string
    let scaledIntString: string
    if (desc.mode === 'fixed') {
      currency = desc.fixedCurrency!
      scaledIntString = String(stored)
    } else {
      if (!isMoneyValueObject(stored)) continue // defensive: malformed stored value
      currency = String(stored.currency)
      scaledIntString = String(stored.amount)
    }

    const scale = desc.scaleFor(currency)
    const decimal = formatScaledInt(BigInt(scaledIntString), scale)

    out[field] = desc.mode === 'fixed' ? decimal : { amount: decimal, currency }

    if (format) {
      out[`${field}Formatted`] = formatCurrency(decimal, currency, scale, fmtLocale)
      out[`${field}Number`] = Number(decimal)
    }
  }
  return out as T
}
