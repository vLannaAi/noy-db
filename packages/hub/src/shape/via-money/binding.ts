/**
 * The money `ViaBinding` — wires the money engine (normalize/paths/where/
 * money-reducer) into the kernel's generic Via port. `money()`
 * (descriptor.ts) calls {@link linkMoneyVia} at declaration time — the
 * same #553 static-link pattern the retired `linkMoneyEngine()` /
 * `kernel/money-runtime.ts` seam used, now the only one (Task 6 cut the
 * query DSL over to this binding and deleted the legacy seam).
 */
import type { ViaBinding } from '../../kernel/via.js'
import { installViaBinder } from '../../kernel/via.js'
import type { MoneyDescriptor } from './descriptor.js'
import { quantizeMoneyFields, decodeMoneyFields, canonicalizeStoredMoney, canonicalizeIncomingMoney, moneyScaledValue } from './normalize.js'
import { validateMoneyFieldPaths } from './paths.js'
import { moneyFieldClause, evaluateMoneyClause, type MoneyWhereOperand } from './where.js'
import { wrapMoneyReducers } from './money-reducer.js'
import type { Operator } from '../../kernel/query/predicate.js'
import type { AggregateSpec } from '../../with-lookup/aggregate/aggregation.js'

export function moneyBinding(moneyFields: Record<string, MoneyDescriptor>): ViaBinding {
  validateMoneyFieldPaths(moneyFields) // declaration-time (replaces sites 1 & 2)
  return {
    brand: 'money',
    posture: { encryptedAtRest: 'envelope', queryable: 'ordered', exportable: true, forgettable: true },
    ingest: (r) => canonicalizeIncomingMoney(r, moneyFields) as Record<string, unknown>,
    canonicalizeStored: (r) => canonicalizeStoredMoney(r, moneyFields) as Record<string, unknown>,
    encodeWrite: (r) => quantizeMoneyFields(r, moneyFields),
    present: (r, ctx) => decodeMoneyFields(r, moneyFields, typeof ctx.locale === 'string' ? ctx.locale : undefined),
    buildClause: (field, op, value) => {
      const desc = moneyFields[field]
      if (!desc) return undefined
      return moneyFieldClause(field, op as Operator, value, desc) // the MoneyWhereOperand payload
    },
    evaluateClause: (actual, op, payload) => evaluateMoneyClause(actual, op as Operator, payload as MoneyWhereOperand),
    decodeResults: (r) => decodeMoneyFields(r as Record<string, unknown>, moneyFields, 'raw'),
    compareForOrder: (field, a, b) => {
      const desc = moneyFields[field]
      if (!desc) return undefined
      const av = moneyScaledValue(a, desc); const bv = moneyScaledValue(b, desc)
      if (av === null) return bv === null ? 0 : 1
      if (bv === null) return -1
      return av < bv ? -1 : av > bv ? 1 : 0
    },
    wrapReducers: (spec) => wrapMoneyReducers(spec as AggregateSpec, moneyFields),
  }
}

export function linkMoneyVia(): void {
  installViaBinder('money', (cfg) => moneyBinding(cfg as Record<string, MoneyDescriptor>))
}
