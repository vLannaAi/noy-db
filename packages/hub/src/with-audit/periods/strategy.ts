/**
 * Strategy seam for the optional accounting-periods subsystem. Core
 * imports `PeriodsStrategy` type-only + `NO_PERIODS` stub; the real
 * `loadPeriods` / `chainAnchor` / `assertTsWritable` /
 * `validatePeriodName` / `appendPeriodLedgerEntry` functions are
 * only reachable via `withPeriods()` in `./active.ts`.
 *
 * Applications that never call `vault.closePeriod()` /
 * `vault.openPeriod()` ship none of the ~363 LOC.
 *
 * @internal
 */

import type { EncryptedEnvelope, NoydbStore } from '../types.js'
import type { LedgerStore } from '../history/ledger/store.js'
import type { PeriodRecord } from './periods.js'

/**
 * @internal
 */
export interface PeriodsStrategy {
  loadPeriods(
    adapter: NoydbStore,
    vault: string,
    decrypt: (envelope: EncryptedEnvelope) => Promise<PeriodRecord>,
  ): Promise<PeriodRecord[]>
  chainAnchor(records: readonly PeriodRecord[]): Promise<{
    priorPeriodName?: string
    priorPeriodHash: string
  }>
  assertTsWritable(
    existing: { ts: string | null; record: Record<string, unknown> | null } | null,
    incoming: Record<string, unknown> | null,
    periods: readonly PeriodRecord[],
  ): void
  validatePeriodName(name: string, existing: readonly PeriodRecord[]): void
  appendPeriodLedgerEntry(
    ledger: LedgerStore | null,
    actor: string,
    envelope: EncryptedEnvelope,
    periodName: string,
  ): Promise<void>
}

/**
 * No-periods stub. `loadPeriods` returns `[]`; the write-guards do
 * nothing (vaults without closed periods never reject writes);
 * `validatePeriodName` / `appendPeriodLedgerEntry` throw because
 * those paths are only reached when the user explicitly called
 * `closePeriod()` / `openPeriod()` — if they did that without the
 * strategy, they need to wire it.
 *
 * @internal
 */
const NOT_ENABLED = new Error(
  'Accounting periods require the periods strategy. Import ' +
  '`{ withPeriods }` from "@noy-db/hub/periods" and pass it to ' +
  '`createNoydb({ periodsStrategy: withPeriods() })`.',
)

export const NO_PERIODS: PeriodsStrategy = {
  async loadPeriods() { return [] },
  async chainAnchor() { return { priorPeriodHash: '' } },
  assertTsWritable() {},
  validatePeriodName() { throw NOT_ENABLED },
  async appendPeriodLedgerEntry() { throw NOT_ENABLED },
}
