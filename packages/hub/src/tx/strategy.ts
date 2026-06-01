/**
 * Strategy seam for the optional multi-record transaction subsystem.
 * `runTransaction` is only reachable through `withTransactions()`
 * exported from `@noy-db/hub/tx`. Consumers who don't use
 * `db.transaction(fn)` ship none of the ~288 LOC.
 *
 * @internal
 */

import type { Noydb } from '../noydb.js'
import type { TxContext, AmendmentTxOptions } from './transaction.js'
import type { DryRunResult } from './dry-run.js'

/**
 * @internal
 */
export interface TxStrategy {
  runTransaction<T>(
    db: Noydb,
    fn: (tx: TxContext) => Promise<T> | T,
    options?: AmendmentTxOptions,
  ): Promise<T>
  runDryRun(db: Noydb, fn: (tx: TxContext) => Promise<unknown> | unknown): Promise<DryRunResult>
}

const NOT_ENABLED = new Error(
  'Multi-record transactions require the tx strategy. Import ' +
  '`{ withTransactions }` from "@noy-db/hub/tx" and pass it to ' +
  '`createNoydb({ txStrategy: withTransactions() })`.',
)

/**
 * @internal
 */
export const NO_TX: TxStrategy = {
  async runTransaction() { throw NOT_ENABLED },
  async runDryRun() { throw NOT_ENABLED },
}
