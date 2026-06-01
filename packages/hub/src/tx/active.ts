/**
 * Active transactions strategy. Only reachable via `@noy-db/hub/tx`.
 */

import { runTransaction } from './transaction.js'
import { runDryRun } from './dry-run.js'
import type { TxStrategy } from './strategy.js'

/**
 * Build the default transactions strategy. Pass into
 * `createNoydb({ txStrategy: withTransactions() })` to enable
 * `db.transaction(fn)` (and `db.transaction({ dryRun: true }, fn)`).
 */
export function withTransactions(): TxStrategy {
  return { runTransaction, runDryRun }
}
