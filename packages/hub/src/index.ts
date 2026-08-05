/**
 * **@noy-db/hub** — zero-knowledge, offline-first, encrypted document store.
 *
 * ## What it is
 *
 * A TypeScript library that encrypts every record with AES-256-GCM before it
 * reaches any storage backend. The store (file, DynamoDB, S3, IndexedDB, …)
 * only ever sees ciphertext — it has no way to read or tamper with your data
 * without the user's secret.
 *
 * ## Architecture in one diagram
 *
 * ```
 * Secret
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
 * import { toFile } from '@noy-db/to-file'
 *
 * const db = await createNoydb({ store: toFile({ dir: './data' }) })
 * const acme = await db.openVault('acme', { secret: 'hunter2' })
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
 * | `@noy-db/to-browser-idb` | IndexedDB store (atomic CAS) |
 * | `@noy-db/to-memory` | In-memory store (testing) |
 * | `@noy-db/to-aws-dynamo` | DynamoDB single-table store *(noy-db-to)* |
 * | `@noy-db/to-aws-s3` | S3 object store *(noy-db-to)* |
 * | `@noy-db/to-postgres` | PostgreSQL store *(noy-db-to)* |
 * | `@noy-db/in-vue` | Vue 3 composables |
 * | `@noy-db/in-pinia` | Pinia store integration |
 * | `@noy-db/in-nuxt` | Nuxt 4 module |
 * | `@noy-db/on-webauthn` | Hardware-key / passkey unlock |
 * | `@noy-db/on-oidc` | OIDC / federated login unlock |
 *
 * @packageDocumentation
 */

// Environment check — throws if Node <18 or crypto.subtle missing
import './kernel/env-check.js'

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
  ErasureEnforcement,
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
} from './kernel/types.js'

export {
  NOYDB_FORMAT_VERSION,
  NOYDB_KEYRING_VERSION,
  NOYDB_BACKUP_VERSION,
  NOYDB_SYNC_VERSION,
  createStore,
} from './kernel/types.js'

export type {
  StoreAuthKind,
  StoreAuth,
  StoreCapabilities,
  StoreCredentials,
  StoreCredentialSource,
} from './kernel/types.js'

// Blob store
export type {
  NoydbPodStore,
  NoydbBundleStore,
  BlobObject,
  SlotRecord,
  SlotInfo,
  VersionRecord,
  BlobPutOptions,
  BlobResponseOptions,
} from './kernel/types.js'
export { BlobSet } from './with-shape/blobs/blob-set.js'
export { memoryObjectProjection } from './with-shape/blobs/object-projection.js'
export type {
  ObjectProjection,
  ObjectMeta,
  ObjectListEntry,
  PutObjectOptions,
  ObjectUrlOptions,
  PutUrlOptions,
} from './with-shape/blobs/object-projection.js'
export { importExternalObjects } from './with-shape/blobs/import-external.js'
export type {
  ImportableCollection,
  ImportExternalOptions,
  ImportExternalResult,
} from './with-shape/blobs/import-external.js'
export {
  BLOB_COLLECTION,
  BLOB_INDEX_COLLECTION,
  BLOB_CHUNKS_COLLECTION,
  BLOB_SLOTS_PREFIX,
  BLOB_VERSIONS_PREFIX,
  DEFAULT_CHUNK_SIZE,
} from './with-shape/blobs/blob-set.js'
export { detectMimeType, detectMagic, isPreCompressed } from './with-shape/blobs/mime-magic.js'
export {
  BLOB_INTENT_COLLECTION,
  getIntent,
  createIntent,
  deleteIntent,
  sweepBlobIntents,
} from './with-shape/blobs/blob-intent.js'
export type { BlobIntent, BlobIntentHold, BlobIntentResume } from './with-shape/blobs/blob-intent.js'
export { BlobIntentPendingError, BlobOfflineError } from './kernel/errors.js'
export { wrapPodStore, createPodStore, wrapBundleStore, createBundleStore } from './with-pod/pod-store.js'
export type {
  WrappedPodNoydbStore,
  WrapPodStoreOptions,
  WrappedBundleNoydbStore,
  WrapBundleStoreOptions,
} from './with-pod/pod-store.js'

// Observable write-queue
export type { WriteQueue } from './kernel/write-queue.js'

// Write lifecycle hooks
export type { WriteEvent, WriteHook } from './port/with/write-hooks.js'
/** #841 — the option shape `vault.collection()` takes, so callers can name it. */
export type { OpenCollectionOptions } from './port/with/collection-options.js'
/** #839 — the named type-level shape `vault.collection()` accepts. */
export type { CollectionShape, SensitiveOf, IndexedOf, MoneyOf } from './kernel/types.js'

// Runtime schema introspection
export type { SchemaIntrospection } from './with-shape/introspection/types.js'

// Field metadata
export type { FieldMeta, SemanticType } from './with-shape/introspection/field-meta.js'
export type { CollectionMeta, VaultMeta } from './with-shape/introspection/meta.js'
export type { CollectionDescription, DescribedField, DescribeOptions } from './with-shape/introspection/describe.js'
export { applyListProjection, type ListProjectionOptions } from './with-shape/introspection/projection.js'

// Dry-run transactions
export type { DryRunResult, AffectedDocument, GuardViolation } from './with-commit/tx/dry-run.js'

// Multi-tab coordination
export type { TabRole, TabPresence, TabCoordinationOptions, TabLockManager, TabChannel } from './with-sync/tab-coordination.js'
// Cross-tab write conflict
export type { WriteConflict } from './kernel/types.js'

// Schema-update strategies
export type {
  SchemaDelta,
  FieldChange,
  UpdateContext,
  UpdateDecision,
  SchemaUpdateStrategy,
} from './with-shape/schema-update/index.js'
export { blindUpdate, additiveOnly, lockSchema, coordinatedCutover } from './with-shape/schema-update/index.js'
export type { FenceState, FenceDoc } from './with-shape/schema-update/fence.js'

// Sync policy
export type { SyncPolicy, PushPolicy, PullPolicy, PushMode, PullMode, SyncSchedulerStatus, ReadinessState } from './kernel/sync-policy.js'
export { SyncScheduler, INDEXED_STORE_POLICY, POD_STORE_POLICY, BUNDLE_STORE_POLICY } from './kernel/sync-policy.js'

// Sync target
export type { SyncTarget, SyncTargetInfo, SyncTargetRole } from './kernel/types.js'

// Store routing
export { memoryStore } from './kernel/memory-store.js'
export { routeStore } from './with-store/route-store.js'
export type {
  RouteStoreOptions, RoutedNoydbStore, BlobStoreRoute, AgeRoute,
  BlobLifecyclePolicy, OverrideTarget, OverrideOptions, SuspendOptions, RouteStatus,
} from './with-store/route-store.js'

// Store middleware
export { wrapStore, withRetry, withLogging, withMetrics, withCircuitBreaker, withCache, withHealthCheck } from './with-store/store-middleware.js'
export type {
  StoreMiddleware, RetryOptions, LoggingOptions, LogLevel,
  MetricsOptions, StoreOperation, CircuitBreakerOptions, StoreCacheOptions, HealthCheckOptions,
} from './with-store/store-middleware.js'

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
  UnknownStoreKindError,
  DuplicateStoreKindError,
  ConflictError,
  isConflictError,
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
  SequenceNotEnabledError,
  BundleIntegrityError,
  BundleSealMismatchError,
  PodVersionConflictError,
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
  AttestationNotEnabledError,
  ClassifiedNotEnabledError,
  TiersNotEnabledError,
  PortabilityNotEnabledError,
  SchemaUpdateError,
  NonAdditiveSchemaChangeError,
  SchemaLockedError,
  SchemaFenceError,
  MigrationRequiredError,
  QuiesceTimeoutError,
} from './kernel/errors.js'

// ─── Snapshot errors ─────────────────────────────────────────────────────────
export { SnapshotNotFoundError } from './kernel/errors.js'
export type { SnapshotMeta, RetentionPolicy } from './with-fork/snapshots/strategy.js'

// ─── Record cold-storage archival ───────────────────────────────────────
export { withArchive } from './with-fork/archive/index.js'
export type {
  ArchiveStrategy,
  WithArchiveOptions,
  ArchivePolicy,
  ArchiveResult,
  ArchiveRunOptions,
} from './with-fork/archive/index.js'

// ─── Atomic sequence ─────────────────────────────────────────────────────
export { SequenceStore, resolveSequenceKey, compileSequenceFormat } from './with-commit/sequence/index.js'
export type { SequenceHandle, FormattedSequenceHandle, NextOptions, SequenceOptions, SequenceStoreOptions } from './with-commit/sequence/index.js'
export { withSequence, NO_SEQUENCE } from './with-commit/sequence/index.js'
export type { SequenceStrategy } from './with-commit/sequence/index.js'

// Deferred numbering — store-clock-ordered serials for non-CAS stores.
export { withDeferredNumbering } from './with-commit/numbering/descriptor.js'
export type {
  DeferredNumberingConfig,
  WithDeferredNumberingOptions,
} from './with-commit/numbering/descriptor.js'
export type { Assignment as NumberingAssignment } from './with-commit/numbering/index.js'
export { NumberingUncertaintyError } from './kernel/errors.js'
export type { StoreTime } from './kernel/types.js'

export { STATE_VAULT_NAME } from './kernel/constants.js'
export { UnknownShardError, ShardProvisioningError, VaultTemplateNotFoundError, ReservedVaultNameError, DataResidencyError } from './kernel/errors.js'
export { ForgetStrategyNotConfiguredError } from './kernel/errors.js'
export { SealedRecordExpiredError, SealedRecordMismatchError, RecordCekNotFoundError, SealedRecordNotEnabledError } from './kernel/errors.js'

// Bundle format — `.noydb` container
export {
  writePod,
  readPod,
  readPodHeader,
  writeNoydbBundle,
  readNoydbBundle,
  readNoydbBundleHeader,
  verifyPodHeader,
} from './with-pod/bundle.js'
export { exportAccessibleData } from './with-audit/portability/export-accessible.js'
export type { ExportAccessibleOptions } from './with-audit/portability/export-accessible.js'
export { withdrawAccessibleData } from './with-audit/portability/withdraw-accessible.js'
export type { WithdrawAccessibleOptions, WithdrawResult, FrozenSnapshotRef } from './with-audit/portability/withdraw-accessible.js'
export {
  requestWithdrawal,
  listWithdrawalRequests,
  approveWithdrawal,
  rejectWithdrawal,
  WithdrawalRequestError,
} from './with-audit/portability/request-withdrawal.js'
export type {
  RequestWithdrawalOptions,
  RequestWithdrawalResult,
  WithdrawalRequest,
  WithdrawalRequestStatus,
  ApproveWithdrawalOptions,
  RejectWithdrawalOptions,
} from './with-audit/portability/request-withdrawal.js'
export type {
  NoydbPodHeader,
  NoydbBundleHeader,
  CompressionAlgo,
  UnlockMethod,
} from './with-pod/format.js'
export type {
  WritePodOptions,
  WriteNoydbBundleOptions,
  ReadNoydbBundleOptions,
  NoydbBundleReadResult,
  AutoCredentialKind,
  AutoCredential,
  PodVerifyResult,
} from './with-pod/bundle.js'
export {
  NOYDB_BUNDLE_MAGIC,
  NOYDB_BUNDLE_PREFIX_BYTES,
  NOYDB_BUNDLE_FORMAT_VERSION,
  hasNoydbBundleMagic,
} from './with-pod/format.js'
export { generateULID, isULID } from './with-pod/ulid.js'
// Pod-signature family-wide signing convention (#943) — pod header, the
// Redirect record (#944), and manifest writes (#941) all sign through this.
export { signRecord, verifyRecord, signedBytes, POD_SIG_ALG } from './with-pod/signature.js'
export { decryptExtractedPartition } from './with-cargo/decrypt-partition.js'
export type { DecryptedRecord } from './with-cargo/decrypt-partition.js'

// Redirect record (#944): a signed "this moved, go there" pointer carried
// in the pod's plaintext header, plus the followRedirects resolver.
export { readPodRedirect } from './with-pod/bundle.js'
export { signRedirect, verifyRedirect, followRedirects } from './with-pod/redirect.js'
export type { Redirect, RedirectHop, FollowRedirectsResult } from './with-pod/redirect.js'
// DocSigner is signRedirect's signer param — re-exported here so it's
// nameable from the same entry (type-reachability guard).
export type { DocSigner } from './with-audit/attestation/signer.js'
export {
  RedirectDepthExceededError,
  RedirectLoopError,
  RedirectBadSignatureError,
  RedirectUnreachableError,
} from './kernel/errors.js'

// Manifest engine (#941): the pod read-path orchestrator — header → verify
// → unlock → manifest → generation fence → data — plus the schema manifest
// (an INDEX over per-collection `_schemas/<collection>` entries, not the
// schemas themselves) it re-derives on every open.
export { open } from './with-pod/open.js'
export type { OpenPodOptions, OpenPodResult } from './with-pod/open.js'
export { deriveSchemaManifest } from './with-shape/manifest/derive.js'
export type { DeriveSchemaManifestResult, LookupDEK } from './with-shape/manifest/derive.js'
export { loadSchemaManifestEntry } from './with-shape/manifest/storage.js'
export type { GetManifestDEK, LoadedSchemaManifest } from './with-shape/manifest/storage.js'
export type { SchemaManifest, SchemaManifestEntry } from './with-shape/manifest/types.js'
export { MANIFEST_COLLECTION, isManifestReservedCollection } from './with-shape/manifest/reserved-collections.js'
export { ManifestConflictError, PodHeaderVerificationError } from './kernel/errors.js'

// Schema validation — Standard Schema v1 integration
export type {
  StandardSchemaV1,
  StandardSchemaV1SyncResult,
  StandardSchemaV1Issue,
  InferOutput,
} from './kernel/schema.js'
export { validateSchemaInput, validateSchemaOutput } from './kernel/schema.js'

// Introspection — vault.dumpSchema() returns a structured snapshot.
// The CLI `noydb describe` command consumes this; programmatic callers
// can use it directly from app code (admin pages, audit tooling).
export type {
  VaultSchemaSnapshot,
  DumpSchemaOptions,
  CollectionDescriptor,
  CollectionConfig,
  CollectionStats,
  FieldDescriptor,
  FieldSource,
  MaterializedViewDescriptor,
  OverlayViewDescriptor,
  DerivationDescriptor,
  BehaviorSummary,
  GuardBehaviorEntry,
  DerivationBehaviorEntry,
  DerivationOutputEntry,
  MaterializedViewBehaviorEntry,
  OverlayBehaviorEntry,
  SatelliteBehaviorEntry,
} from './with-shape/introspection/index.js'

// Persisted JSON Schema — opt-in per-collection encrypted snapshot
// of the developer's Zod (or other Standard Schema) validator. Powers
// `noydb describe` audit output from a bundle alone.
export type {
  PersistedSchemaEnvelope,
  PersistedSchemaKind,
  PersistSchemaResult,
} from './with-shape/persisted-schemas/index.js'
export {
  SCHEMAS_COLLECTION,
  derivePersistedSchema,
  isZodSchema,
  loadPersistedSchema,
  savePersistedSchema,
  persistSchemaIfNeeded,
} from './with-shape/persisted-schemas/index.js'
// `persistSchemaIfNeeded`'s optional `manifestSync` param type (#941 Task 3
// carried gap — same type-reachability guard the manifest-engine exports
// below satisfy for `/pod`).
export type { ManifestSyncDeps } from './with-shape/manifest/sync.js'

// Time-machine queries — vault.at(ts) method lives on
// Vault; these classes are the return types.
export { VaultInstant, CollectionInstant } from './with-commit/history/time-machine.js'
export type { VaultEngine } from './with-commit/history/time-machine.js'

// Shadow vaults — vault.frame() method lives on Vault;
// these classes are the return types.
export { VaultFrame, CollectionFrame } from './with-fork/shadow/vault-frame.js'

// Consent boundaries — vault.withConsent() / .consentAudit()
// live on Vault; these are the types + constants.
export { CONSENT_AUDIT_COLLECTION } from './with-audit/consent/consent.js'
export type {
  ConsentContext,
  ConsentOp,
  ConsentAuditEntry,
  ConsentAuditFilter,
} from './with-audit/consent/consent.js'

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
} from './with-commit/history/ledger/index.js'
export type {
  LedgerEntry,
  AppendInput,
  VerifyResult,
  JsonPatch,
  JsonPatchOp,
} from './with-commit/history/ledger/index.js'

// Foreign-key references via ref()
export {
  ref,
  refArray,
  isRefArray,
  RefRegistry,
  RefIntegrityError,
  RefScopeError,
} from './kernel/refs.js'
export type {
  RefMode,
  RefDescriptor,
  RefViolation,
} from './kernel/refs.js'

// Managed many-to-many link sets via vault.link() / vault.links()
export {
  isLinkCollectionName,
  LinkEndpointError,
  LinkIntegrityError,
} from './with-shape/links/link-set.js'
export type {
  LinkSpec,
  LinkRow,
  LinkOnDelete,
  LinkSetHandle,
} from './with-shape/links/link-set.js'

// Keyring types
export type { UnlockedKeyring } from './with-party/team/keyring.js'

// Tier-2 authenticator slots
export {
  enrollAuthenticator,
  removeAuthenticator,
  findAuthenticator,
} from './with-party/team/authenticators.js'
export type {
  EnrollAuthenticatorOptions,
  EnrollAuthenticatorWrappingKEKOptions,
  EnrollAuthenticatorWrappingDEKsOptions,
  UpdateAuthenticatorOptions,
} from './with-party/team/authenticators.js'

// Tier-3 quick-unlock state
export { QuickUnlockStore } from './with-party/session/unlock-state.js'
export type { QuickUnlockState } from './with-party/session/unlock-state.js'

// Tier-1 change flows
export { rotateSecret as keyringRotateSecret } from './with-party/team/rotate-recover.js'
export type {
  RotateSecretInput,
  RecoverSecretInput,
  RecoverSecretResult,
  RecoveryProof,
  SlotRewrapContext,
  SlotRewrapCeremony,
} from './with-party/team/rotate-recover.js'

// Echo-secret mode (tier 1, 3-part ceremony) — spec #940
export { buildEchoBlock, verifyPrompt, resolveEchoReveal, verifyTypedEcho } from './with-party/team/echo-secret.js'
export type { EchoRevealChoice } from './with-party/team/echo-secret.js'
export { beginEchoUnlock } from './with-party/team/echo-ceremony.js'
export type { EchoCeremony, BeginEchoUnlockOptions } from './with-party/team/echo-ceremony.js'
export { MemoryDeviceSealProvider } from './with-party/team/device-seal.js'
export type { DeviceSealProvider } from './with-party/team/device-seal.js'
export type { EchoSecretParts } from './kernel/enclave/index.js'
export type { KeyringEchoBlock } from './kernel/types.js'
export type { EchoRecipientSecret } from './with-party/team/keyring.js'
export { EchoCeremonyRequiredError, WrongPromptError, WrongEchoError } from './kernel/errors.js'

// Cover (https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/services/public-envelope.md)
// Formerly "public envelope" (#799) — the old names below remain as
// deprecated aliases for one pre-release window; the wire format is frozen.
export {
  loadCover,
  saveCover,
  readCover,
  resolveSchema as resolveCoverSchema,
  validateCoverInput,
  isCover,
  COVER_FIELDS,
  DEFAULT_COVER_SCHEMA,
  COVER_RECORD_ID,
} from './with-party/directory/cover/index.js'
export type {
  Cover,
  CoverText,
  CoverSchema,
  CoverField,
  JsonValue,
  ResolvedCoverSchema,
  SetCoverInput,
} from './with-party/directory/cover/index.js'
export { readPodCover } from './with-pod/bundle.js'

// User envelope (design-history/2026-05-05-user-envelope-design.md)
export {
  USER_ENVELOPE_COLLECTION,
  USER_ENVELOPE_MAX_BYTES,
} from './kernel/constants.js'
export { UserEnvelopeOversizedError } from './kernel/errors.js'
export {
  loadUserEnvelope,
  saveUserEnvelope,
  deleteUserEnvelope,
  listUserEnvelopeIds,
} from './with-party/directory/user-envelope/index.js'
export type {
  UserEnvelope,
  DeepPartial,
  DeepPartialOrNull,
  Unsubscribe,
  LiveUserEnvelope,
  UserEnvelopePresented,
  UserEnvelopeCheckGate,
} from './kernel/types.js'
export { UserApi } from './with-party/directory/user-envelope/api.js'

// FR-6 sovereign custody — Deed / Custodian / Liberate.
export { CustodyApi } from './with-party/custody/index.js'
export type { GrantCustodianOptions } from './with-party/custody/index.js'
export { liberateVault } from './with-party/custody/liberate.js'
export type { LiberateOptions, LiberateResult } from './with-party/custody/liberate.js'
export { withCustody, NO_CUSTODY } from './with-party/custody/index.js'
export type { CustodyStrategy, CustodyHost } from './with-party/custody/index.js'
export { CustodyNotEnabledError } from './kernel/errors.js'
export { createDeedOwner, loadDeedMarker, isDeedVault } from './with-party/team/deed.js'
export type { DeedMarker } from './with-party/team/deed.js'

// #267 keyring-grant → team split — multi-user grant/revoke/rotate opt-in.
export { withTeam } from './with-party/team/active.js'
export { NO_TEAM } from './with-party/team/strategy.js'
export type { TeamStrategy } from './with-party/team/strategy.js'
export { TeamNotEnabledError } from './kernel/errors.js'

// #267 lazy service — lazy-mode (prefetch: false) explicit opt-in.
export { withLazy } from './with-store/lazy/active.js'
export type { LazyStrategy } from './with-store/lazy/strategy.js'

// Auth introspection
export {
  describeAuthConfig,
  diagramAuthConfig,
  describeUserAuth,
  describeAllUsersAuth,
} from './with-party/auth-introspection/index.js'

// Recovery storage — paper and Shamir profiles.
export {
  loadPaperRecoveryEntries,
  savePaperRecoveryEntries,
  burnPaperRecoveryEntry,
  mintPaperRecoveryEntry,
  unwrapDeksFromPaperEntry,
} from './with-party/team/recovery.js'
export type { PaperRecoveryEntry } from './with-party/team/recovery.js'

// Recovery dispatch types — discriminated
// unions for the polymorphic enroll/rotate paths. (RecoveryProof /
// RecoverSecretInput / RecoverSecretResult are already
// exported above.)


// Canonical wrap-DEKs primitive — shared crypto for tier-0
// (paper recovery), tier-2 wrap-DEKs (password), tier-3 (on-pin).
// `mintPaperRecoveryEntry` and `enrollPasswordAuthenticator` both
// delegate to these helpers.
export { mintWrappedDeksBlob, unwrapDeksFromBlob } from './with-party/team/wrapped-deks.js'
export type { WrappedDeksBlob } from './with-party/team/wrapped-deks.js'

// Managed-secret mode — rubber-hose-resistant vaults where
// hub generates the secret and seals it under a developer-provided
// SealingKeyProvider. The interface lives here; concrete providers
// (macOS Keychain, Windows Credential Manager, libsecret, AWS KMS)
// ship as separate packages.
export type { SealingKeyProvider, RecipientHint, RecipientSealer } from './with-party/team/managed-secret.js'
export type { ShamirRecoveryProvider } from './with-party/team/shamir-recovery-provider.js'
export {
  MemorySealingKeyProvider,
  MemoryRecipientSealer,
  sealRsaOaepTlv,
  parseRsaOaepTlv,
  aesGcmOpen,
} from './with-party/team/managed-secret.js'

// Peer-recovery — atomic db.recoverUser primitive.
// The team/peer-recover module also runs through Noydb.recoverUser for
// the policy-gated path; consumers can use the lower-level function
// directly when they don't want hub-level gating (e.g. in tests).
export { recoverUser } from './with-party/team/peer-recover.js'
export type { RecoverUserOptions } from './with-party/team/peer-recover.js'

// Export-capability helpers
export { hasExportCapability, evaluateExportCapability } from './with-party/team/keyring.js'
export { hasImportCapability, evaluateImportCapability } from './with-party/team/keyring.js'

// Bundle recipients
export type { BundleRecipient } from './with-party/team/keyring.js'
export { buildRecipientKeyringFile } from './with-party/team/keyring.js'

// Team enumeration — joined view of keyrings and their user envelopes.
// Useful for admin UIs that want to render team-member lists
// with profile data in a single pass.
export { listUsers, listUsersWithEnvelopes } from './with-party/team/keyring.js'
export type { ListUsersOptions } from './with-party/team/keyring.js'

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
} from './with-party/directory/index.js'
export type { DirectoryConfig, UserVisibility } from './with-party/directory/index.js'
export { DirectoryDisabledError } from './kernel/errors.js'

// Core classes
export { Noydb, createNoydb } from './kernel/noydb.js'
export { Vault } from './kernel/vault.js'
export { ElevatedHandle, ELEVATION_AUDIT_COLLECTION } from './with-commit/tx/elevated-handle.js'
export { Collection } from './kernel/collection.js'
export type { CacheOptions, CacheStats, CollectionChangeEvent } from './kernel/collection.js'

// CRDT mode
export type { CrdtMode, CrdtState, LwwMapState, RgaState, YjsState } from './with-commit/crdt/crdt.js'
export { resolveCrdtSnapshot, mergeCrdtStates } from './with-commit/crdt/crdt.js'

// Presence
export { PresenceHandle } from './with-sync/presence.js'
export type { PresencePeer } from './kernel/types.js'
export { derivePresenceKey } from './kernel/enclave/index.js'
export { SyncEngine } from './with-sync/engine.js'
export { SyncTransaction } from './with-sync/transaction.js'

// Multi-record transactions
export { TxContext, TxVault, TxCollection, runTransaction } from './with-commit/tx/transaction.js'
export type { TxOp } from './kernel/types.js'
export type { TransactionInvariant } from './with-commit/tx/invariants.js'
export type { WithTransactionsOptions } from './with-commit/tx/active.js'

// Guards (record lock + field freeze + amendment invariant) — see design-history/2026-05-18-guards-design.md
export { withGuard } from './with-audit/guards/index.js'
export { immutableGuard } from './with-audit/guards/index.js'
export type { ImmutableGuardConfig } from './with-audit/guards/index.js'
export { transitionGuard } from './with-audit/guards/index.js'
export type { TransitionGuardConfig } from './with-audit/guards/index.js'
export type {
  GuardSpec,
  GuardStrategy,
  GuardContext,
  GuardChange,
} from './with-audit/guards/index.js'

// Derivations (Dim 14) — see design-history/2026-05-01-dim14-derivation-v1-design.md
export { withDerivation } from './with-formula/derivations/index.js'
export { withRollup } from './with-formula/derivations/index.js'
export type { WithRollupOptions } from './with-formula/derivations/index.js'
export type {
  DerivationSpec,
  DerivationStrategy,
  DerivedFromMeta,
  OutputSpec,
  RecordOutputSpec,
  ArrayOutputSpec,
} from './with-formula/derivations/index.js'
export {
  DerivationCycleError,
  DerivationDepthError,
  DerivationOutputUnknownError,
  DerivationOutputShapeError,
  DerivationCapExceededError,
  DuplicateBehaviorNameError,
} from './kernel/errors.js'

// Materialized views (Dim 14 v2) — see design-history/2026-05-20-dim14-mv-v2-design.md
export { withMaterializedView } from './with-formula/materialized-views/index.js'
export type {
  MaterializedViewSpec,
  MaterializedViewStrategy,
  MaterializedViewOutput,
  MaterializedFromMeta,
  UnionSource,
  UnionArmJoin,
  ProjectionSpec,
  ProjectionJoinLeg,
} from './with-formula/materialized-views/index.js'
export {
  MaterializedViewCycleError,
  MaterializedViewConfigError,
  MaterializedViewSourceUnknownError,
  MaterializedViewTooLargeError,
} from './kernel/errors.js'

// Overlay views (Dim 14 v2) — see design-history/2026-05-20-dim14-mv-v2-design.md § Composition with operator-editable lifecycle
export { withOverlayedView } from './with-formula/overlay-views/index.js'
export type {
  OverlayedViewSpec,
  OverlayedViewStrategy,
  OverlayFieldMergeRule,
  OverlayFieldMergeMode,
} from './with-formula/overlay-views/index.js'
export {
  OverlayBaseIsVirtualError,
  OverlayCollectionUnavailableError,
  OverlayNameCollisionError,
  OverlayIdMismatchError,
} from './kernel/errors.js'

// Accounting periods
export { PERIODS_COLLECTION } from './with-audit/periods/index.js'
export type {
  PeriodRecord,
  ClosePeriodOptions,
  OpenPeriodOptions,
} from './with-audit/periods/index.js'
export { PeriodClosedError } from './kernel/errors.js'

// Cache module — LRU + byte budget parsing
export { Lru, parseBytes, estimateRecordBytes } from './kernel/cache/index.js'
export type { LruOptions, LruStats } from './kernel/cache/index.js'

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
} from './via/i18n/dictionary.js'
export type {
  DictKeyDescriptor,
  StaticDictDescriptor,
  DictEntry,
  DictionaryOptions,
} from './via/i18n/dictionary.js'

// i18n — i18nText
export {
  i18nText,
  isI18nTextDescriptor,
  validateI18nTextValue,
  resolveI18nText,
  applyI18nLocale,
} from './via/i18n/core.js'
export type { I18nTextOptions, I18nTextDescriptor, ResolveI18nOptions, I18nMap } from './via/i18n/core.js'

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
} from './via/money/index.js'
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
} from './via/money/index.js'

// via — public field composer (declares a field's Via feature(s) without a sugar key)
export { via, isViaFieldSpec } from './kernel/via/compose.js'
export type { ViaFieldSpec } from './kernel/via/compose.js'
export type { ViaPosture, ViaDescriptor } from './kernel/via/index.js'
export type { DerivationSkippedFrozen } from './kernel/via/dispatch.js'

// classified — preset catalog (creditCard/birthDate/email/phone) + validators
export { classified, luhnCheck, isClassifiedFieldSpec, isClassifiedGroup, resolveClassifiedFields, ClassifiedConfigError, ClassifiedNeverStoredError, ClassifiedValidationError, ClassifiedRevealError, ClassifiedVerifyError, ClassifiedRotationError } from './via/classified/index.js'
export type { ClassifiedFieldSpec, ClassifiedGroup, ClassifiedEntry, ClassifiedList, ClassifiedStorage, ClassifiedVerdict } from './via/classified/index.js'

// computed — schema-owned computed scalar fields
export { evalComputedFields, ComputedFieldError } from './with-formula/computed/index.js'
export type { ComputedFields, ComputedFn, ComputedFieldEntry } from './with-formula/computed/index.js'

// computed — via-feature declaration factory (materialized default / virtual read-time mode)
export { computed, isComputedDescriptor } from './via/computed/descriptor.js'
export type { ComputedDescriptor } from './via/computed/descriptor.js'

// i18n — resolution policy + script enforcement
export { resolvePolicy } from './via/i18n/policy.js'
export type { OnMissing, Layer, OnMissingPolicy } from './via/i18n/policy.js'
export { inferScripts, enforceScript } from './via/i18n/script.js'
export type { ScriptWarning } from './via/i18n/script.js'

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
} from './kernel/errors.js'

// lookup — the `lookup`/`enum`/`dict` via-feature (phase D): one binding,
// three backing tiers (static/reserved/collection) that `dictKey()`/
// `staticDict()` above compile onto as aliases. `enumOf` is the function's
// own name (`enum` is a reserved word); `enum` is re-exported alongside it
// as the documented spelling — both names refer to the identical function.
export { lookup, dict, enumOf, enum } from './via/lookup/index.js'
export { UnknownLookupKeyError, RestrictRefUnresolvableError } from './kernel/errors.js'
export type { LookupDescriptor, Vocabulary, OnDelete } from './via/lookup/index.js'

// Locale read options + translator audit log
export type { LocaleReadOptions } from './kernel/types.js'

// _sync_credentials reserved collection —
export {
  putCredential,
  getCredential,
  deleteCredential,
  listCredentials,
  credentialStatus,
  SYNC_CREDENTIALS_COLLECTION,
} from './with-sync/credentials.js'
export type { SyncCredential } from './with-sync/credentials.js'

// Magic-link unlock — `@noy-db/on-magic-link` provides the high-level
// invite / peer-recovery flows. The lower-level `MagicLinkGrant*`
// primitives below stay in hub because `on-magic-link` consumes them;
// direct use is supported but uncommon.

// Session policies —
export { PolicyEnforcer, createEnforcer, validateSessionPolicy } from './with-party/session/session-policy.js'

// Session tokens —
export {
  createSession,
  resolveSession,
  revokeSession,
  revokeAllSessions,
  isSessionAlive,
  activeSessionCount,
} from './with-party/session/session.js'
export type {
  SessionToken,
  CreateSessionResult,
  CreateSessionOptions,
} from './with-party/session/session.js'

// Dev-mode persistent unlock —
export {
  enableDevUnlock,
  loadDevUnlock,
  clearDevUnlock,
  isDevUnlockActive,
} from './with-party/session/dev-unlock.js'
export type { DevUnlockOptions } from './with-party/session/dev-unlock.js'

// Discriminated-union narrowing helper
export { isDiscriminant } from './kernel/util/discriminant.js'

// Crypto utilities (buffer encoding helpers + binary encrypt/hash)
export { bufferToBase64, base64ToBuffer, encryptBytes, decryptBytes } from './kernel/enclave/index.js'
export { encryptDeterministic, decryptDeterministic } from './kernel/enclave/index.js'
// Enclave fork-swap contract — optional-group refusal (C4)
export { EnclaveNotSupportedError } from './kernel/errors.js'

// hierarchical access
export type { GhostRecord, TierMode, CrossTierAccessEvent } from './kernel/types.js'
export { TierNotGrantedError, TierDemoteDeniedError, DelegationTargetMissingError, TierWriteRefusedError, UnsupportedTierCompositionError } from './kernel/errors.js'

// lazy-mode index errors
export { IndexRequiredError, IndexWriteFailureError } from './kernel/errors.js'
// Via posture-refusal error (#629 Task 8 — queryable: 'none' fields)
export { FieldNotQueryableError } from './kernel/errors.js'
// Hybrid-retrieval rank fusion (also the klum federation primitive)
export { fuseRetrieval, type FuseOptions } from './with-lookup/search/fuse.js'
// unique-index enforcement error
export { UniqueConstraintError, UnsupportedIndexOptionError } from './kernel/errors.js'
// embeddings / semantic-retrieval (L2)
export { EmbeddingDimMismatchError, EmbeddingModelMismatchError } from './kernel/errors.js'
export type { EmbeddingDescriptor } from './with-lookup/embeddings/index.js'

// magic-link-bridged cross-user KEK delegation
export type {
  MagicLinkGrantPayload,
  // Retained on the barrel (#843 C2): `writeMagicLinkGrant` is public and
  // returns it, so dropping it would leave callers unable to name the result.
  MagicLinkGrantRecord,
  IssueMagicLinkGrantOptions,
} from './with-party/team/magic-link-grant.js'
export {
  MAGIC_LINK_GRANTS_COLLECTION,
  deriveMagicLinkContentKey,
  writeMagicLinkGrant,
  readMagicLinkGrantRecord,
  listMagicLinkGrants,
  unwrapMagicLinkGrant,
  revokeMagicLinkGrant,
  magicLinkGrantRecordId,
  isMagicLinkGrantExpired,
} from './with-party/team/magic-link-grant.js'

// Diff
export { diff, formatDiff } from './with-commit/history/diff.js'
export type { DiffEntry, ChangeType } from './with-commit/history/diff.js'

// Vault-level diff
export { diffVault } from './with-cargo/vault-diff.js'
export type {
  VaultDiff,
  VaultDiffEntry,
  VaultDiffModifiedEntry,
  DiffOptions,
  DiffCandidate,
} from './with-cargo/vault-diff.js'

// Capability opt-in seam (S4): source-side extractPartition is gated behind
// withCargo() (adopt/decrypt and diffVault stay ungated host-side tooling).
export { withCargo, NO_CARGO } from './with-cargo/index.js'
export type { CargoStrategy } from './with-cargo/index.js'
export { CargoNotEnabledError } from './kernel/errors.js'

// Policy gates DSL — issue #9
export {
  PERSONAL_POLICY,
  STRICT_POLICY,
  mergePolicy,
  checkGate,
  describeGate,
  DEFAULT_FRESHNESS_MS,
  loadVaultPolicy,
  saveVaultPolicy,
  META_COLLECTION,
  POLICY_RECORD_ID,
} from './with-party/policy/index.js'
export {
  PolicyDeniedError,
  RecoveryNotEnrolledError,
  RecoveryProfileNotImplementedError,
  ManagedRecoveryNotEnrolledError,
} from './kernel/errors.js'
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
} from './kernel/types.js'
export type { PolicyDenyReason } from './kernel/errors.js'
export type { CheckGateContext } from './with-party/policy/index.js'

// Validation — phrase format (#7)
export {
  validateSecret,
  assertStrongSecret,
  estimateEntropy,
  WeakSecretError,
} from './kernel/validation.js'
export type {
  SecretPolicy,
  SecretValidationResult,
  WeakSecretReason,
} from './kernel/validation.js'

// Validation — echo-secret parts (#940)
export {
  validateEchoSecret,
  assertStrongEchoSecret,
  DEFAULT_ECHO_PROMPT_MIN_WORDS,
  DEFAULT_ECHO_MIN_WORD_LENGTH,
} from './kernel/validation.js'
export type { EchoSecretPolicy } from './kernel/validation.js'

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
  buildLiveQuery,
  ScanBuilder,
} from './kernel/query/index.js'
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
  ScanPageProvider,
} from './kernel/query/index.js'

// Query DSL helpers (escape-hatch types for consumers with dynamic field names)
export type { QueryField, IndexFieldName } from './kernel/types.js'

// Sealed-field access surface: `Sealed<V>` is the opaque handle a public
// read returns for a `sensitive` field; `SealedView<T, S>` is the record shape
// `get()` returns (sealed fields → handles); `SealedHandle` is the concrete
// class (exported for `instanceof` narrowing — the `Sealed.sealed` discriminant
// also narrows structurally).
export type { Sealed, SealedView } from './kernel/types.js'
export { SealedHandle } from './kernel/types.js'

// Scan-mode full-text search
export { tokenize } from './with-lookup/search/index.js'
export type { Tokenizer, SearchOptions, SearchResult, SearchEntry } from './with-lookup/search/index.js'
export type { RetrieveOptions, RetrieveHit } from './with-lookup/search/index.js'
// Capability opt-in seam (S4): search / retrieve / similarTo / warmIndex /
// flushIndex + the embedding write-hook are gated behind withSearch().
export { withSearch, NO_SEARCH } from './with-lookup/search/index.js'
export type { SearchStrategy } from './with-lookup/search/index.js'
export { SearchNotEnabledError } from './kernel/errors.js'
// #764: a stuck persisted search-index compensation (a failed compensating
// remove() of a stale _ftindex blob) — callers can catch this deliberately.
export { PersistedIndexCompensationError } from './kernel/errors.js'

// #837 — types named by this barrel's own public signatures that were
// previously unspellable (exported from no entry at all). The
// type-reachability guard now fails the build when a new one appears.
export type { EnclaveKey, EncryptResult } from './kernel/enclave/index.js'
export type { LookupBacking } from './via/lookup/descriptor.js'
export type { PolicyEnforcerOptions } from './with-party/session/session-policy.js'
export type { TransformFn } from './with-shape/schema-update/types.js'
