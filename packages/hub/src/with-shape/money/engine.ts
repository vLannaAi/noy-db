/**
 * Links the money engine into the kernel's runtime seam (#553).
 *
 * Called by `money()` when a descriptor is constructed — the schema
 * declaration is the opt-in unit, so declaring a money field is what
 * pulls the engine (normalize / paths / where / money-reducer) into the
 * consumer's bundle. The kernel floor itself only imports the tiny
 * holder in `kernel/money-runtime.ts` (plus this module's TYPE); without
 * a `money()` call the whole family tree-shakes out.
 */
import { installMoneyEngine } from '../../kernel/money-runtime.js'
import {
  quantizeMoneyFields,
  decodeMoneyFields,
  canonicalizeStoredMoney,
  canonicalizeIncomingMoney,
  moneyScaledValue,
} from './normalize.js'
import { validateMoneyFieldPaths } from './paths.js'
import { moneyFieldClause, evaluateMoneyClause } from './where.js'
import { wrapMoneyReducers } from './money-reducer.js'

/** The engine functions the kernel floor consults on money-declared collections. */
export interface MoneyEngine {
  readonly quantizeMoneyFields: typeof quantizeMoneyFields
  readonly decodeMoneyFields: typeof decodeMoneyFields
  readonly canonicalizeStoredMoney: typeof canonicalizeStoredMoney
  readonly canonicalizeIncomingMoney: typeof canonicalizeIncomingMoney
  readonly moneyScaledValue: typeof moneyScaledValue
  readonly validateMoneyFieldPaths: typeof validateMoneyFieldPaths
  readonly moneyFieldClause: typeof moneyFieldClause
  readonly evaluateMoneyClause: typeof evaluateMoneyClause
  readonly wrapMoneyReducers: typeof wrapMoneyReducers
}

/** Idempotent — safe to call once per `money()` invocation. */
export function linkMoneyEngine(): void {
  installMoneyEngine({
    quantizeMoneyFields,
    decodeMoneyFields,
    canonicalizeStoredMoney,
    canonicalizeIncomingMoney,
    moneyScaledValue,
    validateMoneyFieldPaths,
    moneyFieldClause,
    evaluateMoneyClause,
    wrapMoneyReducers,
  })
}
