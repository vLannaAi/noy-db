/**
 * Core types — the {@link NoydbStore} interface, envelope format, roles, and
 * all configuration shapes consumed by {@link createNoydb}.
 *
 * ## What lives here
 *
 * - **{@link NoydbStore}** — the 6-method contract every backend must implement
 *   (`get`, `put`, `delete`, `list`, `loadAll`, `saveAll`).
 * - **{@link EncryptedEnvelope}** — the wire format stored by backends:
 *   `{ _noydb, _v, _ts, _iv, _data }`. Backends only ever see this shape.
 * - **{@link Role} / {@link Permission}** — the access-control vocabulary
 *   (`owner`, `admin`, `operator`, `viewer`, `client`).
 * - **{@link NoydbOptions}** — the full configuration object passed to
 *   {@link createNoydb}.
 *
 * ## Extending the store interface
 *
 * All optional store capabilities (`ping`, `listPage`, `listSince`,
 * `presencePublish`, `presenceSubscribe`, `listVaults`) are additive extensions
 * discovered via `'method' in store`. Implementing them unlocks features but
 * is never required — core always falls back to the 6-method baseline.
 *
 * @module
 */

import type { StandardSchemaV1 } from './schema.js'
import type { SyncPolicy } from './store/sync-policy.js'

/** Format version for encrypted record envelopes. */
export const NOYDB_FORMAT_VERSION = 1 as const

/** Format version for keyring files. */
export const NOYDB_KEYRING_VERSION = 1 as const

/** Format version for backup files. */
export const NOYDB_BACKUP_VERSION = 1 as const

/** Format version for sync metadata. */
export const NOYDB_SYNC_VERSION = 1 as const

// ─── Roles & Permissions ───────────────────────────────────────────────

/**
 * Access role assigned to a user within a vault.
 *
 * Roles control both the operations a user can perform and which DEKs
 * they receive in their keyring:
 *
 * | Role       | Collections      | Can grant/revoke | Can export |
 * |------------|-----------------|:----------------:|:----------:|
 * | `owner`    | all (rw)        | Yes (all roles)  | Yes        |
 * | `admin`    | all (rw)        | Yes (≤ admin)    | Yes        |
 * | `operator` | explicit (rw)   | No               | ACL-scoped |
 * | `viewer`   | all (ro)        | No               | Yes        |
 * | `client`   | explicit (ro)   | No               | ACL-scoped |
 */
export type Role = 'owner' | 'admin' | 'operator' | 'viewer' | 'client'

/**
 * Read-write or read-only access on a collection.
 * Stored per-collection in the user's keyring.
 */
export type Permission = 'rw' | 'ro'

/**
 * Map of collection name → permission level for a user's keyring entry.
 * `'*'` is the wildcard collection matching all collections in the vault.
 */
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
  /**
   * Hierarchical access tier (v0.18 #205). Omitted → tier 0.
   *
   * Unencrypted on purpose — the store reads it to route the envelope
   * to the right DEK slot without having to try-decrypt against every
   * tier. Only leaks the tier of each record, not any value
   * equivalence.
   */
  readonly _tier?: number
  /**
   * User id who last elevated this record (v0.18 #206). Used by
   * `demote()` to gate the reverse operation: only the original
   * elevator or an owner can demote a record back down. Cleared on
   * every successful demote so a later re-elevate requires the new
   * actor to own the demotion right.
   */
  readonly _elevatedBy?: string
  /**
   * Deterministic-encryption index (v0.19 #219). Map of field name →
   * base64 deterministic ciphertext. Present only when the collection
   * declares `deterministicFields` and the feature is acknowledged. The
   * field names are unencrypted (they're the index keys); the values
   * are AES-GCM ciphertext with an HKDF-derived deterministic IV.
   *
   * Enables blind equality search (`collection.findByDet(field,
   * value)`) without decrypting every record. Leaks equality as a known
   * side channel.
   */
  readonly _det?: Record<string, string>
}

/**
 * Placeholder returned by `getAtTier()` in `'ghost'` mode when a
 * record is at a tier the caller cannot decrypt. Record existence is
 * advertised — the id and tier are visible — but contents are
 * withheld. `canElevateFrom` lists user ids authorized to elevate
 * access for this caller when known; absent when the workflow is
 * not configured.
 */
export interface GhostRecord {
  readonly _ghost: true
  readonly _tier: number
  readonly canElevateFrom?: readonly string[]
}

/** Control what lower-tier reads see above their clearance (v0.18 #207 #208). */
export type TierMode = 'invisibility' | 'ghost'

/**
 * Event emitted when a record at a tier above the caller's inherent
 * clearance is read or written successfully (via elevation or
 * delegation). Always written to the ledger; subscribers get a
 * real-time feed.
 */
export interface CrossTierAccessEvent {
  readonly actor: string
  readonly collection: string
  readonly id: string
  readonly tier: number
  /** How the caller gained tier access: they elevated it, or a delegation is active. */
  readonly authorization: 'elevation' | 'delegation' | 'inherent'
  readonly op: 'get' | 'put' | 'elevate' | 'demote'
  readonly ts: string
}

/**
 * A single deterministic-ciphertext index slot on an envelope. Stored
 * as `iv:data` (both base64, colon-separated) so a single string per
 * field keeps the envelope compact.
 */
export type DeterministicCipher = string

// ─── Vault Snapshot ──────────────────────────────────────────────

/** All records across all collections for a compartment. */
export type VaultSnapshot = Record<string, Record<string, EncryptedEnvelope>>

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

// ─── Store Interface ───────────────────────────────────────────────────

export interface NoydbStore {
  /**
   * Optional human-readable adapter name (e.g. 'memory', 'file', 'dynamo').
   * Used in diagnostic messages and the listPage fallback warning. Adapters
   * are encouraged to set this so logs are clearer about which backend is
   * involved when something goes wrong.
   */
  name?: string

  /** Get a single record. Returns null if not found. */
  get(vault: string, collection: string, id: string): Promise<EncryptedEnvelope | null>

  /** Put a record. Throws ConflictError if expectedVersion doesn't match. */
  put(
    vault: string,
    collection: string,
    id: string,
    envelope: EncryptedEnvelope,
    expectedVersion?: number,
  ): Promise<void>

  /** Delete a record. */
  delete(vault: string, collection: string, id: string): Promise<void>

  /** List all record IDs in a collection. */
  list(vault: string, collection: string): Promise<string[]>

  /** Load all records for a vault (initial hydration). */
  loadAll(vault: string): Promise<VaultSnapshot>

  /** Save all records for a vault (bulk write / restore). */
  saveAll(vault: string, data: VaultSnapshot): Promise<void>

  /** Optional connectivity check for sync engine. */
  ping?(): Promise<boolean>

  /**
   * Optional: list record IDs in a collection that have `_ts` after `since`.
   * Used by partial sync (`pull({ modifiedSince })`). Adapters that omit this
   * fall back to a full `loadAll` + client-side timestamp filter.
   */
  listSince?(vault: string, collection: string, since: string): Promise<string[]>

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
    vault: string,
    collection: string,
    cursor?: string,
    limit?: number,
  ): Promise<ListPageResult>

  /**
   * Optional pub/sub for real-time presence (v0.9 #134).
   * Publish an encrypted payload to a presence channel.
   * Falls back to storage-based polling when absent.
   */
  presencePublish?(channel: string, payload: string): Promise<void>

  /**
   * Optional pub/sub for real-time presence (v0.9 #134).
   * Subscribe to a presence channel. Returns an unsubscribe function.
   * Falls back to storage-based polling when absent.
   */
  presenceSubscribe?(channel: string, callback: (payload: string) => void): () => void

  /**
   * Optional cross-vault enumeration extension (v0.5 #63).
   *
   * Returns the names of every top-level vault the store
   * currently stores. Used by `Noydb.listAccessibleVaults()` to
   * enumerate the universe of vaults before filtering down to
   * the ones the calling principal can actually unwrap.
   *
   * **Why this is optional:** the storage shape of compartments
   * differs across backends. Memory and file stores store
   * vaults as top-level keys / directories and can enumerate
   * them in O(1) calls. DynamoDB stores everything in a single table
   * keyed by `(compartment#collection, id)` — enumerating compartments
   * requires either a Scan (expensive, eventually consistent, leaks
   * ciphertext metadata) or a dedicated GSI that the consumer
   * provisioned. S3 needs a prefix list (cheap if enabled, ACL-sensitive
   * otherwise). Browser localStorage can scan keys by prefix.
   *
   * Stores that cannot implement `listVaults` cheaply or
   * cleanly should omit it. Core surfaces a `StoreCapabilityError`
   * with a clear message when a caller invokes
   * `listAccessibleVaults()` against a store that doesn't
   * provide this method, so consumers know to either upgrade their
   * store, provide a candidate list explicitly to `queryAcross()`,
   * or fall back to maintaining the compartment index out of band.
   *
   * **Privacy note:** `listVaults` returns *every* compartment
   * the store has, not just the ones the caller can access. The
   * existence-leak filtering (returning only compartments whose
   * keyring the caller can unwrap) happens in core, not in the
   * store. The store is trusted to know its own contents — that
   * is not a leak in the threat model. The leak the API guards
   * against is the *return value* of `listAccessibleVaults()`
   * exposing existence to a downstream observer who only sees that
   * function's output.
   *
   * The 6-method core contract is unchanged — this is an additive
   * extension discovered via `'listVaults' in store`.
   */
  listVaults?(): Promise<string[]>

  /**
   * Optional: generate a presigned URL for direct client download (v0.12 #164 E5).
   * Only meaningful for object stores (S3, GCS) that support URL signing.
   * Returns a time-limited URL that fetches the encrypted envelope directly.
   * The caller must decrypt client-side (the URL returns ciphertext).
   */
  presignUrl?(vault: string, collection: string, id: string, expiresInSeconds?: number): Promise<string>

  /**
   * Optional: estimate current storage usage (v0.12 #164 E8).
   * Returns `{ usedBytes, quotaBytes }` or null if the store cannot estimate.
   * Used by quota-aware routing to detect overflow conditions.
   */
  estimateUsage?(): Promise<{ usedBytes: number; quotaBytes: number } | null>

  /**
   * Optional multi-record atomic write (v0.16 #240).
   *
   * When present, `db.transaction(async (tx) => { ... })` uses this to
   * commit every staged op in one storage-layer transaction — either
   * all ops land or none do, regardless of which records they touch.
   * Every `TxOp.expectedVersion` (when set) must be honored atomically
   * alongside the write; any violation throws `ConflictError` and the
   * whole batch fails.
   *
   * Stores that omit this fall through to the hub's per-record OCC
   * fallback: pre-flight CAS check, then sequential `put`/`delete`
   * with best-effort unwind on mid-batch failure (see
   * `runTransaction` for the exact semantics and crash window).
   *
   * Native implementations: `to-memory` (single Map mutation),
   * `to-dynamo` (`TransactWriteItems`), `to-browser-idb` (one
   * `readwrite` transaction). File / S3 cannot implement this
   * atomically and should omit the method.
   */
  tx?(ops: readonly TxOp[]): Promise<void>
}

/**
 * A single staged operation inside a `db.transaction(fn)` commit. The
 * hub assembles `TxOp[]` from the user's `tx.collection().put/delete`
 * calls, encrypts any `record` values into `envelope`, and hands the
 * array to `NoydbStore.tx()` when the store supports atomic batch
 * writes. Stores that implement `tx()` MUST honor every
 * `expectedVersion` atomically against the stored envelope version.
 */
export interface TxOp {
  readonly type: 'put' | 'delete'
  readonly vault: string
  readonly collection: string
  readonly id: string
  /** Populated for `type: 'put'` — the encrypted envelope to write. */
  readonly envelope?: EncryptedEnvelope
  /** Optional per-record CAS. Mismatch must throw `ConflictError`. */
  readonly expectedVersion?: number
}

// ─── Store Factory Helper ──────────────────────────────────────────────

/** Type-safe helper for creating store factories. */
export function createStore<TOptions>(
  factory: (options: TOptions) => NoydbStore,
): (options: TOptions) => NoydbStore {
  return factory
}

// ─── Keyring ───────────────────────────────────────────────────────────

/**
 * Interchange formats `@noy-db/as-*` packages can produce. `'*'` is a
 * wildcard granting every current + future plaintext format.
 */
export type ExportFormat =
  | 'xlsx'
  | 'csv'
  | 'json'
  | 'ndjson'
  | 'xml'
  | 'sql'
  | 'pdf'
  | 'blob'
  | 'zip'
  | '*'

/**
 * Owner-granted export capability on a keyring (RFC #249).
 *
 * Two independent dimensions:
 *
 * - `plaintext` — per-format allowlist for record formatters + blob
 *   extractors that emit plaintext bytes (`as-xlsx`, `as-csv`,
 *   `as-blob`, `as-zip`, …). **Defaults to empty** for every role;
 *   the owner/admin must positively grant per-format (or `'*'`).
 * - `bundle` — boolean for `.noydb` encrypted container export
 *   (`as-noydb`). **Default policy: on for owner/admin, off for
 *   operator/viewer/client** — applied when the field is absent or
 *   undefined (see `hasExportCapability`).
 */
export interface ExportCapability {
  readonly plaintext?: readonly ExportFormat[]
  readonly bundle?: boolean
}

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
  /**
   * Optional — RFC #249 capability bits. Absent on keyrings written
   * before the RFC implementation. Loading falls back to role-based
   * defaults (owner/admin get bundle-on, everyone else off).
   */
  readonly export_capability?: ExportCapability
  /**
   * v0.18 #205 — hierarchical access clearance. Absent → 0 (advisory;
   * the real check is whether the DEK map carries a `collection#tier`
   * entry for the requested tier). Owners and admins default to the
   * highest tier they have DEKs for at grant time.
   */
  readonly clearance?: number
}

// ─── Backup ────────────────────────────────────────────────────────────

export interface VaultBackup {
  readonly _noydb_backup: typeof NOYDB_BACKUP_VERSION
  readonly _compartment: string
  readonly _exported_at: string
  readonly _exported_by: string
  readonly keyrings: Record<string, KeyringFile>
  readonly collections: VaultSnapshot
  /**
   * Internal collections (`_ledger`, `_ledger_deltas`, `_history`, `_sync`, …)
   * captured alongside the data collections. Optional for backwards
   * compat with v0.3 backups, which only stored data collections —
   * loading a v0.3 backup leaves the ledger empty (and `verifyBackupIntegrity`
   * skips the chain check, surfacing only a console warning).
   */
  readonly _internal?: VaultSnapshot
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
 * Options for `Vault.exportStream()` and `Vault.exportJSON()`.
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
  /**
   * When set to a BCP 47 locale string (e.g. `'th'`), `exportJSON()`
   * resolves all `dictKey` labels to that locale and omits the raw
   * `dictionaries` snapshot from the output (v0.8 #84). Has no effect
   * on `exportStream()` — format packages use the `chunk.dictionaries`
   * snapshot directly and apply their own locale strategy.
   *
   * Default: `undefined` — embed the raw snapshot under `_dictionaries`.
   */
  readonly resolveLabels?: string
}

/**
 * One chunk yielded by `Vault.exportStream()`.
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
   * downstream serializers (`@noy-db/as-*` packages, custom
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
   * Dictionary snapshots for every `dictKey` field declared on this
   * collection (v0.8 #84). Captured once at stream-start and held
   * constant across all chunks within the same export — a rename
   * mid-export does not change the snapshot. `undefined` when the
   * collection has no `dictKeyFields`.
   *
   * Shape: `{ [fieldName]: { [stableKey]: { [locale]: label } } }`
   *
   * @example
   * ```ts
   * chunk.dictionaries?.status?.paid?.th  // → 'ชำระแล้ว'
   * ```
   */
  readonly dictionaries?: Record<
    string, // field name
    Record<string, Record<string, string>> // stable key → locale → label
  >

  /**
   * Vault ledger head at export time. Present only when
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
  readonly vault: string
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
  readonly vault: string
  readonly collection: string
  readonly id: string
  readonly local: EncryptedEnvelope
  readonly remote: EncryptedEnvelope
  readonly localVersion: number
  readonly remoteVersion: number
  /**
   * Present only when the collection uses `conflictPolicy: 'manual'`.
   * Call `resolve(winner)` to commit the winning envelope, or
   * `resolve(null)` to defer (conflict stays queued for the next sync).
   * Called synchronously inside the `sync:conflict` event handler.
   */
  readonly resolve?: (winner: EncryptedEnvelope | null) => void
}

export type ConflictStrategy =
  | 'local-wins'
  | 'remote-wins'
  | 'version'
  | ((conflict: Conflict) => 'local' | 'remote')

/**
 * Collection-level conflict policy (v0.9 #131).
 * Overrides the db-level `conflict` option for the specific collection.
 *
 * - `'last-writer-wins'` — higher `_ts` wins (timestamp LWW).
 * - `'first-writer-wins'` — lower `_v` wins (earlier version is preserved).
 * - `'manual'` — emits `sync:conflict` with a `resolve` callback. Call
 *   `resolve(winner)` synchronously to commit or `resolve(null)` to defer.
 * - Custom fn — synchronous `(local: T, remote: T) => T`. Must be pure.
 */
export type ConflictPolicy<T> =
  | 'last-writer-wins'
  | 'first-writer-wins'
  | 'manual'
  | ((local: T, remote: T) => T)

/**
 * Envelope-level resolver registered per collection with the SyncEngine.
 * Receives the `id` of the conflicting record and both envelopes.
 * Returns the winning envelope, or `null` to defer resolution.
 * @internal
 */
export type CollectionConflictResolver = (
  id: string,
  local: EncryptedEnvelope,
  remote: EncryptedEnvelope,
) => Promise<EncryptedEnvelope | null>

/** Options for targeted push operations (v0.9 #133). */
export interface PushOptions {
  /** Only push records belonging to these collections. Omit to push all dirty. */
  collections?: string[]
}

/** Options for targeted pull operations (v0.9 #133). */
export interface PullOptions {
  /** Only pull these collections. Omit to pull all. */
  collections?: string[]
  /**
   * Only pull records with `_ts` strictly after this ISO timestamp.
   * Adapters that implement `listSince` use it directly; others fall back
   * to a full scan with client-side filtering.
   */
  modifiedSince?: string
}

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

/** Result of a sync transaction commit (v0.9 #135). */
export interface SyncTransactionResult {
  readonly status: 'committed' | 'conflict'
  readonly pushed: number
  readonly conflicts: Conflict[]
}

export interface SyncStatus {
  readonly dirty: number
  readonly lastPush: string | null
  readonly lastPull: string | null
  readonly online: boolean
}

// ─── Sync Target (v0.12 #158) ─────────────────────────────────────────

export type SyncTargetRole = 'sync-peer' | 'backup' | 'archive'

/**
 * A sync target with role and optional per-target policy (v0.12 #158).
 *
 * | Role        | Direction     | Conflict resolution | Typical use              |
 * |-------------|---------------|---------------------|--------------------------|
 * | `sync-peer` | Bidirectional | ConflictStrategy    | DynamoDB live sync       |
 * | `backup`    | Push-only     | N/A (receives merged)| S3 dump, Google Drive   |
 * | `archive`   | Push-only     | N/A                 | IPFS, Git tags, S3 Lock  |
 */
export interface SyncTarget {
  /** The store to sync with. */
  readonly store: NoydbStore
  /** Role determines sync direction and conflict handling. */
  readonly role: SyncTargetRole
  /** Per-target sync policy. Inherits store-category default when absent. */
  readonly policy?: SyncPolicy
  /** Human-readable label for DevTools and audit logs. */
  readonly label?: string
}

// ─── Events ────────────────────────────────────────────────────────────

export interface ChangeEvent {
  readonly vault: string
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
  'sync:backup-error': { vault: string; target: string; error: Error }
  'history:save': { vault: string; collection: string; id: string; version: number }
  'history:prune': { vault: string; collection: string; id: string; pruned: number }
  /**
   * Emitted when a persisted-index side-car put/delete fails after the
   * main record write already succeeded. The main record is durable; the
   * index mirror may have drifted. Operators reconcile via
   * `collection.reconcileIndex(field)` (v0.23 #269).
   */
  'index:write-partial': {
    vault: string
    collection: string
    id: string
    action: 'put' | 'delete'
    error: Error
  }
}

// ─── Grant / Revoke ────────────────────────────────────────────────────

export interface GrantOptions {
  readonly userId: string
  readonly displayName: string
  readonly role: Role
  readonly passphrase: string
  readonly permissions?: Permissions
  /**
   * Optional `@noy-db/as-*` export capability (RFC #249). Omit or
   * leave undefined to apply role-based defaults (see
   * `hasExportCapability` and `ExportCapability`).
   */
  readonly exportCapability?: ExportCapability
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

// ─── Cross-vault queries (v0.5 #63) ──────────────────────────────

/**
 * One entry returned by `Noydb.listAccessibleVaults()`. Carries
 * the compartment id and the role the calling principal holds in it,
 * so the consumer can decide how to fan out without re-checking
 * permissions per vault.
 */
export interface AccessibleVault {
  readonly id: string
  readonly role: Role
}

/**
 * Options for `Noydb.listAccessibleVaults()`.
 */
export interface ListAccessibleVaultsOptions {
  /**
   * Minimum role the caller must hold to include a compartment in the
   * result. Compartments where the caller's role is strictly *below*
   * this threshold are silently excluded. Defaults to `'client'`,
   * which means "every vault I can unwrap is returned." Set to
   * `'admin'` for "vaults where I can grant/revoke," or
   * `'owner'` for "vaults I own."
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
  | { readonly vault: string; readonly result: T; readonly error?: undefined }
  | { readonly vault: string; readonly result?: undefined; readonly error: Error }

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

// ─── i18n / Locale (v0.8 #81 #82) ─────────────────────────────────────

/**
 * Locale-aware read options. Pass to `Collection.get()`, `list()`,
 * `query()`, and `scan()` to trigger per-record locale resolution for
 * `dictKey` and `i18nText` fields.
 *
 * - **`locale: 'raw'`** — skip resolution for `i18nText` fields and
 *   return the full `{ [locale]: string }` map. Dict key fields still
 *   return the stable key (no `<field>Label` added).
 * - **`fallback`** — single locale code or ordered list. Use `'any'` as
 *   the last element to fall back to any present translation.
 *
 * When neither the call-level locale nor the compartment's default locale
 * is set, reading a record with `i18nText` fields throws
 * `LocaleNotSpecifiedError`.
 */
export interface LocaleReadOptions {
  /**
   * The target locale code (e.g. `'th'`), or `'raw'` to return the full
   * language map without resolution.
   */
  readonly locale?: string
  /**
   * Fallback locale or ordered fallback chain. Use `'any'` as the last
   * element to fall back to any present translation.
   */
  readonly fallback?: string | readonly string[]
}

// ─── plaintextTranslator hook (v0.8 #83) ──────────────────────────────

/**
 * Context passed to the consumer-supplied `plaintextTranslator` function.
 * The hook receives the source text plus enough metadata to route it to the
 * right translation service and record what it did.
 */
export interface PlaintextTranslatorContext {
  /** The plaintext string to translate. */
  readonly text: string
  /** BCP 47 source locale (the locale the text is written in). */
  readonly from: string
  /** BCP 47 target locale to translate into. */
  readonly to: string
  /** The schema field name that triggered the translation. */
  readonly field: string
  /** The collection the record is being put into. */
  readonly collection: string
}

/**
 * A consumer-supplied async function that translates a single string
 * from one locale to another. noy-db ships no built-in translator.
 *
 * **Security:** this function receives plaintext. The consumer is
 * responsible for the data policy of whatever service it calls. See
 * `NOYDB_SPEC.md § Zero-Knowledge Storage` and the `plaintextTranslator`
 * JSDoc on `NoydbOptions` for the full invariant statement.
 */
export type PlaintextTranslatorFn = (
  ctx: PlaintextTranslatorContext,
) => Promise<string>

/**
 * One entry in the in-process translator audit log. Cleared when
 * `db.close()` is called — same lifetime as the KEK and DEKs.
 *
 * Deliberately omits any content hash or translated-text fingerprint
 * to prevent correlation attacks on the audit trail.
 */
export interface TranslatorAuditEntry {
  readonly type: 'translator-invocation'
  /** Schema field name that was translated. */
  readonly field: string
  /** Collection the record belongs to. */
  readonly collection: string
  /** Source locale. */
  readonly fromLocale: string
  /** Target locale. */
  readonly toLocale: string
  /**
   * Consumer-provided translator name from
   * `NoydbOptions.plaintextTranslatorName`. Defaults to `'anonymous'`
   * when not supplied.
   */
  readonly translatorName: string
  /** ISO 8601 timestamp of the invocation. */
  readonly timestamp: string
  /**
   * `true` when the result was served from the in-process cache rather
   * than by calling the translator function. Present only on cache hits
   * so the absence of the field also communicates a cache miss.
   */
  readonly cached?: true
}

// ─── Presence (v0.9 #134) ─────────────────────────────────────────────

/**
 * A presence peer entry. `lastSeen` is an ISO timestamp set by core on each
 * `update()` call. Stale entries (lastSeen older than `staleMs`) are filtered
 * before delivering to the subscriber callback.
 */
export interface PresencePeer<P> {
  readonly userId: string
  readonly payload: P
  readonly lastSeen: string
}

// ─── CRDT (v0.9 #132) ─────────────────────────────────────────────────

// Re-exported from crdt.ts so consumers only need one import path.
export type { CrdtMode, CrdtState, LwwMapState, RgaState, YjsState } from './crdt.js'

// ─── Blob / Attachment Store (v0.12 #103 #105) ────────────────────────

/**
 * Second store shape for blob-store backends (Drive, WebDAV, Git, iCloud)
 * that operate on whole-vault bundles rather than per-record KV.
 *
 * Implement `readBundle` / `writeBundle` instead of the six-method KV
 * contract. Use `wrapBundleStore()` from `@noy-db/hub` to convert to a
 * `NoydbStore` that the rest of the API consumes transparently.
 *
 * Named `NoydbBundleStore` (not `NoydbBundleAdapter`) for consistency
 * with the v0.11 hub / to-* / in-* rename. Concrete implementations ship
 * in `@noy-db/to-*` packages starting in v0.13.
 */
export interface NoydbBundleStore {
  /** Discriminant for engine auto-detection of store shape. */
  readonly kind: 'bundle'
  /** Human-readable name for diagnostics (e.g. `'drive'`, `'webdav'`). */
  readonly name?: string
  /**
   * Read the entire vault as raw bytes. Returns `null` if no bundle exists
   * yet (first open of a brand-new vault).
   */
  readBundle(vaultId: string): Promise<{ bytes: Uint8Array; version: string } | null>
  /**
   * Write the entire vault as raw bytes. `expectedVersion` is the version
   * token from the last `readBundle` (or `null` for a first write).
   * Implementations MUST reject the write if the stored version has advanced
   * past `expectedVersion` — throw `BundleVersionConflictError`.
   * Returns the new version token on success.
   */
  writeBundle(
    vaultId: string,
    bytes: Uint8Array,
    expectedVersion: string | null,
  ): Promise<{ version: string }>
  /** Delete a vault bundle. Idempotent — no-op if the bundle does not exist. */
  deleteBundle(vaultId: string): Promise<void>
  /** List all vault bundles managed by this store. */
  listBundles(): Promise<Array<{ vaultId: string; version: string; size: number }>>
}

/**
 * Content-addressed blob object stored in the vault-level blob index.
 * Identified by HMAC-SHA-256(blobDEK, plaintext) — opaque to the store.
 *
 * Shared across all collections within a vault for deduplication: two
 * records that attach identical byte content reference the same `eTag`
 * and share a single set of encrypted chunks in `_blob_chunks`.
 */
export interface BlobObject {
  /** HMAC-SHA-256 hex of the original plaintext bytes, keyed by `_blob` DEK. */
  readonly eTag: string
  /** Original uncompressed size in bytes. */
  readonly size: number
  /** Compressed size in bytes (the payload that is actually encrypted and chunked). */
  readonly compressedSize: number
  /** Compression algorithm applied before encryption. */
  readonly compression: 'gzip' | 'none'
  /** Raw chunk size in bytes used at write time. Readers MUST use this value. */
  readonly chunkSize: number
  /** Total number of chunks written. Reader expects exactly this many. */
  readonly chunkCount: number
  /** MIME type if provided or auto-detected at upload time. */
  readonly mimeType?: string
  /** ISO timestamp of first upload. */
  readonly createdAt: string
  /** Live reference count — slots + published versions pointing to this blob. */
  readonly refCount: number
  /**
   * Hint indicating which store holds the chunk data (v0.12 #162).
   * Used by `routeStore` size-tiered routing: `'default'` for small blobs
   * stored inline (e.g. DynamoDB), `'blobs'` for large blobs in the overflow
   * store (e.g. S3). Absent when no routing is configured.
   */
  readonly storeHint?: 'default' | 'blobs'
}

// ─── Attachment types (v0.12) ─────────────────────────────────────────

/** Single attachment metadata entry stored inside a record's attachment envelope. */
export interface AttachmentEntry {
  /** Content-addressed identifier (HMAC-SHA-256 of plaintext). */
  readonly eTag: string
  /** User-visible filename for the slot. */
  readonly filename: string
  /** Original uncompressed size in bytes. */
  readonly size: number
  /** MIME type, if provided or auto-detected at upload time. */
  readonly mimeType?: string
  /** ISO timestamp of the upload. */
  readonly uploadedAt: string
  /** User ID of the uploader, if available. */
  readonly uploadedBy?: string
}

/** Attachment entry annotated with its slot name, as returned by `AttachmentHandle.list()`. */
export type AttachmentInfo = AttachmentEntry & { readonly name: string }

/** Options for `AttachmentHandle.put()`. */
export interface AttachmentPutOptions {
  /** Compress the attachment with gzip before encryption. Default: `true`. */
  compress?: boolean
  /** Chunk size in bytes. Default: `DEFAULT_CHUNK_SIZE` (256 KB). */
  chunkSize?: number
  /** MIME type to store with the attachment. Auto-detected from magic bytes if omitted. */
  mimeType?: string
  /** User ID to record as the uploader. Falls back to the active user's ID. */
  uploadedBy?: string
}

/** Options for `AttachmentHandle.response()`. */
export interface AttachmentResponseOptions {
  /**
   * Set `Content-Disposition: inline` so the browser renders the file
   * instead of downloading it. Default: `false` (attachment disposition).
   */
  inline?: boolean
}

/**
 * Slot record — mutable metadata linking a named slot on a record
 * to a `BlobObject` via its eTag.
 *
 * Multiple slots (even across different records) may reference the same
 * `eTag` — the underlying chunks are shared. Updating metadata creates
 * a new envelope version (`_v++`) while the blob data is unchanged.
 */
export interface SlotRecord {
  /** Reference to the `BlobObject` in `_blob_index`. */
  readonly eTag: string
  /** User-visible filename for the slot. */
  readonly filename: string
  /** Original uncompressed size in bytes (denormalized from `BlobObject`). */
  readonly size: number
  /** MIME type. Takes precedence over the MIME type stored in `BlobObject`. */
  readonly mimeType?: string
  /** ISO timestamp of the upload that set this slot. */
  readonly uploadedAt: string
  /** User ID of the uploader, if available. */
  readonly uploadedBy?: string
}

/** Result of `BlobSet.list()` — slot record plus its named slot key. */
export interface SlotInfo extends SlotRecord {
  /** The slot name (key in the record's slot map). */
  readonly name: string
}

/**
 * Explicitly published version snapshot — an independent reference to a
 * blob at a specific point in time (v0.12 UC-3 amendment versioning).
 */
export interface VersionRecord {
  /** User-defined label (e.g. `'issued-2025-01'`, `'amendment-2025-02'`). */
  readonly label: string
  /** eTag of the blob snapshot at publish time — independent of the current slot. */
  readonly eTag: string
  /** ISO timestamp when the version was published. */
  readonly publishedAt: string
  /** User ID of the publisher, if available. */
  readonly publishedBy?: string
}

/** Options for `BlobSet.put()`. */
export interface BlobPutOptions {
  /** MIME type hint. If omitted, auto-detected from magic bytes. */
  mimeType?: string
  /**
   * Raw chunk size in bytes. Priority: this value > store.maxBlobBytes > 256 KB.
   */
  chunkSize?: number
  /**
   * Whether to gzip-compress bytes before encrypting. Default: `true`.
   * Auto-set to `false` for pre-compressed MIME types (JPEG, PNG, ZIP, etc.).
   */
  compress?: boolean
  /** User ID to record as `uploadedBy`. Defaults to the Noydb session user. */
  uploadedBy?: string
}

/** Options for `BlobSet.response()` and `BlobSet.responseVersion()`. */
export interface BlobResponseOptions {
  /**
   * When `true`, sets `Content-Disposition: inline; filename="..."` so
   * the browser renders the file in the tab. Default (`false`) sets
   * `attachment; filename="..."` which triggers a download.
   */
  inline?: boolean
  /** Override the filename in the Content-Disposition header. */
  filename?: string
}

// ─── Store Capabilities (v0.10 #141 #143) ─────────────────────────────

export type StoreAuthKind =
  | 'none'
  | 'filesystem'
  | 'api-key'
  | 'iam'
  | 'oauth'
  | 'kerberos'
  | 'browser-origin'

export interface StoreAuth {
  kind: StoreAuthKind | StoreAuthKind[]
  required: boolean
  flow: 'static' | 'oauth' | 'kerberos' | 'implicit'
}

export interface StoreCapabilities {
  /**
   * true — the store's expectedVersion check and write are atomic at the
   * storage layer. Two concurrent puts with the same expectedVersion will
   * produce exactly one success and one ConflictError.
   * false — check and write are separate operations with a race window.
   */
  casAtomic: boolean
  auth: StoreAuth
  /**
   * true — the store implements {@link NoydbStore.tx} and commits
   * every op atomically at the storage layer (v0.16 #240). The hub's
   * `db.transaction(fn)` will delegate to `tx(ops)` and surface a
   * single pass/fail outcome. false (or absent) — no native
   * multi-record atomicity; the hub falls back to per-record OCC
   * with best-effort unwind on partial failure.
   */
  txAtomic?: boolean
  /**
   * Maximum raw bytes per blob chunk record (v0.12 #105).
   * `undefined` — no limit (S3, file, IDB); blob stored as single chunk.
   * `256 * 1024` — DynamoDB (400 KB item limit minus envelope overhead).
   * `5 * 1024 * 1024` — localStorage quota safety.
   */
  maxBlobBytes?: number
}

// ─── Factory Options ───────────────────────────────────────────────────

export interface NoydbOptions {
  /** Primary store (local storage). */
  readonly store: NoydbStore
  /** Optional remote store(s) for sync. Accepts a single store, a SyncTarget, or an array. */
  readonly sync?: NoydbStore | SyncTarget | SyncTarget[]
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
  /**
   * Sync scheduling policy (v0.12 #101). Controls when push/pull fire.
   * Default inferred from store category: per-record → `on-change`,
   * bundle → `debounce 30s`.
   */
  readonly syncPolicy?: SyncPolicy
  /**
   * @deprecated Use `syncPolicy` instead. Kept for backward compatibility.
   * When both are supplied, `syncPolicy` takes precedence.
   */
  readonly autoSync?: boolean
  /**
   * @deprecated Use `syncPolicy` instead. Kept for backward compatibility.
   */
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
  /**
   * Consumer-supplied translation function for `i18nText` fields with
   * `autoTranslate: true` (v0.8 #83).
   *
   * ⚠ **`plaintextTranslator` receives unencrypted text.** Configuring
   * this hook causes plaintext to leave noy-db's zero-knowledge boundary
   * over whatever channel the consumer's implementation uses. noy-db ships
   * no built-in translator and adds no translator SDKs as dependencies.
   * The consumer chooses and owns the data policy of the external service.
   *
   * Per-field opt-in via `autoTranslate: true` on `i18nText()`. Calling
   * `put()` on a collection with `autoTranslate: true` fields while this
   * option is absent throws `TranslatorNotConfiguredError`.
   *
   * See `NOYDB_SPEC.md § Zero-Knowledge Storage` for the invariant text.
   */
  readonly plaintextTranslator?: PlaintextTranslatorFn
  /**
   * Human-readable name for the translator, recorded in the in-process
   * audit log (e.g. `'deepl-pro-with-dpa'`, `'self-hosted-llama-7b'`).
   * Defaults to `'anonymous'` when not supplied.
   */
  readonly plaintextTranslatorName?: string
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

// ─── Bulk operations (v0.16 #242) ──────────────────────────────────────

/** Per-item options for `Collection.putMany()`. */
export interface PutManyItemOptions {
  /**
   * Optimistic-concurrency check: fail this item if the stored version
   * is not `expectedVersion`. Honored only in `atomic: true` mode;
   * ignored in the default best-effort loop.
   */
  readonly expectedVersion?: number
}

/**
 * Batch-level options for `Collection.putMany()` and `deleteMany()`.
 *
 * `atomic: true` (v0.16 #240) switches the call from best-effort loop
 * to all-or-nothing: a pre-flight CAS check runs first, then every op
 * is executed; any mid-batch failure triggers a best-effort revert.
 * On failure in atomic mode the whole call throws — you won't get a
 * partial `PutManyResult`. On success the result mirrors the default
 * loop's shape.
 */
export interface PutManyOptions {
  readonly atomic?: boolean
}

/** Result of `Collection.putMany()`. */
export interface PutManyResult {
  /** `true` iff every entry succeeded. */
  readonly ok: boolean
  /** IDs that were successfully written. */
  readonly success: readonly string[]
  /** Entries that failed, with the error that prevented each write. */
  readonly failures: ReadonlyArray<{ readonly id: string; readonly error: Error }>
}

/** Result of `Collection.deleteMany()`. Same shape as `PutManyResult`. */
export interface DeleteManyResult {
  readonly ok: boolean
  readonly success: readonly string[]
  readonly failures: ReadonlyArray<{ readonly id: string; readonly error: Error }>
}
