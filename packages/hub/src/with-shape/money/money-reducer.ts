/**
 * Money-aware aggregation: exact `sum` / `min` / `max` over money
 * fields.
 *
 * The generic reducers (`aggregate/reducers.ts`) read a field via
 * `readNumber`, which coerces a string (the stored scaled-integer form
 * of money, e.g. `'12345'`) to `0` — so an un-wrapped money `sum` would
 * silently return zero. {@link wrapMoneyReducers} rewrites any `sum` /
 * `min` / `max` over a declared money field into a reducer that
 * accumulates per-currency `BigInt` totals of the stored integers, so
 * the result is exact for any magnitude (past `Number.MAX_SAFE_INTEGER`
 * included).
 *
 * Results are currency-aware and never silently mix currencies:
 *   - **fixed** mode → a single exact decimal string.
 *   - **multi** mode → an exact `Record<currency, string>` map.
 *   - **`sum` with `convertTo` + `fx`** → a single exact string, with
 *     each currency converted via BigInt arithmetic (no float).
 *
 * `remove()` is implemented for every money reducer so they participate
 * in incremental live-aggregation and materialized-view maintenance
 * exactly like the generic reducers they replace.
 */

import { readPath } from '../query/predicate.js'
import { formatScaledInt, parseToScaledInt } from './fixed-point.js'
import { scaleForCurrency } from './iso4217.js'
import { MoneyUnsupportedError } from './descriptor.js'
import type { MoneyDescriptor } from './descriptor.js'
import type { Reducer } from '../aggregate/reducers.js'
import type { AggregateSpec } from '../aggregate/aggregation.js'

export type FxRates = Record<string, number | string>

interface ReadMoney {
  currency: string
  value: bigint
}

/**
 * Coerce an arbitrary money-field value into its scaled `BigInt` at the
 * given `scale`. Handles the two shapes a money field can arrive in by
 * the time it reaches a reducer:
 *
 *   - **stored form** — a bare scaled-integer string (`'12345'`) or a
 *     `bigint`. No decimal point, so `BigInt(v)` is the fast path.
 *   - **decoded form** — a canonical decimal string (`'123.45'`), which
 *     is what `query().toArray()` / `decodeMoneyFields` produce (UNION
 *     arms map over decoded rows). `BigInt('123.45')` throws, so these
 *     route through `parseToScaledInt(v, scale)`.
 *
 * A `number` is treated as a decimal magnitude (parsed at `scale`).
 * Anything unparseable → `null`.
 */
function toScaledIntFromAny(v: unknown, scale: number): bigint | null {
  if (typeof v === 'bigint') return v
  if (typeof v === 'number') {
    const r = parseToScaledInt(v, scale)
    return r.ok ? r.value : null
  }
  if (typeof v === 'string') {
    if (!v.includes('.')) {
      // Stored scaled-integer form (e.g. '12345') — no decimal point.
      try {
        return BigInt(v)
      } catch {
        return null
      }
    }
    // Decoded canonical-decimal form (e.g. '123.45').
    const r = parseToScaledInt(v, scale)
    return r.ok ? r.value : null
  }
  return null
}

/** Read the raw stored money value (scaled integer) from a record. */
function readMoney(record: unknown, field: string, desc: MoneyDescriptor): ReadMoney | null {
  const raw = readPath(record, field)
  if (raw === null || raw === undefined) return null
  if (desc.mode === 'fixed') {
    const cur = desc.fixedCurrency!
    const value = toScaledIntFromAny(raw, desc.scaleFor(cur))
    return value === null ? null : { currency: cur, value }
  }
  // multi mode: stored as { amount, currency }
  if (typeof raw !== 'object') return null
  const o = raw as { amount?: unknown; currency?: unknown }
  if (typeof o.currency !== 'string') return null
  const scale = desc.allows(o.currency) ? desc.scaleFor(o.currency) : 0
  const value = toScaledIntFromAny(o.amount, scale)
  return value === null ? null : { currency: o.currency, value }
}

/** Resolve the scale to use for a target currency (may be outside the allow-list). */
function targetScaleFor(desc: MoneyDescriptor, currency: string): number {
  if (desc.allows(currency)) return desc.scaleFor(currency)
  const s = scaleForCurrency(currency)
  if (s === null) {
    throw new Error(`money: cannot determine scale for conversion target "${currency}"`)
  }
  return s
}

/** Parse a rate (number | string) into a scaled BigInt + its scale. */
function parseRate(rate: number | string): { int: bigint; scale: number } {
  const s = String(rate).trim()
  const neg = s.startsWith('-')
  const body = neg ? s.slice(1) : s
  const dot = body.indexOf('.')
  const intPart = dot === -1 ? body : body.slice(0, dot)
  const fracPart = dot === -1 ? '' : body.slice(dot + 1)
  const int = BigInt((intPart === '' ? '0' : intPart) + fracPart)
  return { int: neg ? -int : int, scale: fracPart.length }
}

/** BigInt division of `n / d` with half-even (banker's) rounding. */
function divRoundHalfEven(n: bigint, d: bigint): bigint {
  const q = n / d
  const r = n % d
  const twiceR = (r < 0n ? -r : r) * 2n
  if (twiceR < d) return q
  if (twiceR > d) return q + (n < 0n ? -1n : 1n)
  return q % 2n === 0n ? q : q + (n < 0n ? -1n : 1n)
}

/** Convert a scaled integer from `srcScale` to `targetScale` applying `rate`. */
function convertScaled(value: bigint, srcScale: number, rate: number | string, targetScale: number): bigint {
  const { int: rateInt, scale: rateScale } = parseRate(rate)
  const product = value * rateInt
  const curScale = srcScale + rateScale
  if (curScale === targetScale) return product
  if (curScale < targetScale) return product * 10n ** BigInt(targetScale - curScale)
  return divRoundHalfEven(product, 10n ** BigInt(curScale - targetScale))
}

function finalizeSum(
  state: Map<string, bigint>,
  desc: MoneyDescriptor,
  convertTo: string | undefined,
  fx: FxRates | undefined,
): string | Record<string, string> {
  if (convertTo !== undefined) {
    if (fx === undefined) {
      throw new Error(`money: sum convertTo "${convertTo}" requires an fx rate map`)
    }
    const targetScale = targetScaleFor(desc, convertTo)
    let total = 0n
    for (const [cur, v] of state) {
      if (cur === convertTo) {
        total += convertScaled(v, desc.scaleFor(cur), 1, targetScale)
        continue
      }
      const rate = fx[`${cur}->${convertTo}`]
      if (rate === undefined) {
        throw new Error(`money: no fx rate for "${cur}->${convertTo}"`)
      }
      total += convertScaled(v, desc.scaleFor(cur), rate, targetScale)
    }
    return formatScaledInt(total, targetScale)
  }

  if (desc.mode === 'fixed') {
    const cur = desc.fixedCurrency!
    return formatScaledInt(state.get(cur) ?? 0n, desc.scaleFor(cur))
  }

  const out: Record<string, string> = {}
  for (const [cur, v] of state) out[cur] = formatScaledInt(v, desc.scaleFor(cur))
  return out
}

function moneySumReducer(
  field: string,
  desc: MoneyDescriptor,
  convertTo: string | undefined,
  fx: FxRates | undefined,
): Reducer<unknown, Map<string, bigint>> {
  return {
    op: 'sum',
    field,
    init: () => new Map<string, bigint>(),
    step: (state, record) => {
      const m = readMoney(record, field, desc)
      if (m) state.set(m.currency, (state.get(m.currency) ?? 0n) + m.value)
      return state
    },
    remove: (state, record) => {
      const m = readMoney(record, field, desc)
      if (m) state.set(m.currency, (state.get(m.currency) ?? 0n) - m.value)
      return state
    },
    finalize: (state) => finalizeSum(state, desc, convertTo, fx),
  }
}

function extremum(values: readonly bigint[], op: 'min' | 'max'): bigint {
  let out = values[0]!
  for (let i = 1; i < values.length; i++) {
    const v = values[i]!
    if (op === 'min' ? v < out : v > out) out = v
  }
  return out
}

function moneyMinMaxReducer(
  op: 'min' | 'max',
  field: string,
  desc: MoneyDescriptor,
): Reducer<unknown, Map<string, bigint[]>> {
  return {
    op,
    field,
    init: () => new Map<string, bigint[]>(),
    step: (state, record) => {
      const m = readMoney(record, field, desc)
      if (m) {
        const arr = state.get(m.currency)
        if (arr) arr.push(m.value)
        else state.set(m.currency, [m.value])
      }
      return state
    },
    remove: (state, record) => {
      const m = readMoney(record, field, desc)
      if (m) {
        const arr = state.get(m.currency)
        if (arr) {
          const idx = arr.indexOf(m.value)
          if (idx >= 0) arr.splice(idx, 1)
        }
      }
      return state
    },
    finalize: (state) => {
      if (desc.mode === 'fixed') {
        const cur = desc.fixedCurrency!
        const arr = state.get(cur)
        if (!arr || arr.length === 0) return null
        return formatScaledInt(extremum(arr, op), desc.scaleFor(cur))
      }
      const out: Record<string, string> = {}
      for (const [cur, arr] of state) {
        if (arr.length > 0) out[cur] = formatScaledInt(extremum(arr, op), desc.scaleFor(cur))
      }
      return out
    },
  }
}

/**
 * Rewrite any `sum` / `min` / `max` reducer over a declared money field
 * into its exact BigInt money-aware equivalent. Other reducers (and
 * reducers over non-money fields) pass through unchanged. Returns a new
 * spec; the input is not mutated.
 */
export function wrapMoneyReducers(
  spec: AggregateSpec,
  moneyFields: Record<string, MoneyDescriptor>,
): AggregateSpec {
  let changed = false
  const out: Record<string, Reducer<unknown, unknown>> = {}
  for (const [key, reducer] of Object.entries(spec)) {
    const field = reducer.field
    const desc = field ? moneyFields[field] : undefined
    if (desc && reducer.op === 'avg') {
      throw new MoneyUnsupportedError(
        field!,
        `avg() is not supported on money field "${field}" in v1 — use sum() and count() and divide at the boundary.`,
      )
    }
    if (desc && (reducer.op === 'sum' || reducer.op === 'min' || reducer.op === 'max')) {
      changed = true
      out[key] =
        reducer.op === 'sum'
          ? moneySumReducer(field!, desc, reducer.convertTo, reducer.fx as FxRates | undefined)
          : (moneyMinMaxReducer(reducer.op, field!, desc) as Reducer<unknown, unknown>)
    } else {
      out[key] = reducer
    }
  }
  return changed ? out : spec
}
