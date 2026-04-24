/**
 * Active periods strategy factory. Only reachable through the
 * `@noy-db/hub/periods` subpath.
 */

import {
  loadPeriods,
  chainAnchor,
  assertTsWritable,
  validatePeriodName,
  appendPeriodLedgerEntry,
} from './periods.js'
import type { PeriodsStrategy } from './strategy.js'

/**
 * Build the default periods strategy. Pass into
 * `createNoydb({ periodsStrategy: withPeriods() })` to enable
 * `vault.closePeriod()` / `vault.openPeriod()` / write-guards.
 */
export function withPeriods(): PeriodsStrategy {
  return {
    loadPeriods,
    chainAnchor,
    assertTsWritable,
    validatePeriodName,
    appendPeriodLedgerEntry,
  }
}
