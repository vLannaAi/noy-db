/** Format version for encrypted record envelopes. */
export const NOYDB_FORMAT_VERSION = 1 as const

/** Format version for keyring files. */
export const NOYDB_KEYRING_VERSION = 1 as const

/** Format version for backup files. */
export const NOYDB_BACKUP_VERSION = 1 as const

/** Format version for sync metadata. */
export const NOYDB_SYNC_VERSION = 1 as const

// ─── Roles & Permissions ───────────────────────────────────────────────

export type Role = 'owner' | 'admin' | 'operator' | 'viewer' | 'client'

export type Permission = 'rw' | 'ro'

export type Permissions = Record<string, Permission>

// ─── Encrypted Envelope ────────────────────────────────────────────────

/** The encrypted wrapper stored by adapters. Adapters only ever see this. */
export interface EncryptedEnvelope {
  readonly _noydb: typeof NOYDB_FORMAT_VERSION
  readonly _v: number
  readonly _ts: string
  readonly _iv: string
  readonly _data: string
}

// ─── Compartment Snapshot ──────────────────────────────────────────────

/** All records across all collections for a compartment. */
export type CompartmentSnapshot = Record<string, Record<string, EncryptedEnvelope>>

// ─── Adapter Interface ─────────────────────────────────────────────────

export interface NoydbAdapter {
  /** Get a single record. Returns null if not found. */
  get(compartment: string, collection: string, id: string): Promise<EncryptedEnvelope | null>

  /** Put a record. Throws ConflictError if expectedVersion doesn't match. */
  put(
    compartment: string,
    collection: string,
    id: string,
    envelope: EncryptedEnvelope,
    expectedVersion?: number,
  ): Promise<void>

  /** Delete a record. */
  delete(compartment: string, collection: string, id: string): Promise<void>

  /** List all record IDs in a collection. */
  list(compartment: string, collection: string): Promise<string[]>

  /** Load all records for a compartment (initial hydration). */
  loadAll(compartment: string): Promise<CompartmentSnapshot>

  /** Save all records for a compartment (bulk write / restore). */
  saveAll(compartment: string, data: CompartmentSnapshot): Promise<void>

  /** Optional connectivity check for sync engine. */
  ping?(): Promise<boolean>
}

// ─── Adapter Factory Helper ────────────────────────────────────────────

/** Type-safe helper for creating adapter factories. */
export function defineAdapter<TOptions>(
  factory: (options: TOptions) => NoydbAdapter,
): (options: TOptions) => NoydbAdapter {
  return factory
}

// ─── Keyring ───────────────────────────────────────────────────────────

export interface KeyringFile {
  readonly _noydb_keyring: typeof NOYDB_KEYRING_VERSION
  readonly user_id: string
  readonly display_name: string
  readonly role: Role
  readonly permissions: Permissions
  readonly deks: Record<string, string>
  readonly salt: string
  readonly created_at: string
  readonly granted_by: string
}

// ─── Backup ────────────────────────────────────────────────────────────

export interface CompartmentBackup {
  readonly _noydb_backup: typeof NOYDB_BACKUP_VERSION
  readonly _compartment: string
  readonly _exported_at: string
  readonly _exported_by: string
  readonly keyrings: Record<string, KeyringFile>
  readonly collections: CompartmentSnapshot
}

// ─── Sync ──────────────────────────────────────────────────────────────

export interface DirtyEntry {
  readonly compartment: string
  readonly collection: string
  readonly id: string
  readonly action: 'put' | 'delete'
  readonly version: number
  readonly timestamp: string
}

export interface SyncMetadata {
  readonly _noydb_sync: typeof NOYDB_SYNC_VERSION
  readonly last_push: string | null
  readonly last_pull: string | null
  readonly dirty: DirtyEntry[]
}

export interface Conflict {
  readonly compartment: string
  readonly collection: string
  readonly id: string
  readonly local: EncryptedEnvelope
  readonly remote: EncryptedEnvelope
  readonly localVersion: number
  readonly remoteVersion: number
}

export type ConflictStrategy =
  | 'local-wins'
  | 'remote-wins'
  | 'version'
  | ((conflict: Conflict) => 'local' | 'remote')

export interface PushResult {
  readonly pushed: number
  readonly conflicts: Conflict[]
  readonly errors: Error[]
}

export interface PullResult {
  readonly pulled: number
  readonly conflicts: Conflict[]
  readonly errors: Error[]
}

export interface SyncStatus {
  readonly dirty: number
  readonly lastPush: string | null
  readonly lastPull: string | null
  readonly online: boolean
}

// ─── Events ────────────────────────────────────────────────────────────

export interface ChangeEvent {
  readonly compartment: string
  readonly collection: string
  readonly id: string
  readonly action: 'put' | 'delete'
}

export interface NoydbEventMap {
  'change': ChangeEvent
  'error': Error
  'sync:push': PushResult
  'sync:pull': PullResult
  'sync:conflict': Conflict
  'sync:online': void
  'sync:offline': void
}

// ─── Grant / Revoke ────────────────────────────────────────────────────

export interface GrantOptions {
  readonly userId: string
  readonly displayName: string
  readonly role: Role
  readonly passphrase: string
  readonly permissions?: Permissions
}

export interface RevokeOptions {
  readonly userId: string
  readonly rotateKeys?: boolean
}

// ─── User Info ─────────────────────────────────────────────────────────

export interface UserInfo {
  readonly userId: string
  readonly displayName: string
  readonly role: Role
  readonly permissions: Permissions
  readonly createdAt: string
  readonly grantedBy: string
}

// ─── Factory Options ───────────────────────────────────────────────────

export interface NoydbOptions {
  /** Primary adapter (local storage). */
  readonly adapter: NoydbAdapter
  /** Optional remote adapter for sync. */
  readonly sync?: NoydbAdapter
  /** User identifier. */
  readonly user: string
  /** Passphrase for key derivation. Required unless encrypt is false. */
  readonly secret?: string
  /** Auth method. Default: 'passphrase'. */
  readonly auth?: 'passphrase' | 'biometric'
  /** Enable encryption. Default: true. */
  readonly encrypt?: boolean
  /** Conflict resolution strategy. Default: 'version'. */
  readonly conflict?: ConflictStrategy
  /** Auto-sync on online/offline events. Default: false. */
  readonly autoSync?: boolean
  /** Periodic sync interval in ms. Default: 30000. */
  readonly syncInterval?: number
}
