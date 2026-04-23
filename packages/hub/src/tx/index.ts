/**
 * Multi-record transactions subpath barrel.
 *
 * Public entry point is `db.transaction(fn)`; these types are exported
 * so consumers can annotate transaction-body signatures in their own
 * code.
 */
export { TxContext, TxVault, TxCollection, runTransaction } from './transaction.js'
