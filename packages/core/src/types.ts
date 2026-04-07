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
  /** User who created this version (unencrypted metadata). */
  readonly _by?: string
}

// ─── Compartment Snapshot ──────────────────────────────────────────────

/** All records across all collections for a compartment. */
export type CompartmentSnapshot = Record<string, Record<string, EncryptedEnvelope>>

/**
 * Result of a single page fetch via the optional `listPage` adapter extension.
 *
 * `items` carries the actual encrypted envelopes (not just ids) so the
 * caller can decrypt and emit a single record without an extra `get()`
 * round-trip per id. `nextCursor` is `null` on the final page.
 */
export interface ListPageResult {
  /** Encrypted envelopes for this page, in adapter-defined order. */
  items: Array<{ id: string; envelope: EncryptedEnvelope }>
  /** Opaque cursor for the next page, or `null` if this was the last page. */
  nextCursor: string | null
}

// ─── Adapter Interface ─────────────────────────────────────────────────

export interface NoydbAdapter {
  /**
   * Optional human-readable adapter name (e.g. 'memory', 'file', 'dynamo').
   * Used in diagnostic messages and the listPage fallback warning. Adapters
   * are encouraged to set this so logs are clearer about which backend is
   * involved when something goes wrong.
   */
  name?: string

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

  /**
   * Optional pagination extension. Adapters that implement `listPage` get
   * the streaming `Collection.scan()` fast path; adapters that don't are
   * silently fallen back to a full `loadAll()` + slice (with a one-time
   * console.warn).
   *
   * `cursor` is opaque to the core — each adapter encodes its own paging
   * state (DynamoDB: base64 LastEvaluatedKey JSON; S3: ContinuationToken;
   * memory/file/browser: numeric offset of a sorted id list). Pass
   * `undefined` to start from the beginning.
   *
   * `limit` is a soft upper bound on `items.length`. Adapters MAY return
   * fewer items even when more exist (e.g. if the underlying store has
   * its own page size cap), and MUST signal "no more pages" by returning
   * `nextCursor: null`.
   *
   * The 6-method core contract is unchanged — this is an additive
   * extension discovered via `'listPage' in adapter`.
   */
  listPage?(
    compartment: string,
    collection: string,
    cursor?: string,
    limit?: number,
  ): Promise<ListPageResult>
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
  /**
   * Internal collections (`_ledger`, `_ledger_deltas`, `_history`, `_sync`, …)
   * captured alongside the data collections. Optional for backwards
   * compat with v0.3 backups, which only stored data collections —
   * loading a v0.3 backup leaves the ledger empty (and `verifyBackupIntegrity`
   * skips the chain check, surfacing only a console warning).
   */
  readonly _internal?: CompartmentSnapshot
  /**
   * Verifiable-backup metadata (v0.4 #46). Embeds the ledger head at
   * dump time so `load()` can cross-check that the loaded chain matches
   * exactly what was exported. A backup whose chain has been tampered
   * with — either by modifying ledger entries or by modifying data
   * envelopes that the chain references — fails this check.
   *
   * Optional for backwards compat with v0.3 backups; missing means
   * "legacy backup, load with a warning, no integrity check".
   */
  readonly ledgerHead?: {
    /** Hex sha256 of the canonical JSON of the last ledger entry. */
    readonly hash: string
    /** Sequential index of the last ledger entry. */
    readonly index: number
    /** ISO timestamp captured at dump time. */
    readonly ts: string
  }
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
  'history:save': { compartment: string; collection: string; id: string; version: number }
  'history:prune': { compartment: string; collection: string; id: string; pruned: number }
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
  /** Session timeout in ms. Clears keys after inactivity. Default: none. */
  readonly sessionTimeout?: number
  /** Validate passphrase strength on creation. Default: true. */
  readonly validatePassphrase?: boolean
  /** Audit history configuration. */
  readonly history?: HistoryConfig
}

// ─── History / Audit Trail ─────────────────────────────────────────────

/** History configuration. */
export interface HistoryConfig {
  /** Enable history tracking. Default: true. */
  readonly enabled?: boolean
  /** Maximum history entries per record. Oldest pruned on overflow. Default: unlimited. */
  readonly maxVersions?: number
}

/** Options for querying history. */
export interface HistoryOptions {
  /** Start date (inclusive), ISO 8601. */
  readonly from?: string
  /** End date (inclusive), ISO 8601. */
  readonly to?: string
  /** Maximum entries to return. */
  readonly limit?: number
}

/** Options for pruning history. */
export interface PruneOptions {
  /** Keep only the N most recent versions. */
  readonly keepVersions?: number
  /** Delete versions older than this date, ISO 8601. */
  readonly beforeDate?: string
}

/** A decrypted history entry. */
export interface HistoryEntry<T> {
  readonly version: number
  readonly timestamp: string
  readonly userId: string
  readonly record: T
}
