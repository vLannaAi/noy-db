/**
 * Hub-core constants that must be referenceable without pulling any
 * subsystem chunk. Kept import-free.
 */

/** Reserved fleet-wide control-plane vault name. Hub reserves it; @klum-db/lobby's StateManagementVault uses it. */
export const STATE_VAULT_NAME = '__noydb_state__'
