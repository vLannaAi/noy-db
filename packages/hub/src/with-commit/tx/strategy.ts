/**
 * Strategy seam for the optional multi-record transaction service.
 * `runTransaction` is only reachable through `withTransactions()`
 * exported from `@noy-db/hub/transactions`. Consumers who don't use
 * `db.transaction(fn)` ship none of the ~288 LOC.
 *
 * @internal
 */

import type { Noydb } from '../../kernel/noydb.js'
import type { TxContext, AmendmentTxOptions } from './transaction.js'
import type { DryRunResult } from './dry-run.js'
import type { TransactionInvariant } from './invariants.js'

/**
 * @internal
 */
export interface TransactionsStrategy {
  runTransaction<T>(
    db: Noydb,
    fn: (tx: TxContext) => Promise<T> | T,
    options?: AmendmentTxOptions,
    txInvariants?: ReadonlyArray<TransactionInvariant>,
  ): Promise<T>
  runDryRun(db: Noydb, fn: (tx: TxContext) => unknown): Promise<DryRunResult>
}

const NOT_ENABLED = new Error(
  'Multi-record transactions require the tx strategy. Import ' +
  '`{ withTransactions }` from "@noy-db/hub/transactions" and pass it to ' +
  '`createNoydb({ transactionsStrategy: withTransactions() })`.',
)

/**
 * @internal
 */
export const NO_TRANSACTIONS: TransactionsStrategy = {
  async runTransaction(
    _db: Noydb,
    _fn: unknown,
    _options?: AmendmentTxOptions,
    _txInvariants?: ReadonlyArray<TransactionInvariant>,
  ): Promise<never> { throw NOT_ENABLED },
  async runDryRun() { throw NOT_ENABLED },
}
