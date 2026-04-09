// Environment check — throws if Node <18 or crypto.subtle missing
import './env-check.js'

// Types
export type {
  Role,
  Permission,
  Permissions,
  EncryptedEnvelope,
  CompartmentSnapshot,
  NoydbAdapter,
  ListPageResult,
  KeyringFile,
  CompartmentBackup,
  DirtyEntry,
  SyncMetadata,
  Conflict,
  ConflictStrategy,
  PushResult,
  PullResult,
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
  AccessibleCompartment,
  ListAccessibleCompartmentsOptions,
  QueryAcrossOptions,
  QueryAcrossResult,
  SessionPolicy,
  ReAuthOperation,
} from './types.js'

export {
  NOYDB_FORMAT_VERSION,
  NOYDB_KEYRING_VERSION,
  NOYDB_BACKUP_VERSION,
  NOYDB_SYNC_VERSION,
  defineAdapter,
} from './types.js'

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
  AdapterCapabilityError,
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
export { Compartment } from './compartment.js'
export { Collection } from './collection.js'
export type { CacheOptions, CacheStats } from './collection.js'
export { SyncEngine } from './sync.js'

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

// Crypto utilities (buffer encoding helpers)
export { bufferToBase64, base64ToBuffer } from './crypto.js'

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
