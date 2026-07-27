/**
 * Multi-record transactions subpath barrel.
 *
 * Public entry point is `db.transaction(fn)`; these types are exported
 * so consumers can annotate transaction-body signatures in their own
 * code.
 */
export { withTransactions } from './active.js'
export type { WithTransactionsOptions } from './active.js'
export type { TransactionsStrategy } from './strategy.js'
export type { TransactionInvariant } from './invariants.js'

export { TxContext, TxVault, TxCollection, runTransaction } from './transaction.js'
export type { AmendmentTxOptions } from './transaction.js'
