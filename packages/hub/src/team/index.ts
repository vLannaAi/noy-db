/**
 * `@noy-db/hub/team` — subpath export for multi-user / sync / keyring.
 *
 * Solo-user apps that never call `grant()`, `db.push()`, or open a
 * sync target can exclude this subpath entirely — bundle savings
 * estimated at ~4-6 KB.
 *
 * The main `@noy-db/hub` entry still re-exports every symbol for
 * backward compatibility — direct subpath import is purely a
 * tree-shaking opt-in.
 *
 * Named re-exports (not `export *`) so tsup keeps the barrel
 * populated even with `sideEffects: false`.
 */

// ─── Keyring / multi-user ───────────────────────────────────
export type { UnlockedKeyring } from './keyring.js'
export {
  loadKeyring,
  createOwnerKeyring,
  grant,
  revoke,
  changeSecret,
  listUsers,
  listUsersWithEnvelopes,
  ensureCollectionDEK,
  persistKeyring,
  updateKeyringIdentity,
  buildRecipientKeyringFile,
} from './keyring.js'
export type { BundleRecipient } from './keyring.js'

// ─── Tier-2 authenticator slots (#11) ───────────────────
export {
  enrollAuthenticator,
  removeAuthenticator,
  updateAuthenticator,
  findAuthenticator,
} from './authenticators.js'
export type {
  EnrollAuthenticatorOptions,
  EnrollAuthenticatorWrappingKEKOptions,
  EnrollAuthenticatorWrappingDEKsOptions,
  UpdateAuthenticatorOptions,
} from './authenticators.js'

// ─── Tier-1 change flows (#10, #29, #36) ────────────────
export {
  rotatePassphrase,
  recoverPassphrase,
} from './rotate-recover.js'
export type {
  RotatePassphraseInput,
  RecoverPassphraseInput,
  RecoverPassphraseResult,
  RecoveryProof,
  SlotRewrapContext,
  SlotRewrapCeremony,
} from './rotate-recover.js'

// ─── Atomic peer-recovery (#33, #34) ────────────────────
export { recoverUser } from './peer-recover.js'
export type { RecoverUserOptions } from './peer-recover.js'

// ─── Paper recovery primitives (#28, #39) ───────────────
export {
  mintPaperRecoveryEntry,
  unwrapDeksFromPaperEntry,
  loadPaperRecoveryEntries,
  savePaperRecoveryEntries,
  burnPaperRecoveryEntry,
} from './recovery.js'
export type { PaperRecoveryEntry } from './recovery.js'

// ─── Shared wrap-DEKs primitive (#26 Path C, #44) ───────
export {
  mintWrappedDeksBlob,
  unwrapDeksFromBlob,
} from './wrapped-deks.js'
export type { WrappedDeksBlob } from './wrapped-deks.js'

// ─── Magic-link grant primitives (consumed by @noy-db/on-magic-link) ─
export {
  writeMagicLinkGrant,
  readMagicLinkGrantRecord,
  listMagicLinkGrants,
  unwrapMagicLinkGrant,
  revokeMagicLinkGrant,
  deriveMagicLinkContentKey,
  magicLinkGrantRecordId,
  isMagicLinkGrantExpired,
} from './magic-link-grant.js'

// ─── Export-capability helpers ───────────────────────────
export {
  hasExportCapability,
  evaluateExportCapability,
} from './keyring.js'

// ─── Import-capability helpers ─────────────────────────
export {
  hasImportCapability,
  evaluateImportCapability,
} from './keyring.js'

// ─── Sync engine ────────────────────────────────────────────
export { SyncEngine } from './sync.js'

// ─── Sync transactions ──────────────────────────────────
export { SyncTransaction } from './sync-transaction.js'

// ─── Presence / live cursors ────────────────────────────
export { PresenceHandle } from './presence.js'

// ─── _sync_credentials reserved collection ──────────────
export {
  putCredential,
  getCredential,
  deleteCredential,
  listCredentials,
  credentialStatus,
  SYNC_CREDENTIALS_COLLECTION,
} from './sync-credentials.js'
export type { SyncCredential } from './sync-credentials.js'
