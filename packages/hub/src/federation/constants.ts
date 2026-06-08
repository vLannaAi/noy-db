/**
 * @category capability
 * Zero-dependency federation constants. Kept import-free so the core
 * graph can reference reserved names without pulling the (dynamically
 * imported) federation chunk. See the StateManagement Vault design spec.
 */

/** Reserved fleet-wide control-plane vault name. */
export const STATE_VAULT_NAME = '__noydb_state__'
