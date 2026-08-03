/**
 * Accounting-period subpath barrel.
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
export { withPeriods } from './active.js'
export type { PeriodsStrategy } from './strategy.js'

export {
  PERIODS_COLLECTION,
  PERIOD_FREEZES_COLLECTION,
  PERIOD_ARCHIVES_COLLECTION,
  PERIOD_TARGET_PURGES_COLLECTION,
  periodExclusiveUpperBound,
  loadPeriods,
  chainAnchor,
  assertTsWritable,
  validatePeriodName,
  appendPeriodLedgerEntry,
  purgeMarkersOn,
} from './periods.js'
export type {
  PeriodRecord,
  PeriodFreezeRecord,
  PeriodArchiveRecord,
  PeriodTargetPurgeRecord,
  TargetPurgeCount,
  ClosePeriodOptions,
  OpenPeriodOptions,
  CarryForwardContext,
  ReadOnlyCollection,
} from './periods.js'

/** The un-opted-in stub for this service — exported so callers can compare against it (#844). */
export { NO_PERIODS } from './strategy.js'
