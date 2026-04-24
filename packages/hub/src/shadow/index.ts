/**
 * @noy-db/hub/shadow — opt-in vault-frame snapshot primitive.
 *
 * @category capability
 *
 * `VaultFrame` captures a point-in-time snapshot of a vault's
 * decrypted records — useful for undo/redo UX, A/B comparisons, and
 * tests that need a frozen view without a full `vault.dump()`.
 * Consumers that don't use frames can omit this subpath and the
 * ~129 LOC never reaches the bundle.
 */

export { VaultFrame, CollectionFrame } from './vault-frame.js'
