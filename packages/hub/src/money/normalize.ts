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
import { isSimpleMoneyPath, parseMoneyPath, transformAtMoneyPath } from './paths.js'

interface MoneyValueObject {
  amount: unknown
  currency: unknown
}

function isMoneyValueObject(v: unknown): v is MoneyValueObject {
  return typeof v === 'object' && v !== null && 'currency' in v
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
 * Canonicalize a STORED-form record's money fields for an internal
 * callback boundary (#332/#335). Gate handlers (guard `check` /
 * `frozenFields` / `onDelete`, period guard, amendment invariants) and
 * derivation `derive(source, ctx)` callbacks are user-facing: they must
 * see the same decoded canonical decimal that `get()` returns — the
 * scaled-int storage form never escapes. Decoded with `'raw'` (no
 * `<field>Formatted`/`<field>Number` virtuals): these boundaries carry
 * no locale, and fabricating one would re-create #322's two-read-paths
 * skew inside comparisons.
 */
export function canonicalizeStoredMoney(
  record: unknown,
  moneyFields: Record<string, MoneyDescriptor> | undefined,
): unknown {
  if (record === null || record === undefined) return record
  if (!moneyFields || Object.keys(moneyFields).length === 0) return record
  return decodeMoneyFields(record as Record<string, unknown>, moneyFields, 'raw')
}

/**
 * Canonicalize an INCOMING record's money fields at the top of the
 * write pipeline (#332/#335). Raw user input (pre-quantize) may hold a
 * number (`10000`), a major-unit string (`'10000.00'`), or a spread of
 * an already-decoded read. Quantize→decode folds all three to the
 * canonical decimal string, so gate handlers, computed-field
 * callbacks, and schema validation all see the `get()` shape — and
 * freeze-style guards comparing `incoming[f]` vs `existing[f]` see
 * equal values for an unchanged field. Best-effort: input that fails
 * to quantize passes through unchanged — the write path quantizes
 * again after validation and surfaces the real
 * `MoneyPrecisionError`/`TypeError`.
 */
export function canonicalizeIncomingMoney(
  record: unknown,
  moneyFields: Record<string, MoneyDescriptor> | undefined,
): unknown {
  if (!moneyFields || Object.keys(moneyFields).length === 0) return record
  try {
    return decodeMoneyFields(
      quantizeMoneyFields(record as Record<string, unknown>, moneyFields),
      moneyFields,
      'raw',
    )
  } catch {
    return record
  }
}

/** Quantize ONE field value (any nesting level) to its stored form. */
function quantizeValue(field: string, raw: unknown, desc: MoneyDescriptor): unknown {
  if (desc.mode === 'fixed') {
    const currency = desc.fixedCurrency!
    return quantizeAmount(field, raw as number | string, desc.scaleFor(currency), desc.rounding)
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
  return { amount: quantizeAmount(field, amount, scale, desc.rounding), currency }
}

/**
 * Convert money fields in `record` from user input to their canonical
 * stored form. Returns a shallow clone (deep along declared nested
 * paths — #334). A nested path whose declared shape disagrees with the
 * data throws: writing through would store an un-quantized amount.
 */
export function quantizeMoneyFields<T extends Record<string, unknown>>(
  record: T,
  moneyFields: Record<string, MoneyDescriptor>,
): T {
  let out: Record<string, unknown> = { ...record }
  for (const [path, desc] of Object.entries(moneyFields)) {
    if (isSimpleMoneyPath(path)) {
      const raw = out[path]
      if (raw === null || raw === undefined) continue
      out[path] = quantizeValue(path, raw, desc)
      continue
    }
    out = transformAtMoneyPath(out, path, parseMoneyPath(path), 0, (container, key) => {
      const raw = (container as Record<string | number, unknown>)[key]
      if (raw === null || raw === undefined) return
      ;(container as Record<string | number, unknown>)[key] = quantizeValue(path, raw, desc)
    }, /* lenient */ false) as Record<string, unknown>
  }
  return out as T
}

function formatCurrency(decimal: string, currency: string, scale: number, locale: string): string {
  const fmt = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: scale,
    maximumFractionDigits: scale,
  })
  // V8's Intl.format accepts a decimal STRING and formats it at full
  // precision (exact past 2^53). The TS lib types only declare
  // number|bigint, so cast — a number arg here would re-introduce the
  // float drift this whole feature exists to eliminate.
  return (fmt.format as unknown as (value: string) => string)(decimal)
}

/**
 * Decode ONE stored field value to its read shape, or `null` when the
 * stored value is malformed (defensive — never brick a read).
 */
function decodeValue(
  stored: unknown,
  desc: MoneyDescriptor,
): { decoded: unknown; decimal: string; currency: string; scale: number } | null {
  let currency: string
  let scaledIntString: string
  if (desc.mode === 'fixed') {
    if (typeof stored !== 'string' && typeof stored !== 'number') return null
    currency = desc.fixedCurrency!
    scaledIntString = String(stored)
  } else {
    if (!isMoneyValueObject(stored)) return null // defensive: malformed stored value
    const amount = stored.amount
    if (typeof stored.currency !== 'string' || (typeof amount !== 'string' && typeof amount !== 'number')) return null
    currency = stored.currency
    scaledIntString = String(amount)
  }
  const scale = desc.scaleFor(currency)
  let decimal: string
  try {
    decimal = formatScaledInt(BigInt(scaledIntString), scale)
  } catch {
    return null // defensive: non-integer stored value
  }
  return {
    decoded: desc.mode === 'fixed' ? decimal : { amount: decimal, currency },
    decimal,
    currency,
    scale,
  }
}

/**
 * Convert money fields in `record` from stored form to the read shape:
 * an exact decimal string, plus `<field>Formatted` / `<field>Number`
 * virtuals when `locale !== 'raw'`. Returns a shallow clone (deep along
 * declared nested paths — #334; virtuals land as siblings inside the
 * nested container, e.g. each `lineItems[]` element gains
 * `amountFormatted`, except for values held directly in arrays where a
 * scalar has no sibling slot). The decode walk is LENIENT: stored data
 * predating a declaration change must stay readable.
 */
export function decodeMoneyFields<T extends Record<string, unknown>>(
  record: T,
  moneyFields: Record<string, MoneyDescriptor>,
  locale: string | undefined,
): T {
  let out: Record<string, unknown> = { ...record }
  const format = locale !== 'raw'
  const fmtLocale = typeof locale === 'string' && locale !== 'raw' ? locale : 'en-US'

  for (const [path, desc] of Object.entries(moneyFields)) {
    if (isSimpleMoneyPath(path)) {
      const stored = out[path]
      if (stored === null || stored === undefined) continue
      const r = decodeValue(stored, desc)
      if (r === null) continue
      out[path] = r.decoded
      if (format) {
        out[`${path}Formatted`] = formatCurrency(r.decimal, r.currency, r.scale, fmtLocale)
        out[`${path}Number`] = Number(r.decimal)
      }
      continue
    }
    out = transformAtMoneyPath(out, path, parseMoneyPath(path), 0, (container, key) => {
      const stored = (container as Record<string | number, unknown>)[key]
      if (stored === null || stored === undefined) return
      const r = decodeValue(stored, desc)
      if (r === null) return
      ;(container as Record<string | number, unknown>)[key] = r.decoded
      if (format && typeof key === 'string' && !Array.isArray(container)) {
        container[`${key}Formatted`] = formatCurrency(r.decimal, r.currency, r.scale, fmtLocale)
        container[`${key}Number`] = Number(r.decimal)
      }
    }, /* lenient */ true) as Record<string, unknown>
  }
  return out as T
}
