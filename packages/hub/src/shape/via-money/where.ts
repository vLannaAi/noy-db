/**
 * Money-aware `where()` comparison.
 *
 * Query clauses evaluate against RAW stored records — money decode
 * happens on output only — so a money field's stored form is a
 * scaled-integer digit string (`'1000000'`) while the caller naturally
 * writes the operand in major units (`10000`, `'10000.00'`). Without a
 * rewrite the comparison is silently wrong by the scale factor, and a
 * string-vs-number comparison is excluded by `isComparable` anyway.
 *
 * Two halves:
 *
 * - {@link moneyFieldClause} runs at QUERY BUILD time: it quantizes the
 *   caller's major-unit operand into stored scaled-int space via the
 *   same `parseToScaledInt` path as writes, so a malformed operand
 *   throws at `.where()` — not silently filters everything out.
 * - {@link evaluateMoneyClause} runs per record and compares
 *   `BigInt`-exact in scaled space (exact past 2^53, like the rest of
 *   the money service).
 *
 * Currency semantics (multi mode): an operand carries one currency —
 * explicit via `{ amount, currency }`, or the descriptor's sole allowed
 * currency for a bare amount. A record in a DIFFERENT currency has no
 * defined order against the operand: it matches `!=` and nothing else.
 */

import { parseToScaledInt } from './fixed-point.js'
import { MoneyUnsupportedError, type MoneyDescriptor } from './descriptor.js'
import type { Operator } from '../../kernel/query/predicate.js'

/** One quantized operand value: scaled digit string + its currency. */
interface MoneyOperandEntry {
  readonly scaled: string
  readonly currency: string
}

/**
 * The opaque `via` clause payload for a `where()` over a declared money
 * field (see `ViaBinding.buildClause` in kernel/via.ts). `entries` holds
 * one element for comparison ops, two for `between` (lo, hi — same
 * currency), N for `in`.
 */
export interface MoneyWhereOperand {
  readonly mode: 'fixed' | 'multi'
  readonly entries: ReadonlyArray<MoneyOperandEntry>
}

interface MoneyValueObject {
  amount: unknown
  currency: unknown
}

function isMoneyValueObject(v: unknown): v is MoneyValueObject {
  return typeof v === 'object' && v !== null && 'currency' in v
}

/** Quantize ONE operand value to scaled space, resolving its currency. */
function parseOperand(field: string, raw: unknown, desc: MoneyDescriptor): MoneyOperandEntry {
  let amount: unknown
  let currency: string
  if (desc.mode === 'fixed') {
    currency = desc.fixedCurrency!
    amount = raw
  } else if (isMoneyValueObject(raw)) {
    currency = String(raw.currency)
    amount = raw.amount
  } else {
    const sole = desc.soleCurrency()
    if (sole === undefined) {
      throw new MoneyUnsupportedError(
        `where("${field}"): field is multi-currency — compare against { amount, currency }, not a bare amount`,
      )
    }
    currency = sole
    amount = raw
  }
  if (typeof amount !== 'number' && typeof amount !== 'string') {
    throw new MoneyUnsupportedError(
      `where("${field}"): operand ${JSON.stringify(raw)} is not a money amount`,
    )
  }
  const r = parseToScaledInt(amount, desc.scaleFor(currency), desc.rounding)
  if (!r.ok) {
    throw new MoneyUnsupportedError(
      `where("${field}"): operand ${JSON.stringify(amount)} is not a finite decimal`,
    )
  }
  return { scaled: r.value.toString(), currency }
}

/**
 * Build the `via` clause payload ({@link MoneyWhereOperand}) for a
 * `where()` over a declared money field — the `ViaBinding.buildClause`
 * implementation for money. The operand is quantized into stored
 * scaled-int space NOW — build time — so typos throw at the call site.
 */
export function moneyFieldClause(
  field: string,
  op: Operator,
  value: unknown,
  desc: MoneyDescriptor,
): MoneyWhereOperand {
  switch (op) {
    case '==': case '!=': case '<': case '<=': case '>': case '>=': {
      const e = parseOperand(field, value, desc)
      return { mode: desc.mode, entries: [e] }
    }
    case 'between': {
      if (!Array.isArray(value) || value.length !== 2) {
        throw new MoneyUnsupportedError(`where("${field}"): 'between' needs a [lo, hi] tuple`)
      }
      const lo = parseOperand(field, value[0], desc)
      const hi = parseOperand(field, value[1], desc)
      if (lo.currency !== hi.currency) {
        throw new MoneyUnsupportedError(
          `where("${field}"): 'between' bounds mix currencies (${lo.currency} vs ${hi.currency})`,
        )
      }
      return { mode: desc.mode, entries: [lo, hi] }
    }
    case 'in': {
      if (!Array.isArray(value)) {
        throw new MoneyUnsupportedError(`where("${field}"): 'in' needs an array of amounts`)
      }
      return { mode: desc.mode, entries: value.map(v => parseOperand(field, v, desc)) }
    }
    default:
      // contains / startsWith — string ops have no meaning in scaled space.
      throw new MoneyUnsupportedError(
        `where("${field}"): operator '${op}' is not supported on a money field`,
      )
  }
}

/** Read a raw STORED money value into scaled space, or null if absent/malformed. */
function readStored(actual: unknown, operand: MoneyWhereOperand): MoneyOperandEntry | null {
  let amount: unknown
  let currency: string
  if (operand.mode === 'fixed') {
    if (typeof actual !== 'string' && typeof actual !== 'number') return null
    amount = actual
    currency = operand.entries[0]?.currency ?? ''
  } else {
    if (!isMoneyValueObject(actual)) return null
    if (typeof actual.currency !== 'string') return null
    amount = actual.amount
    currency = actual.currency
  }
  if (typeof amount !== 'string' && typeof amount !== 'number') return null
  try {
    return { scaled: BigInt(amount).toString(), currency }
  } catch {
    return null
  }
}

/**
 * Per-record evaluation of a money clause: BigInt-exact comparison in
 * scaled-integer space. `actual` is the RAW stored field value.
 *
 * Missing/malformed stored values and cross-currency comparisons match
 * `!=` only — consistent with the generic clause semantics where an
 * absent field is "not equal" and has no defined order.
 */
export function evaluateMoneyClause(
  actual: unknown,
  op: Operator,
  operand: MoneyWhereOperand,
): boolean {
  const stored = readStored(actual, operand)
  if (stored === null) return op === '!='
  const a = BigInt(stored.scaled)

  if (op === 'in') {
    return operand.entries.some(
      e => e.currency === stored.currency && BigInt(e.scaled) === a,
    )
  }
  if (op === 'between') {
    const [lo, hi] = operand.entries
    if (!lo || !hi || lo.currency !== stored.currency) return false
    return a >= BigInt(lo.scaled) && a <= BigInt(hi.scaled)
  }

  const e = operand.entries[0]
  if (!e) return false
  if (e.currency !== stored.currency) return op === '!='
  const b = BigInt(e.scaled)
  switch (op) {
    case '==': return a === b
    case '!=': return a !== b
    case '<': return a < b
    case '<=': return a <= b
    case '>': return a > b
    case '>=': return a >= b
    default: return false
  }
}
