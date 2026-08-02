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

// ─── Capability opt-in seam (#267 keyring-grant → team split) ──
// `db.grant` / `db.revoke` / `db.rotate` throw TeamNotEnabledError unless
// `teamStrategy: withTeam()` is passed to createNoydb; withTeam() links the
// keyring engines into this subpath's bundle, keeping the floor single-user.
export { withTeam } from './active.js'
export { NO_TEAM, type TeamStrategy } from './strategy.js'
export { TeamNotEnabledError } from '../../kernel/errors.js'

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
export type { BundleRecipient, ListUsersOptions } from './keyring.js'
// #846b — the credential functions' trailing options objects, nameable.
export type {
  LoadKeyringOptions,
  CreateOwnerKeyringOptions,
  RotateKeysOptions,
  ChangeSecretOptions,
} from './keyring.js'

// ─── Tier-2 authenticator slots ─────────────────────────
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

// ─── Tier-1 change flows ─────────────────────────────────
export {
  rotateSecret,
  recoverSecret,
} from './rotate-recover.js'
export type {
  RotateSecretInput,
  RecoverSecretInput,
  RecoverSecretResult,
  RecoveryProof,
  SlotRewrapContext,
  SlotRewrapCeremony,
} from './rotate-recover.js'

// ─── Atomic peer-recovery ────────────────────────────────
export { recoverUser } from './peer-recover.js'
export type { RecoverUserOptions } from './peer-recover.js'

// ─── Paper recovery primitives ───────────────────────────
export {
  mintPaperRecoveryEntry,
  unwrapDeksFromPaperEntry,
  loadPaperRecoveryEntries,
  savePaperRecoveryEntries,
  burnPaperRecoveryEntry,
} from './recovery.js'
export type { PaperRecoveryEntry } from './recovery.js'

// ─── Shared wrap-DEKs primitive ──────────────────────────
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

// ─── Sync moved out (#895) ──────────────────────────────
//
// `SyncEngine`, `SyncTransaction`, `PresenceHandle` and the
// `_sync_credentials` helpers used to be re-exported here for advanced
// consumers that construct them directly. Sync is not a `party` concern —
// it replicates state between stores and contexts rather than describing
// principals — so it now lives in `with-sync/` and ships from its own
// long-standing subpath:
//
//   import { SyncEngine } from '@noy-db/hub/sync'
//
// Re-exporting them from here as well would leave two homes for one thing,
// which is what #895 set out to remove.

// ─── Echo-secret ceremony (#940) ─────────────────────────
export {
  buildEchoBlock,
  verifyPrompt,
  resolveEchoReveal,
  verifyTypedEcho,
} from './echo-secret.js'
export type { EchoRevealChoice } from './echo-secret.js'
export { beginEchoUnlock } from './echo-ceremony.js'
export type { BeginEchoUnlockOptions, EchoCeremony } from './echo-ceremony.js'
export { MemoryDeviceSealProvider } from './device-seal.js'
export type { DeviceSealProvider } from './device-seal.js'
// Types the echo signatures name — exported from the same entry so the
// type-reachability check (`check:types`) holds for `./team` consumers.
export type { EchoSecretParts } from '../../kernel/enclave/index.js'
export type { KeyringEchoBlock, NoydbStore } from '../../kernel/types.js'

// #843 C3b — auth-config introspection. These are the `db.team.describeAuthConfig()` /
// `diagramAuthConfig()` / `describeUserAuth()` / `describeAllUsersAuth()` facade surface
// (#846a), so `./team` is their home; they had none but the root barrel.
export {
  describeAuthConfig,
  diagramAuthConfig,
  describeUserAuth,
  describeAllUsersAuth,
} from '../auth-introspection/index.js'
