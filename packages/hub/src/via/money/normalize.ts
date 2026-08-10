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
 * callback boundary. Gate handlers (guard `check` /
 * `frozenFields` / `onDelete`, period guard, amendment invariants) and
 * derivation `derive(source, ctx)` callbacks are user-facing: they must
 * see the same decoded canonical decimal that `get()` returns — the
 * scaled-int storage form never escapes. Decoded with `'raw'` (no
 * `<field>Formatted`/`<field>Number` virtuals): these boundaries carry
 * no locale, and fabricating one would re-create a two-read-paths
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
 * write pipeline. Raw user input (pre-quantize) may hold a
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
 * Canonicalize money values for a MATERIALIZED-VIEW row (#1018).
 *
 * A money field in an MV row is NOT in the scaled-integer storage form a
 * collection uses — the money-aware reducers emit `formatScaledInt(...)`, an
 * exact decimal string, and that is what lands in the output collection. So a
 * derived money field has to be canonicalized into the same shape as the
 * aggregated ones beside it.
 *
 * Quantizing it into storage form instead is what #1018 reported: `toPay` came
 * back as `"1000000"` where `netTotal` in the SAME row read `"10000.00"` —
 * 100× the true value, and a string that looks like a plausible amount rather
 * than an obvious error.
 *
 * Precision handling is identical to {@link quantizeMoneyFields} — the same
 * `parseToScaledInt` and the same `MoneyPrecisionError` — so a value that
 * cannot be represented at the declared scale is still refused rather than
 * silently rounded. Only the OUTPUT shape differs: decimal, not scaled.
 */
export function canonicalizeMoneyFieldsAsDecimal<T extends Record<string, unknown>>(
  record: T,
  moneyFields: Record<string, MoneyDescriptor>,
): T {
  const out: Record<string, unknown> = { ...record }
  for (const [field, desc] of Object.entries(moneyFields)) {
    // Only simple top-level fields: an MV row is the flat product of
    // groupBy + aggregate + derive, so there are no nested money paths here.
    if (!isSimpleMoneyPath(field)) continue
    const raw = out[field]
    if (raw === null || raw === undefined) continue

    let amount: number | string
    let scale: number
    if (desc.mode === 'fixed') {
      amount = raw as number | string
      scale = desc.scaleFor(desc.fixedCurrency!)
    } else if (isMoneyValueObject(raw)) {
      amount = raw.amount as number | string
      scale = desc.scaleFor(String(raw.currency))
    } else {
      const sole = desc.soleCurrency()
      if (sole === undefined) {
        throw new TypeError(
          `money: field "${field}" is multi-currency — a derived value must be ` +
            '{ amount, currency }, not a bare amount',
        )
      }
      amount = raw as number | string
      scale = desc.scaleFor(sole)
    }

    const r = parseToScaledInt(amount, scale, desc.rounding)
    if (!r.ok) {
      if (r.reason === 'precision') throw new MoneyPrecisionError(field, amount, scale)
      throw new TypeError(`money: field "${field}" value ${JSON.stringify(amount)} is not a finite decimal`)
    }
    const decimal = formatScaledInt(r.value, scale)
    out[field] = desc.mode === 'fixed' || !isMoneyValueObject(raw)
      ? decimal
      : { amount: decimal, currency: String(raw.currency) }
  }
  return out as T
}

/**
 * Convert money fields in `record` from user input to their canonical
 * stored form. Returns a shallow clone (deep along declared nested
 * paths). A nested path whose declared shape disagrees with the
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
 * The stored scaled-integer value of a money field as a `BigInt`, for
 * exact numeric comparison (e.g. `orderBy` / sorting), or `null` when the
 * stored value is missing/malformed. Mirrors the stored form `decodeValue`
 * reads: a bare scaled-int (fixed mode) or `{ amount, currency }`
 * (multi-currency). Comparison is in scaled space and is exact within a
 * single currency/scale (the `where` / `sum` BigInt model); across
 * currencies of different scales the raw scaled comparison is best-effort.
 */
export function moneyScaledValue(stored: unknown, desc: MoneyDescriptor): bigint | null {
  let raw: unknown
  if (desc.mode === 'fixed') {
    raw = stored
  } else {
    if (!isMoneyValueObject(stored)) return null
    raw = stored.amount
  }
  if (typeof raw !== 'string' && typeof raw !== 'number') return null
  try {
    return BigInt(String(raw))
  } catch {
    return null
  }
}

/**
 * The `ViaBinding.canonicalizeIndexKey` implementation for money (#672) —
 * bucket an eager index's money field entries by the BigInt-normalized
 * scaled-int string, not the raw stored bytes, so a pre-declaration /
 * non-canonical value (e.g. `'0100'`) lands under the SAME key a canonical
 * write produces (`'100'`). Only FIXED-mode declared money fields
 * participate — multi-mode stores `{ amount, currency }`, which has no
 * single bucketable scalar (mirrors `moneyIndexProbe`'s fixed-only gate,
 * `via/money/where.ts`). `undefined` when `field` isn't a declared
 * fixed-mode money field, or the stored value doesn't parse — in both
 * cases the caller falls back to the raw stringified bucket, which is
 * exactly what the scan (`evaluateMoneyClause`) also treats as a
 * non-match, preserving fast-path/scan parity.
 */
export function canonicalizeMoneyIndexKey(
  field: string,
  rawValue: unknown,
  moneyFields: Record<string, MoneyDescriptor>,
): string | undefined {
  const desc = moneyFields[field]
  if (!desc || desc.mode !== 'fixed') return undefined
  return moneyScaledValue(rawValue, desc)?.toString()
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
 * money's `presentLate` hook (#669) — for each field in `virtualMoney` (money ∩
 * virtual-mode computed on the SAME field), quantize the computed fn's fresh
 * MAJOR-UNITS output to the descriptor's scale (with its declared rounding)
 * and present it EXACTLY like a stored money field: the exact decimal string
 * (via {@link formatScaledInt}), plus `<field>Formatted`/`<field>Number` when
 * `locale !== 'raw'`. NEVER the scaled-int decode {@link decodeMoneyFields}
 * runs for a genuinely-stored value — that would misread a virtual field's
 * raw major-unit `21` as 21 SCALED units (`'0.21'`, the #665 corruption this
 * must not reintroduce). Runs AFTER computed's `present()` (the pipeline's
 * `presentLate` fold point, `kernel/via/pipeline.ts`), so `record[field]`
 * already holds the fn's fresh output by the time this runs.
 *
 * Absent/null value → left untouched (nothing to dress). Unparseable value
 * (fails `parseToScaledInt` — e.g. excess precision with no declared
 * rounding) → left RAW, no throw: read-time dressing must never brick a
 * read. Fixed-mode fields only — a virtual field's computed output has no
 * natural `{ amount, currency }` shape to parse for multi-currency mode.
 */
export function presentVirtualMoneyFields<T extends Record<string, unknown>>(
  record: T,
  moneyFields: Record<string, MoneyDescriptor>,
  virtualMoney: ReadonlySet<string>,
  locale: string | undefined,
): T {
  let out: Record<string, unknown> = record
  const format = locale !== 'raw'
  const fmtLocale = typeof locale === 'string' && locale !== 'raw' ? locale : 'en-US'
  for (const field of virtualMoney) {
    const desc = moneyFields[field]
    if (!desc || desc.mode !== 'fixed') continue
    const raw = out[field]
    if (raw === null || raw === undefined) continue
    if (typeof raw !== 'number' && typeof raw !== 'string') continue
    const currency = desc.fixedCurrency!
    const scale = desc.scaleFor(currency)
    const r = parseToScaledInt(raw, scale, desc.rounding)
    if (!r.ok) continue // unparseable / excess precision with no rounding declared — leave raw, no throw
    if (out === record) out = { ...record }
    const decimal = formatScaledInt(r.value, scale)
    out[field] = decimal
    if (format) {
      out[`${field}Formatted`] = formatCurrency(decimal, currency, scale, fmtLocale)
      out[`${field}Number`] = Number(decimal)
    }
  }
  return out as T
}

/**
 * Convert money fields in `record` from stored form to the read shape:
 * an exact decimal string, plus `<field>Formatted` / `<field>Number`
 * virtuals when `locale !== 'raw'`. Returns a shallow clone (deep along
 * declared nested paths; virtuals land as siblings inside the
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
