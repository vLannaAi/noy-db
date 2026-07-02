/**
 * Hub-core constants that must be referenceable without pulling any
 * service chunk. Kept import-free.
 */

/** Reserved fleet-wide control-plane vault name. Hub reserves it for an outward orchestration framework's state/control-plane vault. */
export const STATE_VAULT_NAME = '__noydb_state__'

/**
 * Soft cap on the JSON-serialized user-envelope payload size. Generous (a
 * typical profile + preferences + small app annex is ~1 KiB); rejects
 * accidental "stuff app state in here" anti-patterns.
 */
export const USER_ENVELOPE_MAX_BYTES = 64 * 1024

/**
 * Reserved store collection name for user envelopes. Starts with `_` so the
 * keyring grant machinery propagates the DEK to every granted user via the
 * existing system-collection DEK propagation path in `team/keyring.ts`.
 */
export const USER_ENVELOPE_COLLECTION = '_users'
