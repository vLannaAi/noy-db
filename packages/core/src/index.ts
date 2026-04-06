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
  ConflictError,
  NetworkError,
  NotFoundError,
  ValidationError,
} from './errors.js'

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
} from './query/index.js'
