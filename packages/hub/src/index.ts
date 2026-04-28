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
  DanglingReferenceError,
  FilenameSanitizationError,
  PathEscapeError,
  ElevationExpiredError,
  AlreadyElevatedError,
  LedgerContentionError,
  BundleIntegrityError,
  BundleVersionConflictError,
  SessionExpiredError,
  SessionNotFoundError,
  SessionPolicyError,
  ExportCapabilityError,
  ImportCapabilityError,
  ReadOnlyAtInstantError,
  ReadOnlyFrameError,
} from './errors.js'

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
  NoydbBundleReadResult,
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
  RefRegistry,
  RefIntegrityError,
  RefScopeError,
} from './refs.js'
export type {
  RefMode,
  RefDescriptor,
  RefViolation,
} from './refs.js'

// Keyring types
export type { UnlockedKeyring } from './team/keyring.js'

// Export-capability helpers (RFC #249)
export { hasExportCapability, evaluateExportCapability } from './team/keyring.js'
export { hasImportCapability, evaluateImportCapability } from './team/keyring.js'

// Bundle recipients (#301 — multi-recipient re-keyed .noydb export)
export type { BundleRecipient } from './team/keyring.js'
export { buildRecipientKeyringFile } from './team/keyring.js'

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
  isDictCollectionName,
  dictCollectionName,
  DictionaryHandle,
  DICT_COLLECTION_PREFIX,
} from './i18n/dictionary.js'
export type {
  DictKeyDescriptor,
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
export type { I18nTextOptions, I18nTextDescriptor } from './i18n/core.js'

// i18n errors
export {
  ReservedCollectionNameError,
  DictKeyMissingError,
  DictKeyInUseError,
  MissingTranslationError,
  LocaleNotSpecifiedError,
  TranslatorNotConfiguredError,
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

// Magic-link unlock — extracted to @noy-db/on-magic-link in.
// Consumers should: `import { ... } from '@noy-db/on-magic-link'`.

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

// Crypto utilities (buffer encoding helpers + binary encrypt/hash)
export { bufferToBase64, base64ToBuffer, encryptBytes, decryptBytes } from './crypto.js'
export { encryptDeterministic, decryptDeterministic } from './crypto.js'

// hierarchical access
export type { GhostRecord, TierMode, CrossTierAccessEvent } from './types.js'
export { TierNotGrantedError, TierDemoteDeniedError, DelegationTargetMissingError } from './errors.js'

// lazy-mode index errors
export { IndexRequiredError, IndexWriteFailureError } from './errors.js'
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

// Validation
export { validatePassphrase, estimateEntropy } from './validation.js'

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
  ScanPageProvider,
} from './query/index.js'
