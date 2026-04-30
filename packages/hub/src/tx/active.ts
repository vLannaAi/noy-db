/**
 * Active transactions strategy. Only reachable via `@noy-db/hub/tx`.
 */

import { runTransaction } from './transaction.js'
import type { TxStrategy } from './strategy.js'

/**
 * Build the default transactions strategy. Pass into
 * `createNoydb({ txStrategy: withTransactions() })` to enable
 * `db.transaction(fn)`.
 */
export function withTransactions(): TxStrategy {
  return { runTransaction }
}
