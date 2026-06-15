/**
 * **@noy-db/hub** — zero-knowledge, offline-first, encrypted document store.
 *
 * ## What it is
 *
 * A TypeScript library that encrypts every record with AES-256-GCM before it
 * reaches any storage backend. The store (file, DynamoDB, S3, IndexedDB, …)
 * only ever sees ciphertext — it has no way to read or tamper with your data
 * without the user's passphrase.
 *
 * ## Architecture in one diagram
 *
 * ```
 * Passphrase
 *   └─► PBKDF2-SHA256 (600K iterations) → KEK  [memory only]
 *         └─► AES-KW unwrap → DEK per collection  [memory only]
 *               └─► AES-256-GCM encrypt/decrypt
 *                     └─► NoydbStore  [sees only ciphertext envelopes]
 * ```
 *
 * ## Getting started
 *
 * ```ts
 * import { createNoydb } from '@noy-db/hub'
 * import { jsonFile } from '@noy-db/to-file'
 *
 * const db = await createNoydb({ store: jsonFile({ dir: './data' }) })
 * const acme = await db.openVault('acme', { passphrase: 'hunter2' })
 * const invoices = acme.collection<Invoice>('invoices')
 *
 * await invoices.put('inv-001', { amount: 1200, client: 'Acme Corp' })
 * const all = await invoices.query().toArray()
 * ```
 *
 * ## Key concepts
 *
 * | Concept | Type | Description |
 * |---------|------|-------------|
 * | Instance | {@link Noydb} | Top-level handle from {@link createNoydb} |
 * | Vault | {@link Vault} | Tenant namespace; has its own keyrings |
 * | Collection | {@link Collection} | Typed record set; has its own DEK |
 * | Store | {@link NoydbStore} | 6-method backend interface |
 * | Envelope | {@link EncryptedEnvelope} | What the store actually persists |
 *
 * ## Security invariants
 *
 * - **Zero crypto dependencies.** All cryptography uses `crypto.subtle` (Web
 *   Crypto API). No npm crypto packages.
 * - **KEK never persisted.** The key-encryption key lives only in memory for
 *   the duration of an open session.
 * - **Fresh IV per write.** Every `put()` generates a new random 12-byte IV.
 * - **Stores see only ciphertext.** Encryption happens in core before any
 *   store method is called.
 *
 * ## Related packages
 *
 * | Package | Purpose |
 * |---------|---------|
 * | `@noy-db/to-file` | JSON file store (USB / local disk) |
 * | `@noy-db/to-aws-dynamo` | DynamoDB single-table store |
 * | `@noy-db/to-aws-s3` | S3 object store |
 * | `@noy-db/to-browser-idb` | IndexedDB store (atomic CAS) |
 * | `@noy-db/to-browser-local` | localStorage store |
 * | `@noy-db/to-memory` | In-memory store (testing) |
 * | `@noy-db/in-vue` | Vue 3 composables |
 * | `@noy-db/in-pinia` | Pinia store integration |
 * | `@noy-db/in-nuxt` | Nuxt 4 module |
 * | `@noy-db/on-webauthn` | Hardware-key / passkey unlock |
 * | `@noy-db/on-oidc` | OIDC / federated login unlock |
 *
 * @packageDocumentation
 */

// Environment check — throws if Node <18 or crypto.subtle missing
import './env-check.js'

// Types
export type {
  Role,
  Permission,
  Permissions,
  EncryptedEnvelope,
  KeyringAuthenticator,
  KeyringAuthenticatorWrappingKEK,
  KeyringAuthenticatorWrappingDEKs,
  VaultPolicyOnDisk,
  VaultSnapshot,
  NoydbStore,
  ListPageResult,
  KeyringFile,
  VaultBackup,
  DirtyEntry,
  SyncMetadata,
  Conflict,
  ConflictStrategy,
  ConflictPolicy,
  CollectionConflictResolver,
  PushOptions,
  PullOptions,
  PushResult,
  PullResult,
  SyncTransactionResult,
  SyncStatus,
  ChangeEvent,
  NoydbEventMap,
  GrantOptions,
  RevokeOptions,
  UpdateUserOptions,
  UserInfo,
  NoydbOptions,
  HistoryConfig,
  HistoryOptions,
  HistoryEntry,
  PruneOptions,
  PutManyItemOptions,
  PutManyOptions,
  PutManyResult,
  DeleteManyResult,
  ExportStreamOptions,
  ExportChunk,
  AccessibleVault,
  ListAccessibleVaultsOptions,
  QueryAcrossOptions,
  QueryAcrossResult,
  SessionPolicy,
  ReAuthOperation,
  PlaintextTranslatorContext,
  PlaintextTranslatorFn,
  TranslatorAuditEntry,
  ExportCapability,
  ExportFormat,
  ImportCapability,
} from './types.js'

export {
  NOYDB_FORMAT_VERSION,
  NOYDB_KEYRING_VERSION,
  NOYDB_BACKUP_VERSION,
  NOYDB_SYNC_VERSION,
  createStore,
} from './types.js'

export type {
  StoreAuthKind,
  StoreAuth,
  StoreCapabilities,
} from './types.js'

// Blob store
export type {
  NoydbBundleStore,
  BlobObject,
  SlotRecord,
  SlotInfo,
  VersionRecord,
  BlobPutOptions,
  BlobResponseOptions,
} from './types.js'
export { BlobSet } from './blobs/blob-set.js'
export {
  BLOB_COLLECTION,
  BLOB_INDEX_COLLECTION,
  BLOB_CHUNKS_COLLECTION,
  BLOB_SLOTS_PREFIX,
  BLOB_VERSIONS_PREFIX,
  DEFAULT_CHUNK_SIZE,
} from './blobs/blob-set.js'
export { detectMimeType, detectMagic, isPreCompressed } from './blobs/mime-magic.js'
export { wrapBundleStore, createBundleStore } from './store/bundle-store.js'
export type { WrappedBundleNoydbStore, WrapBundleStoreOptions } from './store/bundle-store.js'
export { readPlaintextRecord } from './debug.js'

// Observable write-queue
export type { WriteQueue } from './write-queue.js'

// Write lifecycle hooks
export type { WriteEvent, WriteHook } from './write-hooks.js'

// Runtime schema introspection
export type { SchemaIntrospection } from './introspection/types.js'

// Dry-run transactions
export type { DryRunResult, AffectedDocument, GuardViolation } from './tx/dry-run.js'

// Multi-tab coordination
export type { TabRole, TabPresence, TabCoordinationOptions, TabLockManager, TabChannel } from './tab-coordination.js'
// Cross-tab write conflict
export type { WriteConflict } from './types.js'

// Schema-update strategies
export type {
  SchemaDelta,
  FieldChange,
  UpdateContext,
  UpdateDecision,
  SchemaUpdateStrategy,
} from './schema-update/index.js'
export { blindUpdate, additiveOnly, lockSchema, coordinatedCutover } from './schema-update/index.js'
export type { FenceState, FenceDoc } from './schema-update/fence.js'

// Sync policy
export type { SyncPolicy, PushPolicy, PullPolicy, PushMode, PullMode, SyncSchedulerStatus } from './store/sync-policy.js'
export { SyncScheduler, INDEXED_STORE_POLICY, BUNDLE_STORE_POLICY } from './store/sync-policy.js'

// Sync target
export type { SyncTarget, SyncTargetRole } from './types.js'

// Store routing
export { routeStore } from './store/route-store.js'
export type {
  RouteStoreOptions, RoutedNoydbStore, BlobStoreRoute, AgeRoute,
  BlobLifecyclePolicy, OverrideTarget, OverrideOptions, SuspendOptions, RouteStatus,
} from './store/route-store.js'

// Store middleware
export { wrapStore, withRetry, withLogging, withMetrics, withCircuitBreaker, withCache, withHealthCheck } from './store/store-middleware.js'
export type {
  StoreMiddleware, RetryOptions, LoggingOptions, LogLevel,
  MetricsOptions, StoreOperation, CircuitBreakerOptions, StoreCacheOptions, HealthCheckOptions,
} from './store/store-middleware.js'

// Errors
export {
  NoydbError,
  DecryptionError,
  TamperedError,
  InvalidKeyError,
  KeyringCorruptError,
  NoAccessError,
  ReadOnlyError,
  PermissionDeniedError,
  PrivilegeEscalationError,
  StoreCapabilityError,
  ConflictError,
  NetworkError,
  NotFoundError,
  ValidationError,
  SchemaValidationError,
  GroupCardinalityError,
  BackupLedgerError,
  BackupCorruptedError,
  JoinTooLargeError,
  CrossJoinTooLargeError,
  CrossJoinSourceUnknownError,
  DanglingReferenceError,
  FilenameSanitizationError,
  PathEscapeError,
  ElevationExpiredError,
  AlreadyElevatedError,
  LedgerContentionError,
  SequenceContentionError,
  SequenceOfflineError,
  BundleIntegrityError,
  BundleSealMismatchError,
  BundleVersionConflictError,
  SessionExpiredError,
  SessionNotFoundError,
  SessionPolicyError,
  ExportCapabilityError,
  ImportCapabilityError,
  KeyringExpiredError,
  ReadOnlyAtInstantError,
  ReadOnlyFrameError,
  RecordLockedError,
  FieldFrozenError,
  IllegalTransitionError,
  InvariantError,
  AmendmentForbiddenError,
  AttestationError,
  SchemaUpdateError,
  NonAdditiveSchemaChangeError,
  SchemaLockedError,
  SchemaFenceError,
  MigrationRequiredError,
  QuiesceTimeoutError,
} from './errors.js'

// ─── Snapshot errors ─────────────────────────────────────────────────────────
export { SnapshotNotFoundError } from './errors.js'
export type { SnapshotMeta, RetentionPolicy } from './snapshots/strategy.js'

// ─── Record cold-storage archival (#307) ───────────────────────────────────────
export { withArchive } from './archive/index.js'
export type {
  ArchiveStrategy,
  WithArchiveOptions,
  ArchivePolicy,
  ArchiveResult,
  ArchiveRunOptions,
} from './archive/index.js'

// ─── Atomic sequence (#303) ─────────────────────────────────────────────────────
export { SequenceStore, resolveSequenceKey, compileSequenceFormat } from './sequence/index.js'
export type { SequenceHandle, FormattedSequenceHandle, NextOptions, SequenceOptions } from './sequence/index.js'

// Deferred numbering — store-clock-ordered serials for non-CAS stores.
export { withDeferredNumbering } from './numbering/descriptor.js'
export type { DeferredNumberingConfig } from './numbering/descriptor.js'
export type { Assignment as NumberingAssignment } from './numbering/index.js'
export { NumberingUncertaintyError } from './errors.js'
export type { StoreTime } from './types.js'

// Federation — VaultGroup / sharded collections.
// Type-only: these classes are never constructed by consumers — they are
// returned by `db.openVaultGroup()` / `.collection()` / `.query()`. Exporting
// them as types (not values) removes the only static runtime edge from the
// package entry to the federation chunk, so federation stays purely behind the
// dynamic `import()` in `openVaultGroup` — reliably excluded (ESM, CJS, and
// non-tree-shaking consumers alike) until a group is actually opened.
export type { VaultGroup, ShardedCollection, ShardedQuery, StateManagementVault } from './federation/index.js'
export type {
  VaultTemplate,
  VaultRegistryRow,
  ShardingConfig,
  VaultGroupOptions,
  FanoutQueryOptions,
  FanoutResult,
  SkippedVault,
} from './federation/index.js'
export type {
  CrossVaultAggregation, CrossVaultGroupedAggregation, ShardedGroupedQuery,
  CrossVaultLiveQuery, CrossVaultLiveAggregation, LiveQueryOptions,
  GroupedRow as CrossVaultGroupedRow,
} from './federation/index.js'
export type { SchemaManifestRow, DeploymentEvent, CapturedBlueprint } from './federation/index.js'
export type {
  CrossVaultDerivationSpec,
  CrossVaultDerivationContext,
  RefreshInsightsResult,
  MigrationStatusRow,
  FleetMigrationResult,
} from './federation/index.js'
export { STATE_VAULT_NAME } from './federation/constants.js'
export { UnknownShardError, ShardProvisioningError, VaultTemplateNotFoundError, ReservedVaultNameError, DataResidencyError } from './errors.js'
export { ForgetStrategyNotConfiguredError } from './errors.js'
export { SealedRecordExpiredError, SealedRecordMismatchError, RecordCekNotFoundError } from './errors.js'
export { DebugPlaintextError, DebugReservedFieldError } from './errors.js'

// Bundle format — `.noydb` container
export {
  writeNoydbBundle,
  readNoydbBundle,
  readNoydbBundleHeader,
  resetBrotliSupportCache,
} from './bundle/bundle.js'
export type {
  NoydbBundleHeader,
  CompressionAlgo,
} from './bundle/format.js'
export type {
  WriteNoydbBundleOptions,
  ReadNoydbBundleOptions,
  NoydbBundleReadResult,
  AutoCredentialKind,
  AutoCredential,
} from './bundle/bundle.js'
export {
  NOYDB_BUNDLE_MAGIC,
  NOYDB_BUNDLE_PREFIX_BYTES,
  NOYDB_BUNDLE_FORMAT_VERSION,
  hasNoydbBundleMagic,
} from './bundle/format.js'
export { generateULID, isULID } from './bundle/ulid.js'

// Schema validation — Standard Schema v1 integration
export type {
  StandardSchemaV1,
  StandardSchemaV1SyncResult,
  StandardSchemaV1Issue,
  InferOutput,
} from './schema.js'
export { validateSchemaInput, validateSchemaOutput } from './schema.js'

// Introspection — vault.dumpSchema() returns a structured snapshot.
// The CLI `noydb describe` command consumes this; programmatic callers
// can use it directly from app code (admin pages, audit tooling).
export type {
  VaultSchemaSnapshot,
  DumpSchemaOptions,
  CollectionDescriptor,
  CollectionStats,
  FieldDescriptor,
  FieldSource,
  MaterializedViewDescriptor,
  OverlayViewDescriptor,
  DerivationDescriptor,
  InternalCollectionStats,
} from './introspection/index.js'

// Persisted JSON Schema — opt-in per-collection encrypted snapshot
// of the developer's Zod (or other Standard Schema) validator. Powers
// `noydb describe` audit output from a bundle alone.
export type {
  PersistedSchemaEnvelope,
  PersistedSchemaKind,
  PersistSchemaResult,
} from './persisted-schemas/index.js'
export {
  SCHEMAS_COLLECTION,
  derivePersistedSchema,
  isZodSchema,
  loadPersistedSchema,
  savePersistedSchema,
  persistSchemaIfNeeded,
} from './persisted-schemas/index.js'

// Time-machine queries — vault.at(ts) method lives on
// Vault; these classes are the return types.
export { VaultInstant, CollectionInstant } from './history/time-machine.js'
export type { VaultEngine } from './history/time-machine.js'

// Shadow vaults — vault.frame() method lives on Vault;
// these classes are the return types.
export { VaultFrame, CollectionFrame } from './shadow/vault-frame.js'

// Consent boundaries — vault.withConsent() / .consentAudit()
// live on Vault; these are the types + constants.
export { CONSENT_AUDIT_COLLECTION } from './consent/consent.js'
export type {
  ConsentContext,
  ConsentOp,
  ConsentAuditEntry,
  ConsentAuditFilter,
} from './consent/consent.js'

// Hash-chained ledger
export {
  LedgerStore,
  LEDGER_COLLECTION,
  LEDGER_DELTAS_COLLECTION,
  envelopePayloadHash,
  canonicalJson,
  sha256Hex,
  hashEntry,
  paddedIndex,
  parseIndex,
  computePatch,
  applyPatch,
} from './history/ledger/index.js'
export type {
  LedgerEntry,
  AppendInput,
  VerifyResult,
  JsonPatch,
  JsonPatchOp,
} from './history/ledger/index.js'

// Foreign-key references via ref()
export {
  ref,
  refArray,
  isRefArray,
  RefRegistry,
  RefIntegrityError,
  RefScopeError,
} from './refs.js'
export type {
  RefMode,
  RefDescriptor,
  RefViolation,
} from './refs.js'

// Managed many-to-many link sets via vault.link() / vault.links() (#377-B)
export {
  isLinkCollectionName,
  LinkEndpointError,
  LinkIntegrityError,
} from './links/link-set.js'
export type {
  LinkSpec,
  LinkRow,
  LinkOnDelete,
  LinkSetHandle,
} from './links/link-set.js'

// Keyring types
export type { UnlockedKeyring } from './team/keyring.js'

// Tier-2 authenticator slots
export {
  enrollAuthenticator,
  removeAuthenticator,
  findAuthenticator,
} from './team/authenticators.js'
export type {
  EnrollAuthenticatorOptions,
  EnrollAuthenticatorWrappingKEKOptions,
  EnrollAuthenticatorWrappingDEKsOptions,
  UpdateAuthenticatorOptions,
} from './team/authenticators.js'

// Tier-3 quick-unlock state
export { QuickUnlockStore } from './session/unlock-state.js'
export type { QuickUnlockState } from './session/unlock-state.js'

// Tier-1 change flows
export {
  rotatePassphrase as keyringRotatePassphrase,
  recoverPassphrase as keyringRecoverPassphrase,
} from './team/rotate-recover.js'
export type {
  RotatePassphraseInput,
  RecoverPassphraseInput,
  RecoverPassphraseResult,
  RecoveryProof,
  SlotRewrapContext,
  SlotRewrapCeremony,
} from './team/rotate-recover.js'

// Public envelope (docs/subsystems/public-envelope.md)
export {
  loadPublicEnvelope,
  savePublicEnvelope,
  readPublicEnvelope,
  resolveSchema as resolvePublicEnvelopeSchema,
  validatePublicEnvelopeInput,
  isPublicEnvelope,
  PUBLIC_ENVELOPE_FIELDS,
  DEFAULT_PUBLIC_ENVELOPE_SCHEMA,
  PUBLIC_ENVELOPE_RECORD_ID,
} from './meta/public-envelope/index.js'
export type {
  PublicEnvelope,
  PublicEnvelopeText,
  PublicEnvelopeSchema,
  PublicEnvelopeField,
  ResolvedPublicEnvelopeSchema,
  SetPublicEnvelopeInput,
} from './meta/public-envelope/index.js'
export { readNoydbBundlePublicEnvelope } from './bundle/bundle.js'

// User envelope (docs/superpowers/specs/2026-05-05-user-envelope-design.md)
export {
  USER_ENVELOPE_COLLECTION,
  USER_ENVELOPE_MAX_BYTES,
  UserEnvelopeOversizedError,
  loadUserEnvelope,
  saveUserEnvelope,
  deleteUserEnvelope,
  listUserEnvelopeIds,
} from './meta/user-envelope/index.js'
export type { UserEnvelope } from './meta/user-envelope/index.js'
export type {
  DeepPartial,
  DeepPartialOrNull,
  Unsubscribe,
  LiveUserEnvelope,
  UserEnvelopePresented,
  UserEnvelopeCheckGate,
} from './meta/user-envelope/api.js'
export { UserApi } from './meta/user-envelope/api.js'

// Auth introspection
export {
  describeAuthConfig,
  diagramAuthConfig,
  describeUserAuth,
  describeAllUsersAuth,
} from './auth-introspection/index.js'

// Recovery storage — paper and Shamir profiles.
export {
  loadPaperRecoveryEntries,
  savePaperRecoveryEntries,
  burnPaperRecoveryEntry,
  hasRecoveryEnrolled,
  mintPaperRecoveryEntry,
  unwrapDeksFromPaperEntry,
  loadShamirRecoveryEntries,
  saveShamirRecoveryEntries,
  mintShamirRecoveryEntry,
  unwrapDeksFromShamirEntry,
} from './team/recovery.js'
export type {
  PaperRecoveryEntry,
  PaperRecoveryDoc,
  ShamirRecoveryEntry,
  ShamirRecoveryDoc,
} from './team/recovery.js'

// Recovery dispatch types — discriminated
// unions for the polymorphic enroll/rotate paths. (RecoveryProof /
// RecoverPassphraseInput / RecoverPassphraseResult are already
// exported above.)
export type {
  EnrollRecoveryResult,
  RotateRecoveryOptions,
  RotateRecoveryResult,
} from './team/rotate-recover.js'

// Canonical wrap-DEKs primitive — shared crypto for tier-0
// (paper recovery), tier-2 wrap-DEKs (password), tier-3 (on-pin).
// `mintPaperRecoveryEntry` and `enrollPasswordAuthenticator` both
// delegate to these helpers.
export { mintWrappedDeksBlob, unwrapDeksFromBlob } from './team/wrapped-deks.js'
export type { WrappedDeksBlob } from './team/wrapped-deks.js'

// Managed-passphrase mode — rubber-hose-resistant vaults where
// hub generates the passphrase and seals it under a developer-provided
// SealingKeyProvider. The interface lives here; concrete providers
// (macOS Keychain, Windows Credential Manager, libsecret, AWS KMS)
// ship as separate packages.
export type { SealingKeyProvider, SealedPassphrase, SealedEnvelope, RecipientHint, RecipientSealer } from './team/managed-passphrase.js'
export type { ShamirRecoveryProvider } from './team/shamir-recovery-provider.js'
export {
  MemorySealingKeyProvider,
  MemoryRecipientSealer,
  sealRsaOaepTlv,
  parseRsaOaepTlv,
  aesGcmOpen,
  loadSealedPassphrase,
  saveSealedPassphrase,
  parseSealedEnvelope,
  SEALED_PASSPHRASE_RECORD_ID,
} from './team/managed-passphrase.js'

// Peer-recovery — atomic db.recoverUser primitive.
// The team/peer-recover module also runs through Noydb.recoverUser for
// the policy-gated path; consumers can use the lower-level function
// directly when they don't want hub-level gating (e.g. in tests).
export { recoverUser } from './team/peer-recover.js'
export type { RecoverUserOptions } from './team/peer-recover.js'

// Export-capability helpers
export { hasExportCapability, evaluateExportCapability } from './team/keyring.js'
export { hasImportCapability, evaluateImportCapability } from './team/keyring.js'

// Bundle recipients
export type { BundleRecipient } from './team/keyring.js'
export { buildRecipientKeyringFile } from './team/keyring.js'

// Team enumeration — joined view of keyrings and their user envelopes.
// Useful for admin UIs that want to render team-member lists
// with profile data in a single pass.
export { listUsers, listUsersWithEnvelopes } from './team/keyring.js'
export type { ListUsersOptions } from './team/keyring.js'

// Directory visibility — vault-level user-list toggle +
// per-user opt-out.
export {
  readDirectoryConfig,
  persistDirectoryConfig,
  readUserVisibility,
  persistUserVisibility,
  deleteUserVisibility,
  visibilityRecordId,
  DIRECTORY_RECORD_ID,
  VISIBILITY_RECORD_PREFIX,
} from './directory/index.js'
export type { DirectoryConfig, UserVisibility } from './directory/index.js'
export { DirectoryDisabledError } from './errors.js'

// Core classes
export { Noydb, createNoydb } from './noydb.js'
export { Vault, ElevatedHandle, ELEVATION_AUDIT_COLLECTION } from './vault.js'
export { Collection } from './collection.js'
export type { CacheOptions, CacheStats, CollectionChangeEvent } from './collection.js'

// CRDT mode
export type { CrdtMode, CrdtState, LwwMapState, RgaState, YjsState } from './crdt/crdt.js'
export { resolveCrdtSnapshot, mergeCrdtStates } from './crdt/crdt.js'

// Presence
export { PresenceHandle } from './team/presence.js'
export type { PresencePeer } from './types.js'
export { derivePresenceKey } from './crypto.js'
export { SyncEngine } from './team/sync.js'
export { SyncTransaction } from './team/sync-transaction.js'

// Multi-record transactions
export { TxContext, TxVault, TxCollection, runTransaction } from './tx/transaction.js'
export type { TxOp } from './types.js'
export type { TransactionInvariant } from './tx/invariants.js'
export type { TransactionStrategyOptions } from './tx/active.js'

// Guards (record lock + field freeze + amendment invariant) — see docs/superpowers/specs/2026-05-18-guards-design.md
export { withGuard } from './guards/index.js'
export { immutableGuard } from './guards/index.js'
export type { ImmutableGuardConfig } from './guards/index.js'
export { transitionGuard } from './guards/index.js'
export type { TransitionGuardConfig } from './guards/index.js'
export type {
  GuardStrategy,
  GuardStrategyHandle,
  GuardContext,
  GuardChange,
} from './guards/index.js'

// Derivations (Dim 14) — see docs/superpowers/specs/2026-05-01-dim14-derivation-v1-design.md
export { withDerivation } from './derivations/index.js'
export { withRollup } from './derivations/index.js'
export type {
  DerivationStrategy,
  DerivationStrategyHandle,
  DerivedFromMeta,
  OutputSpec,
  RecordOutputSpec,
  ArrayOutputSpec,
} from './derivations/index.js'
export {
  DerivationCycleError,
  DerivationDepthError,
  DerivationOutputUnknownError,
  DerivationOutputShapeError,
  DerivationCapExceededError,
} from './errors.js'

// Materialized views (Dim 14 v2) — see docs/superpowers/specs/2026-05-20-dim14-mv-v2-design.md
export { withMaterializedView } from './materialized-views/index.js'
export type {
  MaterializedViewStrategy,
  MaterializedViewStrategyHandle,
  MaterializedViewOutput,
  MaterializedFromMeta,
  UnionSource,
  UnionArmJoin,
} from './materialized-views/index.js'
export {
  MaterializedViewCycleError,
  MaterializedViewConfigError,
  MaterializedViewSourceUnknownError,
  MaterializedViewTooLargeError,
} from './errors.js'

// Overlay views (Dim 14 v2) — see docs/superpowers/specs/2026-05-20-dim14-mv-v2-design.md § Composition with operator-editable lifecycle
export { withOverlayedView } from './overlay-views/index.js'
export type {
  OverlayedViewStrategy,
  OverlayedViewStrategyHandle,
  OverlayFieldMergeRule,
  OverlayFieldMergeMode,
} from './overlay-views/index.js'
export {
  OverlayBaseIsVirtualError,
  OverlayCollectionUnavailableError,
  OverlayNameCollisionError,
  OverlayIdMismatchError,
} from './errors.js'

// Accounting periods
export { PERIODS_COLLECTION } from './periods/index.js'
export type {
  PeriodRecord,
  ClosePeriodOptions,
  OpenPeriodOptions,
} from './periods/index.js'
export { PeriodClosedError } from './errors.js'

// Cache module — LRU + byte budget parsing
export { Lru, parseBytes, estimateRecordBytes } from './cache/index.js'
export type { LruOptions, LruStats } from './cache/index.js'

// Biometric — removed in as redundant with @noy-db/on-webauthn
// (which supports PRF + rawId fallback + BE-flag guard). Legacy consumers
// migrate to `import { enrollWebAuthn, unlockWebAuthn } from '@noy-db/on-webauthn'`.

// i18n — dictKey + DictionaryHandle
export {
  dictKey,
  isDictKeyDescriptor,
  staticDict,
  isStaticDictDescriptor,
  isDictCollectionName,
  dictCollectionName,
  DictionaryHandle,
  DICT_COLLECTION_PREFIX,
} from './i18n/dictionary.js'
export type {
  DictKeyDescriptor,
  StaticDictDescriptor,
  DictEntry,
  DictionaryOptions,
} from './i18n/dictionary.js'

// i18n — i18nText
export {
  i18nText,
  isI18nTextDescriptor,
  validateI18nTextValue,
  resolveI18nText,
  applyI18nLocale,
} from './i18n/core.js'
export type { I18nTextOptions, I18nTextDescriptor, ResolveI18nOptions, I18nMap } from './i18n/core.js'

// money — currency-safe decimal field descriptor
export {
  money,
  isMoneyDescriptor,
  MoneyPrecisionError,
  MoneyCurrencyError,
  MoneyUnsupportedError,
  scaleForCurrency,
  mulRate,
  allocate,
  asMoney,
  isMoneyString,
  moneyNumber,
} from './money/index.js'
export type {
  MoneyDescriptor,
  MoneyOptions,
  MoneyOptionsFixed,
  MoneyOptionsMulti,
  RoundingMode,
  FxRates,
  MulRateOptions,
  AllocateOptions,
  MoneyString,
} from './money/index.js'

// computed — schema-owned computed scalar fields (#302)
export { evalComputedFields, ComputedFieldError } from './computed/index.js'
export type { ComputedFields, ComputedFn } from './computed/index.js'

// i18n — resolution policy + script enforcement
export { resolvePolicy } from './i18n/policy.js'
export type { OnMissing, Layer, OnMissingPolicy } from './i18n/policy.js'
export { inferScripts, enforceScript } from './i18n/script.js'
export type { ScriptWarning } from './i18n/script.js'

// i18n errors
export {
  ReservedCollectionNameError,
  DictKeyMissingError,
  DictKeyInUseError,
  MissingTranslationError,
  LocaleNotSpecifiedError,
  TranslatorNotConfiguredError,
  ScriptViolationError,
  StaticDictReadonlyError,
  UnknownDictCodeError,
} from './errors.js'

// Locale read options + translator audit log
export type { LocaleReadOptions } from './types.js'

// _sync_credentials reserved collection —
export {
  putCredential,
  getCredential,
  deleteCredential,
  listCredentials,
  credentialStatus,
  SYNC_CREDENTIALS_COLLECTION,
} from './team/sync-credentials.js'
export type { SyncCredential } from './team/sync-credentials.js'

// Magic-link unlock — `@noy-db/on-magic-link` provides the high-level
// invite / peer-recovery flows. The lower-level `MagicLinkGrant*`
// primitives below stay in hub because `on-magic-link` consumes them;
// direct use is supported but uncommon.

// Session policies —
export { PolicyEnforcer, createEnforcer, validateSessionPolicy } from './session/session-policy.js'

// Session tokens —
export {
  createSession,
  resolveSession,
  revokeSession,
  revokeAllSessions,
  isSessionAlive,
  activeSessionCount,
} from './session/session.js'
export type {
  SessionToken,
  CreateSessionResult,
  CreateSessionOptions,
} from './session/session.js'

// Dev-mode persistent unlock —
export {
  enableDevUnlock,
  loadDevUnlock,
  clearDevUnlock,
  isDevUnlockActive,
} from './session/dev-unlock.js'
export type { DevUnlockOptions } from './session/dev-unlock.js'

// Discriminated-union narrowing helper
export { isDiscriminant } from './util/discriminant.js'

// Crypto utilities (buffer encoding helpers + binary encrypt/hash)
export { bufferToBase64, base64ToBuffer, encryptBytes, decryptBytes } from './crypto.js'
export { encryptDeterministic, decryptDeterministic } from './crypto.js'

// hierarchical access
export type { GhostRecord, TierMode, CrossTierAccessEvent } from './types.js'
export { TierNotGrantedError, TierDemoteDeniedError, DelegationTargetMissingError } from './errors.js'

// lazy-mode index errors
export { IndexRequiredError, IndexWriteFailureError } from './errors.js'
// unique-index enforcement error
export { UniqueConstraintError, UnsupportedIndexOptionError } from './errors.js'
export { dekKey, effectiveClearance, assertTierAccess } from './team/tiers.js'
export type { DelegationToken, IssueDelegationOptions } from './team/delegation.js'
export { DELEGATIONS_COLLECTION, issueDelegation, loadActiveDelegations, revokeDelegation } from './team/delegation.js'

// magic-link-bridged cross-user KEK delegation
export type {
  MagicLinkGrantPayload,
  MagicLinkGrantRecord,
  IssueMagicLinkGrantOptions,
} from './team/magic-link-grant.js'
export {
  MAGIC_LINK_GRANTS_COLLECTION,
  MAGIC_LINK_CONTENT_INFO_PREFIX,
  MAGIC_LINK_KEK_INFO_PREFIX,
  deriveMagicLinkContentKey,
  writeMagicLinkGrant,
  readMagicLinkGrantRecord,
  listMagicLinkGrants,
  unwrapMagicLinkGrant,
  revokeMagicLinkGrant,
  magicLinkGrantRecordId,
  isMagicLinkGrantExpired,
} from './team/magic-link-grant.js'

// Diff
export { diff, formatDiff } from './history/diff.js'
export type { DiffEntry, ChangeType } from './history/diff.js'

// Vault-level diff
export { diffVault } from './vault-diff.js'
export type {
  VaultDiff,
  VaultDiffEntry,
  VaultDiffModifiedEntry,
  DiffOptions,
  DiffCandidate,
} from './vault-diff.js'

// Policy gates DSL — issue #9
export {
  PERSONAL_POLICY,
  STRICT_POLICY,
  mergePolicy,
  checkGate,
  describeGate,
  DEFAULT_FRESHNESS_MS,
  PolicyDeniedError,
  RecoveryNotEnrolledError,
  RecoveryProfileNotImplementedError,
  ManagedRecoveryNotEnrolledError,
  loadVaultPolicy,
  saveVaultPolicy,
  META_COLLECTION,
  POLICY_RECORD_ID,
} from './policy/index.js'
export type {
  VaultPolicy,
  GatePolicy,
  GateName,
  BuiltInGateName,
  FactorKind,
  FactorRequirement,
  FactorProof,
  FactorProofBundle,
  WarningRules,
  ActiveTier,
  PolicyDenyReason,
  CheckGateContext,
} from './policy/index.js'

// Validation — phrase format (#7)
export {
  validatePassphrase,
  assertStrongPassphrase,
  estimateEntropy,
  WeakPassphraseError,
} from './validation.js'
export type {
  PassphrasePolicy,
  PassphraseValidationResult,
  WeakPassphraseReason,
} from './validation.js'

// Query DSL
export {
  Query,
  executePlan,
  evaluateClause,
  evaluateFieldClause,
  readPath,
  CollectionIndexes,
  applyJoins,
  DEFAULT_JOIN_MAX_ROWS,
  DEFAULT_CROSS_JOIN_MAX_ROWS,
  resetJoinWarnings,
  buildLiveQuery,
  count,
  sum,
  avg,
  min,
  max,
  Aggregation,
  reduceRecords,
  GroupedQuery,
  GroupedQueryN,
  GroupedAggregation,
  groupAndReduce,
  GROUPBY_WARN_CARDINALITY,
  GROUPBY_MAX_CARDINALITY,
  ScanBuilder,
} from './query/index.js'
export type {
  QueryPlan,
  QuerySource,
  OrderBy,
  Operator,
  Clause,
  FieldClause,
  FilterClause,
  GroupClause,
  IndexDef,
  HashIndex,
  JoinLeg,
  JoinContext,
  JoinableSource,
  JoinStrategy,
  LiveQuery,
  LiveUpstream,
  Reducer,
  ReducerOptions,
  AggregateSpec,
  AggregateResult,
  AggregationUpstream,
  LiveAggregation,
  GroupedRow,
  GroupedRowN,
  ScanPageProvider,
} from './query/index.js'

// Scan-mode full-text search (#308)
export { tokenize } from './search/index.js'
export type { Tokenizer, SearchOptions, SearchResult, SearchEntry } from './search/index.js'
