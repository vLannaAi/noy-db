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

/**
 * #1096 — reserved DEK-map key holding the vault-wide ROSTER KEY.
 *
 * Not a collection: no records are ever stored under this name. It rides the
 * `deks` map purely so the roster key reaches every member through the
 * channels a DEK already travels — grant's `_`-prefix propagation,
 * `persistKeyring`, the wrapped-DEKs recovery blob, `peer-recover`, pod
 * recipient slots, session tokens — with no new plumbing and no satellite
 * changes.
 *
 * The key authenticates each keyring file's plaintext AUTHORITY half via
 * `roster_tag` (see `team/roster-tag.ts`). It is deliberately NOT
 * secret-bearing: every role must be able to verify the roster it is
 * subject to, so it propagates like `_ledger`, not like `_sync_credentials`.
 *
 * `rotateKeys` refuses to rotate it — see the guard there for why.
 */
export const ROSTER_KEY_ID = '_roster'

/**
 * Vault-lifetime blob CONTENT-ADDRESSING root (#1126). A keyring DEK slot like
 * `_roster`, and like it **never rotated** — `rotateKeys` refuses it by name.
 *
 * That refusal is the whole point: the blob eTag is an HMAC keyed by this root
 * (domain-separated per tier), so keying it by the rotating `_blob` DEK made
 * every pre-rotation address permanently wrong. Rotation now re-keys chunk
 * bodies while addresses stay put.
 *
 * The residual it accepts, stated so nobody has to rediscover it: a revoked
 * member who kept this key retains a CONFIRMATION ORACLE — given plaintext they
 * already hold, they can recompute an address and test whether the vault still
 * stores those bytes. They cannot read anything: chunk bodies are under DEKs
 * that DO rotate. That is the trade a rotation-invariant address makes, and it
 * is the one the alternative (re-addressing during rotation) avoids at the cost
 * of rewriting every chunk and index row on every revocation.
 */
export const BLOB_ADDRESS_KEY_ID = '_blob_addr'
