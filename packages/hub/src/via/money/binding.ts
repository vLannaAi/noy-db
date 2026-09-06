/**
 * The money `NoydbVia` — wires the money engine (normalize/paths/where/
 * money-reducer) into the kernel's generic Via port. `money()`
 * (descriptor.ts) calls {@link linkMoneyVia} at declaration time — the
 * same #553 static-link pattern the retired `linkMoneyEngine()` /
 * `kernel/money-runtime.ts` seam used, now the only one (Task 6 cut the
 * query DSL over to this binding and deleted the legacy seam).
 */
import type { NoydbVia, ViaReadCtx } from '../../kernel/via/index.js'
import { installViaBinder } from '../../kernel/via/index.js'
import type { MoneyDescriptor } from './descriptor.js'
import { quantizeMoneyFields, decodeMoneyFields, canonicalizeStoredMoney, canonicalizeIncomingMoney, moneyScaledValue, canonicalizeMoneyIndexKey, presentVirtualMoneyFields } from './normalize.js'
import { validateMoneyFieldPaths } from './paths.js'
import { moneyFieldClause, evaluateMoneyClause, moneyIndexProbe, type MoneyWhereOperand } from './where.js'
import { wrapMoneyReducers } from './money-reducer.js'
import type { Operator } from '../../kernel/query/predicate.js'
import type { ReduceSpec } from '../../with-lookup/reduce/reduction.js'

/** #669 — the money binder's config bag. `virtualMoneyFields` is the money∩virtual-mode-
 *  computed field-name intersection (`kernel/collection-config.ts#resolveVirtualMoneyFields`);
 *  absent/empty means no field on this collection composes money with a virtual computed
 *  field on itself — the pre-#669 behavior (no `presentLate`, ordinary `present()` for
 *  every declared money field). */
export interface MoneyBindingConfig {
  readonly moneyFields: Record<string, MoneyDescriptor>
  readonly virtualMoneyFields?: ReadonlySet<string>
}

export function moneyVia(moneyFields: Record<string, MoneyDescriptor>, virtualMoneyFields?: ReadonlySet<string>): NoydbVia {
  validateMoneyFieldPaths(moneyFields) // declaration-time (replaces sites 1 & 2)
  const hasVirtualMoney = virtualMoneyFields !== undefined && virtualMoneyFields.size > 0
  // #669 — a field that is BOTH money AND virtual-mode computed has no value yet when
  // money's ORDINARY present() runs (money is first in `_presentOrder`, computed second —
  // the #665 invariant); decodeMoneyFields already no-ops on an absent value, but the skip
  // is made explicit here so the intent reads at the call site: dressing this field happens
  // in `presentLate` below, once computed's present() has actually produced a value.
  const ordinaryPresentFields = hasVirtualMoney
    ? Object.fromEntries(Object.entries(moneyFields).filter(([f]) => !virtualMoneyFields.has(f)))
    : moneyFields
  return {
    brand: 'money',
    presentIsSync: true, // #1416 — decodeMoneyFields / presentVirtualMoneyFields are plain functions
    posture: { encryptedAtRest: 'envelope', queryable: 'ordered', exportable: true, forgettable: true },
    covers: (field) => field in moneyFields,
    ingest: (r) => canonicalizeIncomingMoney(r, moneyFields) as Record<string, unknown>,
    canonicalizeStored: (r) => canonicalizeStoredMoney(r, moneyFields) as Record<string, unknown>,
    encodeWrite: (r) => quantizeMoneyFields(r, moneyFields),
    present: (r, ctx) => decodeMoneyFields(r, ordinaryPresentFields, typeof ctx.locale === 'string' ? ctx.locale : undefined),
    ...(hasVirtualMoney
      ? {
          presentLate: (r: Record<string, unknown>, ctx: ViaReadCtx) =>
            presentVirtualMoneyFields(r, moneyFields, virtualMoneyFields, typeof ctx.locale === 'string' ? ctx.locale : undefined),
        }
      : {}),
    buildClause: (field, op, value) => {
      const desc = moneyFields[field]
      if (!desc) return undefined
      return moneyFieldClause(field, op as Operator, value, desc) // the MoneyWhereOperand payload
    },
    evaluateClause: (actual, op, payload) => evaluateMoneyClause(actual, op as Operator, payload as MoneyWhereOperand),
    indexProbe: (op, payload) => moneyIndexProbe(op as Operator, payload as MoneyWhereOperand),
    canonicalizeIndexKey: (field, rawValue) => canonicalizeMoneyIndexKey(field, rawValue, moneyFields),
    decodeResults: (r) => decodeMoneyFields(r as Record<string, unknown>, moneyFields, 'raw'),
    compareForOrder: (field, a, b) => {
      const desc = moneyFields[field]
      if (!desc) return undefined
      const av = moneyScaledValue(a, desc); const bv = moneyScaledValue(b, desc)
      if (av === null) return bv === null ? 0 : 1
      if (bv === null) return -1
      return av < bv ? -1 : av > bv ? 1 : 0
    },
    wrapReducers: (spec) => wrapMoneyReducers(spec as ReduceSpec, moneyFields),
  }
}

export function linkMoneyVia(): void {
  installViaBinder('money', (cfg) => {
    const c = cfg as MoneyBindingConfig
    return moneyVia(c.moneyFields, c.virtualMoneyFields)
  })
}
