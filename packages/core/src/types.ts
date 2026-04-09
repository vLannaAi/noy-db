import type { StandardSchemaV1 } from './schema.js'

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

  /**
   * Optional cross-compartment enumeration extension (v0.5 #63).
   *
   * Returns the names of every top-level compartment the adapter
   * currently stores. Used by `Noydb.listAccessibleCompartments()` to
   * enumerate the universe of compartments before filtering down to
   * the ones the calling principal can actually unwrap.
   *
   * **Why this is optional:** the storage shape of compartments
   * differs across backends. Memory and file adapters store
   * compartments as top-level keys / directories and can enumerate
   * them in O(1) calls. DynamoDB stores everything in a single table
   * keyed by `(compartment#collection, id)` — enumerating compartments
   * requires either a Scan (expensive, eventually consistent, leaks
   * ciphertext metadata) or a dedicated GSI that the consumer
   * provisioned. S3 needs a prefix list (cheap if enabled, ACL-sensitive
   * otherwise). Browser localStorage can scan keys by prefix.
   *
   * Adapters that cannot implement `listCompartments` cheaply or
   * cleanly should omit it. Core surfaces an `AdapterCapabilityError`
   * with a clear message when a caller invokes
   * `listAccessibleCompartments()` against an adapter that doesn't
   * provide this method, so consumers know to either upgrade their
   * adapter, provide a candidate list explicitly to `queryAcross()`,
   * or fall back to maintaining the compartment index out of band.
   *
   * **Privacy note:** `listCompartments` returns *every* compartment
   * the adapter has, not just the ones the caller can access. The
   * existence-leak filtering (returning only compartments whose
   * keyring the caller can unwrap) happens in core, not in the
   * adapter. The adapter is trusted to know its own contents — that
   * is not a leak in the threat model. The leak the API guards
   * against is the *return value* of `listAccessibleCompartments()`
   * exposing existence to a downstream observer who only sees that
   * function's output.
   *
   * The 6-method core contract is unchanged — this is an additive
   * extension discovered via `'listCompartments' in adapter`.
   */
  listCompartments?(): Promise<string[]>
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

// ─── Export ────────────────────────────────────────────────────────────

/**
 * Options for `Compartment.exportStream()` and `Compartment.exportJSON()`.
 *
 * The defaults match the most common consumer pattern: one chunk per
 * collection, no ledger metadata. Per-record streaming and ledger-head
 * inclusion are opt-in because both add structure most consumers don't
 * need.
 */
export interface ExportStreamOptions {
  /**
   * `'collection'` (default) yields one chunk per collection with all
   * records bundled in `chunk.records`. `'record'` yields one chunk per
   * record, useful for arbitrarily large collections that should never
   * be materialized as a single array.
   */
  readonly granularity?: 'collection' | 'record'

  /**
   * When `true`, every chunk includes the current compartment ledger
   * head under `chunk.ledgerHead`. The value is identical across every
   * chunk in a single export (one ledger per compartment). Forward-
   * compatible with future partition work where the head would become
   * per-partition. Default: `false`.
   */
  readonly withLedgerHead?: boolean
}

/**
 * One chunk yielded by `Compartment.exportStream()`.
 *
 * `granularity: 'collection'` yields one chunk per collection with the
 * full record array in `records`. `granularity: 'record'` yields one
 * chunk per record with `records` containing exactly one element — the
 * `schema` and `refs` metadata is repeated on every chunk so consumers
 * doing per-record streaming don't have to thread state across yields.
 */
export interface ExportChunk<T = unknown> {
  /** Collection name (no leading underscore — internal collections are filtered out). */
  readonly collection: string

  /**
   * Standard Schema validator attached to the collection at `collection()`
   * construction time, or `null` if no schema was provided. Surfaced so
   * downstream serializers (`@noy-db/decrypt-*` packages, custom
   * exporters) can produce schema-aware output (typed CSV headers, XSD
   * generation, etc.) without poking at collection internals.
   */
  readonly schema: StandardSchemaV1<unknown, T> | null

  /**
   * Foreign-key references declared on the collection via the `refs`
   * option, as the `{ field → { target, mode } }` map produced by
   * `RefRegistry.getOutbound`. Empty object when no refs were declared.
   */
  readonly refs: Record<string, { readonly target: string; readonly mode: 'strict' | 'warn' | 'cascade' }>

  /**
   * Decrypted, ACL-scoped, schema-validated records. Length 1 in
   * `granularity: 'record'` mode, full collection in `granularity: 'collection'`
   * mode. Records are returned by reference from the collection's eager
   * cache where applicable — consumers must treat them as immutable.
   */
  readonly records: T[]

  /**
   * Compartment ledger head at export time. Present only when
   * `exportStream({ withLedgerHead: true })` was called. Identical
   * across every chunk in the same export — included on every chunk
   * for forward-compatibility with future per-partition ledgers, where
   * the value will differ per chunk.
   */
  readonly ledgerHead?: {
    readonly hash: string
    readonly index: number
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

  /**
   * Cascade behavior when the revoked user is an admin who has granted
   * other admins (v0.5 #62 admin-delegation work).
   *
   * - `'strict'` (default) — recursively revoke every admin that the
   *   target (transitively) granted. The cascade walks the
   *   `granted_by` field on each keyring file and stops at non-admin
   *   leaves. All affected collections are accumulated and rotated in
   *   a single pass at the end, so cascade cost is O(records in
   *   affected collections), not O(records × cascade depth).
   *
   * - `'warn'` — leave the descendant admins in place but emit a
   *   `console.warn` listing them. Useful for diagnostic dry runs and
   *   for environments where the operator wants to clean up the
   *   delegation tree manually.
   *
   * No effect when the target is not an admin (operators, viewers, and
   * clients cannot grant other users, so they have no delegation
   * subtree to cascade through). Defaults to `'strict'`.
   */
  readonly cascade?: 'strict' | 'warn'
}

// ─── Cross-compartment queries (v0.5 #63) ──────────────────────────────

/**
 * One entry returned by `Noydb.listAccessibleCompartments()`. Carries
 * the compartment id and the role the calling principal holds in it,
 * so the consumer can decide how to fan out without re-checking
 * permissions per compartment.
 */
export interface AccessibleCompartment {
  readonly id: string
  readonly role: Role
}

/**
 * Options for `Noydb.listAccessibleCompartments()`.
 */
export interface ListAccessibleCompartmentsOptions {
  /**
   * Minimum role the caller must hold to include a compartment in the
   * result. Compartments where the caller's role is strictly *below*
   * this threshold are silently excluded. Defaults to `'client'`,
   * which means "every compartment I can unwrap is returned." Set to
   * `'admin'` for "compartments where I can grant/revoke," or
   * `'owner'` for "compartments I own."
   *
   * The privilege ordering used:
   *   `client (1) < viewer (2) < operator (3) < admin (4) < owner (5)`
   *
   * Note: `viewer` and `client` are conceptually peers in the v0.4 ACL
   * (neither can grant), but `viewer` has read-all access while
   * `client` has only explicit-collection read. The numeric order
   * reflects "how much can this principal see," not "how much can
   * this principal modify."
   */
  readonly minRole?: Role
}

/**
 * Options for `Noydb.queryAcross()`.
 */
export interface QueryAcrossOptions {
  /**
   * Maximum number of compartments to process in parallel. Defaults
   * to `1` (sequential) — conservative because the per-compartment
   * callback typically does its own I/O and an unbounded fan-out can
   * exhaust adapter connections (DynamoDB throughput, S3 socket
   * limits, browser fetch concurrency).
   *
   * Set to `4` or `8` for cloud-backed compartments where parallelism
   * is the whole point of fanning out. Set to `1` (default) for local
   * adapters where the disk I/O serializes anyway.
   */
  readonly concurrency?: number
}

/**
 * One entry in the array returned by `Noydb.queryAcross()`. Either
 * `result` is set (callback succeeded for this compartment) or
 * `error` is set (callback threw, or compartment failed to open).
 *
 * Per-compartment errors do **not** abort the overall fan-out — every
 * compartment is given a chance to run its callback, and the
 * partition between success and failure is exposed in the return
 * value. Consumers that want fail-fast semantics can check
 * `r.error !== undefined` and short-circuit themselves.
 */
export type QueryAcrossResult<T> =
  | { readonly compartment: string; readonly result: T; readonly error?: undefined }
  | { readonly compartment: string; readonly result?: undefined; readonly error: Error }

// ─── User Info ─────────────────────────────────────────────────────────

export interface UserInfo {
  readonly userId: string
  readonly displayName: string
  readonly role: Role
  readonly permissions: Permissions
  readonly createdAt: string
  readonly grantedBy: string
}

// ─── Session (v0.7 #109) ───────────────────────────────────────────────

/**
 * Operations that a session policy can require re-authentication for.
 * Passed as the `requireReAuthFor` array in `SessionPolicy`.
 */
export type ReAuthOperation = 'export' | 'grant' | 'revoke' | 'rotate' | 'changeSecret'

/**
 * Session policy controlling lifetime, re-auth requirements, and
 * background-lock behavior (v0.7 #114).
 *
 * All timeout values are in milliseconds. `undefined` means "no limit."
 * The policy is evaluated lazily — it does not start timers itself;
 * enforcement happens at the Noydb call site.
 */
export interface SessionPolicy {
  /**
   * Idle timeout in ms. If no NOYDB operation is performed for this
   * duration, the session is revoked on the next operation attempt
   * (which will throw `SessionExpiredError`). The idle clock resets
   * on every successful operation.
   *
   * Default: `undefined` (no idle timeout).
   */
  readonly idleTimeoutMs?: number

  /**
   * Absolute timeout in ms from session creation. After this duration
   * the session is unconditionally revoked regardless of activity.
   *
   * Default: `undefined` (no absolute timeout).
   */
  readonly absoluteTimeoutMs?: number

  /**
   * Operations that require the user to re-authenticate (re-enter their
   * passphrase or perform a fresh WebAuthn assertion) before proceeding,
   * even if the session is still alive.
   *
   * Common pattern: `requireReAuthFor: ['export', 'grant']` — allow
   * read/write operations in the background but demand a fresh credential
   * for high-risk mutations.
   *
   * Default: `[]` (no extra re-auth requirements).
   */
  readonly requireReAuthFor?: readonly ReAuthOperation[]

  /**
   * If `true`, the session is revoked when the page goes to the background
   * (visibilitychange event, `document.hidden === true`). Useful for
   * high-sensitivity deployments where leaving the tab is treated as
   * a session boundary.
   *
   * No-op in non-browser environments (Node.js, workers without document).
   * Default: `false`.
   */
  readonly lockOnBackground?: boolean
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
  /**
   * Session timeout in ms. Clears keys after inactivity. Default: none.
   * @deprecated Use `sessionPolicy.idleTimeoutMs` instead. This field is
   * still honored for backwards compatibility but `sessionPolicy` takes
   * precedence when both are supplied.
   */
  readonly sessionTimeout?: number
  /**
   * Session policy controlling lifetime, re-auth requirements, and
   * background-lock behavior (v0.7 #114). When supplied, replaces the
   * legacy `sessionTimeout` field.
   */
  readonly sessionPolicy?: SessionPolicy
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
