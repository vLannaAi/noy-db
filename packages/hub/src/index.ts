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

// Blob store (v0.12 #103 #105)
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

// Sync policy (v0.12 #101)
export type { SyncPolicy, PushPolicy, PullPolicy, PushMode, PullMode, SyncSchedulerStatus } from './store/sync-policy.js'
export { SyncScheduler, INDEXED_STORE_POLICY, BUNDLE_STORE_POLICY } from './store/sync-policy.js'

// Sync target (v0.12 #158)
export type { SyncTarget, SyncTargetRole } from './types.js'

// Store routing (v0.12 #162)
export { routeStore } from './store/route-store.js'
export type {
  RouteStoreOptions, RoutedNoydbStore, BlobStoreRoute, AgeRoute,
  BlobLifecyclePolicy, OverrideTarget, OverrideOptions, SuspendOptions, RouteStatus,
} from './store/route-store.js'

// Store middleware (v0.12 #164 E4)
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
  BundleIntegrityError,
  BundleVersionConflictError,
  SessionExpiredError,
  SessionNotFoundError,
  SessionPolicyError,
  ExportCapabilityError,
  ReadOnlyAtInstantError,
  ReadOnlyFrameError,
} from './errors.js'

// Bundle format — `.noydb` container (v0.6 #100)
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

// Schema validation — Standard Schema v1 integration (v0.4+)
export type {
  StandardSchemaV1,
  StandardSchemaV1SyncResult,
  StandardSchemaV1Issue,
  InferOutput,
} from './schema.js'
export { validateSchemaInput, validateSchemaOutput } from './schema.js'

// Time-machine queries (v0.16 #215) — vault.at(ts) method lives on
// Vault; these classes are the return types.
export { VaultInstant, CollectionInstant } from './history/time-machine.js'
export type { VaultEngine } from './history/time-machine.js'

// Shadow vaults (v0.16 #217) — vault.frame() method lives on Vault;
// these classes are the return types.
export { VaultFrame, CollectionFrame } from './shadow/vault-frame.js'

// Consent boundaries (v0.16 #218) — vault.withConsent() / .consentAudit()
// live on Vault; these are the types + constants.
export { CONSENT_AUDIT_COLLECTION } from './consent/consent.js'
export type {
  ConsentContext,
  ConsentOp,
  ConsentAuditEntry,
  ConsentAuditFilter,
} from './consent/consent.js'

// Hash-chained ledger (v0.4+)
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

// Foreign-key references via ref() (v0.4 — #45)
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

// Core classes
export { Noydb, createNoydb } from './noydb.js'
export { Vault } from './vault.js'
export { Collection } from './collection.js'
export type { CacheOptions, CacheStats, CollectionChangeEvent } from './collection.js'

// CRDT mode (v0.9 #132)
export type { CrdtMode, CrdtState, LwwMapState, RgaState, YjsState } from './crdt.js'
export { resolveCrdtSnapshot, mergeCrdtStates } from './crdt.js'

// Presence (v0.9 #134)
export { PresenceHandle } from './team/presence.js'
export type { PresencePeer } from './types.js'
export { derivePresenceKey } from './crypto.js'
export { SyncEngine } from './team/sync.js'
export { SyncTransaction } from './team/sync-transaction.js'

// Multi-record transactions (v0.16 #240)
export { TxContext, TxVault, TxCollection, runTransaction } from './tx/transaction.js'
export type { TxOp } from './types.js'

// Accounting periods (v0.17 #201 / #202)
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

// Biometric — removed in v0.15.1 as redundant with @noy-db/on-webauthn
// (which supports PRF + rawId fallback + BE-flag guard). Legacy consumers
// migrate to `import { enrollWebAuthn, unlockWebAuthn } from '@noy-db/on-webauthn'`.

// i18n — dictKey + DictionaryHandle (v0.8 #81)
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

// i18n — i18nText (v0.8 #82)
export {
  i18nText,
  isI18nTextDescriptor,
  validateI18nTextValue,
  resolveI18nText,
  applyI18nLocale,
} from './i18n/core.js'
export type { I18nTextOptions, I18nTextDescriptor } from './i18n/core.js'

// i18n errors (v0.8 #81 #82 #83)
export {
  ReservedCollectionNameError,
  DictKeyMissingError,
  DictKeyInUseError,
  MissingTranslationError,
  LocaleNotSpecifiedError,
  TranslatorNotConfiguredError,
} from './errors.js'

// Locale read options + translator audit log (v0.8)
export type { LocaleReadOptions } from './types.js'

// _sync_credentials reserved collection — v0.7 #110
export {
  putCredential,
  getCredential,
  deleteCredential,
  listCredentials,
  credentialStatus,
  SYNC_CREDENTIALS_COLLECTION,
} from './team/sync-credentials.js'
export type { SyncCredential } from './team/sync-credentials.js'

// Magic-link unlock — extracted to @noy-db/on-magic-link in v0.15.1.
// Consumers should: `import { ... } from '@noy-db/on-magic-link'`.

// Session policies — v0.7 #114
export { PolicyEnforcer, createEnforcer, validateSessionPolicy } from './session/session-policy.js'

// Session tokens — v0.7 #109
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

// Dev-mode persistent unlock — v0.7 #119
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

// v0.18 hierarchical access
export type { GhostRecord, TierMode, CrossTierAccessEvent } from './types.js'
export { TierNotGrantedError, TierDemoteDeniedError, DelegationTargetMissingError } from './errors.js'

// v0.22 lazy-mode index errors (#265)
export { IndexRequiredError, IndexWriteFailureError } from './errors.js'
export { dekKey, effectiveClearance, assertTierAccess } from './team/tiers.js'
export type { DelegationToken, IssueDelegationOptions } from './team/delegation.js'
export { DELEGATIONS_COLLECTION, issueDelegation, loadActiveDelegations, revokeDelegation } from './team/delegation.js'

// v0.21 #257 — magic-link-bridged cross-user KEK delegation
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
