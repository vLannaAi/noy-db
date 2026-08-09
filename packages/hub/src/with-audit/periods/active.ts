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
import type { PeriodPartition, PartitionResolver } from './periods.js'
import type { PeriodsStrategy } from './strategy.js'

/** Options for {@link withPeriods}. */
export interface WithPeriodsOptions {
  /**
   * Maps a collection to the timeline each of its records belongs to (#1005) —
   * the answer to "which close calendar governs THIS record".
   *
   * ```ts
   * withPeriods({
   *   subjects: { receipts: (r) => [r.clientId, layerOf(r)] },
   * })
   * ```
   *
   * Same shape as `withForget({ subjects })`, which answers the same question
   * for erasure. A collection with no entry — and every collection when
   * `subjects` is omitted entirely — stays on the vault-wide timeline, so an
   * existing vault behaves exactly as it did before partitions existed.
   *
   * Return `undefined` from a mapper to put an individual record back on the
   * vault-wide timeline (e.g. a record that predates the field the mapping
   * reads).
   */
  readonly subjects?: Readonly<
    Record<string, (record: Record<string, unknown>) => PeriodPartition | undefined>
  >
}

/**
 * Build the default periods strategy. Pass into
 * `createNoydb({ periodsStrategy: withPeriods() })` to enable
 * `vault.closePeriod()` / `vault.openPeriod()` / write-guards.
 *
 * Pass `subjects` to run more than one close calendar in a single vault — see
 * {@link WithPeriodsOptions.subjects}.
 */
export function withPeriods(options?: WithPeriodsOptions): PeriodsStrategy {
  const subjects = options?.subjects
  const partitionOf: PartitionResolver | undefined = subjects
    ? (collection, record) => subjects[collection]?.(record)
    : undefined

  return {
    loadPeriods,
    chainAnchor,
    assertTsWritable,
    validatePeriodName,
    appendPeriodLedgerEntry,
    ...(partitionOf !== undefined && { partitionOf }),
  }
}
