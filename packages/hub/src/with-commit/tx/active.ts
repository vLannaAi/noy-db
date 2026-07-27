/**
 * Active transactions strategy. Only reachable via `@noy-db/hub/transactions`.
 */

import { runTransaction } from './transaction.js'
import { runDryRun } from './dry-run.js'
import type { TransactionsStrategy } from './strategy.js'
import type { TransactionInvariant } from './invariants.js'

/**
 * Options for {@link withTransactions}. Currently only commit-time
 * changeset `invariants` (see {@link TransactionInvariant}).
 */
export interface WithTransactionsOptions {
  /**
   * Commit-time set-level invariants run over the changeset on every
   * commit (ordinary AND amendment). See {@link TransactionInvariant}.
   */
  invariants?: ReadonlyArray<TransactionInvariant>
}

/**
 * Build the default transactions strategy. Pass into
 * `createNoydb({ transactionsStrategy: withTransactions() })` to enable
 * `db.transaction(fn)` (and `db.transaction({ dryRun: true }, fn)`).
 *
 * Supply `{ invariants }` to register commit-time changeset invariants —
 * set-level constraints that fire after the writes commit and revert the
 * transaction on a throw. Unlike `amendment.invariant`, these run for
 * ordinary `db.transaction(fn)` calls (and amendments) with no role gate.
 */
export function withTransactions(opts?: WithTransactionsOptions): TransactionsStrategy {
  const invariants = opts?.invariants ?? []
  return {
    runTransaction: (db, fn, options) => runTransaction(db, fn, options, invariants),
    runDryRun,
  }
}
