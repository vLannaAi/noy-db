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
export { BlobSet } from './blob-set.js'
export {
  BLOB_COLLECTION,
  BLOB_INDEX_COLLECTION,
  BLOB_CHUNKS_COLLECTION,
  BLOB_SLOTS_PREFIX,
  BLOB_VERSIONS_PREFIX,
  DEFAULT_CHUNK_SIZE,
} from './blob-set.js'
export { detectMimeType, detectMagic, isPreCompressed } from './mime-magic.js'
export { wrapBundleStore, createBundleStore } from './bundle-store.js'
export type { WrappedBundleNoydbStore, WrapBundleStoreOptions } from './bundle-store.js'

// Sync policy (v0.12 #101)
export type { SyncPolicy, PushPolicy, PullPolicy, PushMode, PullMode, SyncSchedulerStatus } from './sync-policy.js'
export { SyncScheduler, INDEXED_STORE_POLICY, BUNDLE_STORE_POLICY } from './sync-policy.js'

// Sync target (v0.12 #158)
export type { SyncTarget, SyncTargetRole } from './types.js'

// Store routing (v0.12 #162)
export { routeStore } from './route-store.js'
export type { RouteStoreOptions, RoutedNoydbStore, BlobStoreRoute, AgeRoute } from './route-store.js'

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
} from './ledger/index.js'
export type {
  LedgerEntry,
  AppendInput,
  VerifyResult,
  JsonPatch,
  JsonPatchOp,
} from './ledger/index.js'

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
export type { UnlockedKeyring } from './keyring.js'

// Core classes
export { Noydb, createNoydb } from './noydb.js'
export { Vault } from './vault.js'
export { Collection } from './collection.js'
export type { CacheOptions, CacheStats } from './collection.js'

// CRDT mode (v0.9 #132)
export type { CrdtMode, CrdtState, LwwMapState, RgaState, YjsState } from './crdt.js'
export { resolveCrdtSnapshot, mergeCrdtStates } from './crdt.js'

// Presence (v0.9 #134)
export { PresenceHandle } from './presence.js'
export type { PresencePeer } from './types.js'
export { derivePresenceKey } from './crypto.js'
export { SyncEngine } from './sync.js'
export { SyncTransaction } from './sync-transaction.js'

// Cache module — LRU + byte budget parsing
export { Lru, parseBytes, estimateRecordBytes } from './cache/index.js'
export type { LruOptions, LruStats } from './cache/index.js'

// Biometric (browser only)
export {
  isBiometricAvailable,
  enrollBiometric,
  unlockBiometric,
  removeBiometric,
  saveBiometric,
  loadBiometric,
} from './biometric.js'
export type { BiometricCredential } from './biometric.js'

// i18n — dictKey + DictionaryHandle (v0.8 #81)
export {
  dictKey,
  isDictKeyDescriptor,
  isDictCollectionName,
  dictCollectionName,
  DictionaryHandle,
  DICT_COLLECTION_PREFIX,
} from './dictionary.js'
export type {
  DictKeyDescriptor,
  DictEntry,
  DictionaryOptions,
} from './dictionary.js'

// i18n — i18nText (v0.8 #82)
export {
  i18nText,
  isI18nTextDescriptor,
  validateI18nTextValue,
  resolveI18nText,
  applyI18nLocale,
} from './i18n.js'
export type { I18nTextOptions, I18nTextDescriptor } from './i18n.js'

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
} from './sync-credentials.js'
export type { SyncCredential } from './sync-credentials.js'

// Magic-link unlock — v0.7 #113
export {
  deriveMagicLinkKEK,
  createMagicLinkToken,
  isMagicLinkValid,
  buildMagicLinkKeyring,
  MAGIC_LINK_DEFAULT_TTL_MS,
} from './magic-link.js'
export type {
  MagicLinkToken,
  CreateMagicLinkOptions,
} from './magic-link.js'

// Session policies — v0.7 #114
export { PolicyEnforcer, createEnforcer, validateSessionPolicy } from './session-policy.js'

// Session tokens — v0.7 #109
export {
  createSession,
  resolveSession,
  revokeSession,
  revokeAllSessions,
  isSessionAlive,
  activeSessionCount,
} from './session.js'
export type {
  SessionToken,
  CreateSessionResult,
  CreateSessionOptions,
} from './session.js'

// Dev-mode persistent unlock — v0.7 #119
export {
  enableDevUnlock,
  loadDevUnlock,
  clearDevUnlock,
  isDevUnlockActive,
} from './dev-unlock.js'
export type { DevUnlockOptions } from './dev-unlock.js'

// Crypto utilities (buffer encoding helpers + binary encrypt/hash)
export { bufferToBase64, base64ToBuffer, encryptBytes, decryptBytes } from './crypto.js'

// Diff
export { diff, formatDiff } from './diff.js'
export type { DiffEntry, ChangeType } from './diff.js'

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
