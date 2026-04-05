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
