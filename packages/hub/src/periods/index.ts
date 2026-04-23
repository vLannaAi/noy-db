/**
 * Accounting-period subpath barrel (v0.17 #201 / #202).
 *
 * Public entry points live on `Vault`:
 *
 *   - `vault.closePeriod({ name, endDate })`
 *   - `vault.openPeriod({ name, startDate, fromPeriod, carryForward })`
 *   - `vault.listPeriods()`
 *   - `vault.getPeriod(name)`
 *
 * These types support user-defined wrappers and tests; the internal
 * helpers (`loadPeriods`, `assertTsWritable`, …) are exported so the
 * Vault can call them without TypeScript barrel gymnastics.
 */
export {
  PERIODS_COLLECTION,
  loadPeriods,
  chainAnchor,
  assertTsWritable,
  validatePeriodName,
  appendPeriodLedgerEntry,
} from './periods.js'
export type {
  PeriodRecord,
  ClosePeriodOptions,
  OpenPeriodOptions,
  CarryForwardContext,
  ReadOnlyCollection,
} from './periods.js'
