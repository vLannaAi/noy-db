/**
 * Type surface for the user-list visibility service.
 *
 * Two complementary flags:
 *  - {@link DirectoryConfig} — vault-level "is the directory listing
 *    enabled at all?" toggle. Owner-only mutation.
 *  - {@link UserVisibility} — per-user "hide me from teammate listings"
 *    opt-out. Self-mutation via `vault.user.setMyVisibility`.
 *
 * Both flags live in the existing `_meta` collection as plaintext-bypass
 * sidecars (`_iv: ''`). Neither is a security boundary — the keyring
 * file is still observable at `_keyring/*` and the envelope ciphertext
 * is still at `_users/*` to anyone with direct store read access. The
 * flags exist to keep admin-UI listings tidy, not to hide principals
 * from a determined attacker.
 *
 * @see docs/subsystems/user-envelope.md → Directory visibility
 *
 * @module
 */

/**
 * Vault-level directory toggle. Persisted at `_meta/directory`.
 *
 * - `enabled: true` (default when no document exists) — every authenticated
 *   caller can enumerate users via `listUsersWithEnvelopes`.
 * - `enabled: false` — only `owner` and `admin` callers can enumerate;
 *   anyone else gets {@link import('../../kernel/errors.js').DirectoryDisabledError}.
 */
export interface DirectoryConfig {
  readonly enabled: boolean
}

/**
 * Per-user visibility flag. Persisted at `_meta/visibility/<keyringId>`.
 *
 * - `hidden: false` (default when no document exists) — the user shows up
 *   in `listUsersWithEnvelopes` like any other principal.
 * - `hidden: true` — the user is filtered out of the default listing.
 *   `owner`/`admin` callers can still see them by passing
 *   `{ includeHidden: true }`.
 */
export interface UserVisibility {
  readonly hidden: boolean
}
