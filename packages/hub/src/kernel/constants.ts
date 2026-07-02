/**
 * Hub-core constants that must be referenceable without pulling any
 * service chunk. Kept import-free.
 */

/** Reserved fleet-wide control-plane vault name. Hub reserves it for an outward orchestration framework's state/control-plane vault. */
export const STATE_VAULT_NAME = '__noydb_state__'
