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
import type { BlobStrategy } from './blobs/strategy.js'
import type { IndexStrategy } from './indexing/strategy.js'
import type { AggregateStrategy } from './aggregate/strategy.js'
import type { CrdtStrategy } from './crdt/strategy.js'
import type { ConsentStrategy } from './consent/strategy.js'
import type { PeriodsStrategy } from './periods/strategy.js'
import type { ShadowStrategy } from './shadow/strategy.js'
import type { TxStrategy } from './tx/strategy.js'
import type { HistoryStrategy } from './history/strategy.js'
import type { I18nStrategy } from './i18n/strategy.js'
import type { SessionStrategy } from './session/strategy.js'
import type { SyncStrategy } from './team/sync-strategy.js'
import type { GuardStrategyHandleAny } from './guards/types.js'
import type { DerivationStrategyHandle } from './derivations/types.js'
import type { UnlockedKeyring } from './team/keyring.js'
import type { VaultPolicy } from './policy/types.js'
import type { PublicEnvelopeSchema } from './meta/public-envelope/types.js'
import type { MaterializedViewStrategyHandle } from './materialized-views/types.js'
import type { OverlayedViewStrategyHandle } from './overlay-views/types.js'
import type { SealingKeyProvider } from './team/managed-passphrase.js'
import type { ShamirRecoveryProvider } from './team/shamir-recovery-provider.js'

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

/** The encrypted wrapper stored by stores. Stores only ever see this. */
export interface EncryptedEnvelope {
  readonly _noydb: typeof NOYDB_FORMAT_VERSION
  readonly _v: number
  readonly _ts: string
  readonly _iv: string
  readonly _data: string
  /** User who created this version (unencrypted metadata). */
  readonly _by?: string
  /**
   * Hierarchical access tier. Omitted → tier 0.
   *
   * Unencrypted on purpose — the store reads it to route the envelope
   * to the right DEK slot without having to try-decrypt against every
   * tier. Only leaks the tier of each record, not any value
   * equivalence.
   */
  readonly _tier?: number
  /**
   * User id who last elevated this record. Used by
   * `demote()` to gate the reverse operation: only the original
   * elevator or an owner can demote a record back down. Cleared on
   * every successful demote so a later re-elevate requires the new
   * actor to own the demotion right.
   */
  readonly _elevatedBy?: string
  /**
   * Deterministic-encryption index. Map of field name →
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

/** Control what lower-tier reads see above their clearance. */
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
  /**
   * When `authorization === 'elevation'`, the audit reason string the
   * caller passed to `vault.elevate(...)`. Empty for inherent /
   * delegation paths.
   */
  readonly reason?: string
  /**
   * When `authorization === 'elevation'`, the tier the caller's
   * keyring effectively held BEFORE elevation. Useful for audit
   * dashboards distinguishing "operator elevating to 2" from
   * "inherent tier-2 write."
   */
  readonly elevatedFrom?: number
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
   * Optional human-readable store name (e.g. 'memory', 'file', 'dynamo').
   * Used in diagnostic messages and the listPage fallback warning. Stores
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
   * Used by partial sync (`pull({ modifiedSince })`). Stores that omit this
   * fall back to a full `loadAll` + client-side timestamp filter.
   */
  listSince?(vault: string, collection: string, since: string): Promise<string[]>

  /**
   * Optional pagination extension. Stores that implement `listPage` get
   * the streaming `Collection.scan()` fast path; stores that don't are
   * silently fallen back to a full `loadAll()` + slice (with a one-time
   * console.warn).
   *
   * `cursor` is opaque to the core — each store encodes its own paging
   * state (DynamoDB: base64 LastEvaluatedKey JSON; S3: ContinuationToken;
   * memory/file/browser: numeric offset of a sorted id list). Pass
   * `undefined` to start from the beginning.
   *
   * `limit` is a soft upper bound on `items.length`. Stores MAY return
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
   * Optional pub/sub for real-time presence.
   * Publish an encrypted payload to a presence channel.
   * Falls back to storage-based polling when absent.
   */
  presencePublish?(channel: string, payload: string): Promise<void>

  /**
   * Optional pub/sub for real-time presence.
   * Subscribe to a presence channel. Returns an unsubscribe function.
   * Falls back to storage-based polling when absent.
   */
  presenceSubscribe?(channel: string, callback: (payload: string) => void): () => void

  /**
   * Optional cross-vault enumeration extension.
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
   * Optional: generate a presigned URL for direct client download.
   * Only meaningful for object stores (S3, GCS) that support URL signing.
   * Returns a time-limited URL that fetches the encrypted envelope directly.
   * The caller must decrypt client-side (the URL returns ciphertext).
   */
  presignUrl?(vault: string, collection: string, id: string, expiresInSeconds?: number): Promise<string>

  /**
   * Optional: estimate current storage usage.
   * Returns `{ usedBytes, quotaBytes }` or null if the store cannot estimate.
   * Used by quota-aware routing to detect overflow conditions.
   */
  estimateUsage?(): Promise<{ usedBytes: number; quotaBytes: number } | null>

  /**
   * Optional multi-record atomic write.
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
 * Owner-granted export capability on a keyring.
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

/**
 * Owner-granted import capability on a keyring (sibling of
 * `ExportCapability`, issue ).
 *
 * Two independent dimensions:
 *
 * - `plaintext` — per-format allowlist for `as-*` readers that ingest
 *   plaintext bytes (`as-csv`, `as-json`, `as-ndjson`, `as-zip`, …).
 *   Defaults to empty for every role; the owner/admin must positively
 *   grant per-format (or `'*'`).
 * - `bundle` — boolean gate for `.noydb` bundle import. **Defaults to
 *   `false` for every role**, including owner/admin. Import is more
 *   dangerous than export (corrupts vs leaks), so the policy is
 *   default-closed across the board — the owner explicitly opts a
 *   keyring in via `db.grant({ importCapability: { bundle: true } })`.
 */
export interface ImportCapability {
  readonly plaintext?: readonly ExportFormat[]
  readonly bundle?: boolean
}

/**
 * Forward-declared on-disk shape for `VaultPolicy` — the actual policy
 * model lives in `policy/types.ts` (#9). Declared here as `unknown`-typed
 * map so types.ts has no dependency on the policy module while the
 * `KeyringFile.policy` field can still round-trip foreign documents.
 *
 * @internal
 */
export type VaultPolicyOnDisk = Record<string, unknown>

/**
 * Recovery profile enrolled at vault creation (issue #10).
 *
 * - `paper` — `on-recovery` codes (the only end-to-end profile in v0.1.0-pre.5).
 * - `shamir` / `multi-channel` / `admin-mediated` — API surface ships;
 *   per-profile dispatch lands in follow-up issues. Calling
 *   `db.recoverPassphrase` against these throws
 *   {@link RecoveryProfileNotImplementedError}.
 */
export type RecoveryEnrollment =
  | {
      readonly profile: 'paper'
      /** Number of single-use codes to print at enrollment. */
      readonly codes: number
    }
  | {
      readonly profile: 'shamir'
      readonly k: number
      readonly n: number
      readonly trustees: ReadonlyArray<string>
    }
  | {
      readonly profile: 'multi-channel'
      readonly email?: string
      readonly pin?: boolean
      readonly paperCodes?: number
    }
  | {
      readonly profile: 'admin-mediated'
      readonly grantorUserId: string
    }

/**
 * One tier-2 authenticator slot inside a keyring file. Each slot
 * independently wraps the SAME KEK under a method-specific derived key
 * (LUKS pattern). Adding or removing a slot is a constant-time keyring
 * write — no DEK re-keying required.
 *
 * @see docs/subsystems/session-tiers.md → Tier 2 — Authenticate (multi-slot)
 */
/**
 * Shared fields across all authenticator slot variants. The variant
 * (`KeyringAuthenticatorWrappingKEK` vs `KeyringAuthenticatorWrappingDEKs`)
 * carries the actual wrapped material; everything below is identity +
 * metadata only.
 */
interface KeyringAuthenticatorBase {
  /** Caller-chosen identifier — e.g. `'webauthn-yubikey-blue'`, `'oidc-google'`, `'password'`. */
  readonly id: string
  /** Method family — selects which `@noy-db/on-*` package handles unlock. */
  readonly method: 'webauthn' | 'oidc' | 'password'
  /** ISO-8601 timestamp at which the slot was added. */
  readonly enrolled_at: string
  /**
   * Which session tier ENROLLED this slot. Tier 1 enrolls a fresh slot;
   * tier 2 may add a sibling slot when the active policy permits.
   */
  readonly enrolled_via_tier: 1 | 2
  /**
   * Method-specific metadata: WebAuthn cred id, OIDC issuer/sub, PBKDF2
   * salt for `on-password`, etc. The schema is open by design — the
   * `@noy-db/on-*` package owns the contents.
   */
  readonly meta: Record<string, unknown>
}

/**
 * Slot that wraps the KEK directly under a method-derived AES-KW key.
 * Used by ceremonies where the on-* package can produce/recover an
 * extractable KEK from its own credential — WebAuthn (PRF-derived
 * wrapping key) and split-key OIDC.
 *
 * `wrapKind` is optional/absent on slots written before pre.8 — those
 * legacy slots are treated as wrap-KEK by default at unlock time.
 */
export interface KeyringAuthenticatorWrappingKEK extends KeyringAuthenticatorBase {
  readonly wrapKind?: 'kek'
  /** Base64 wrapped-KEK ciphertext under the method-derived key. */
  readonly wrapped_kek: string
  /** XOR guard — wrap-KEK slots must NOT carry wrap-DEKs material. */
  readonly wrapped_deks?: never
  /** XOR guard — wrap-KEK slots must NOT carry wrap-DEKs material. */
  readonly iv?: never
}

/**
 * Slot that wraps the DEK set (not the KEK) under a method-derived
 * AES-GCM key — sidesteps the non-extractable-KEK constraint by
 * encrypting the serialized `{ deks: { collection: rawDekBase64 } }`
 * directly. Mirrors the format used by `mintPaperRecoveryEntry`
 * (`PaperRecoveryEntry`) and `@noy-db/on-pin`'s `PinResumeState` —
 * the unified wrap-DEKs primitive across tier-0 / tier-2 / tier-3.
 *
 * Trade-off: a slot of this kind reconstructs `UnlockedKeyring` with
 * `kek: null` after unlock. That is semantically correct for tier-2
 * (sensitive ops like `enrollAuthenticator` / `rotatePassphrase`
 * require a tier-1 unlock anyway) and matches how `@noy-db/on-pin`
 * already behaves at tier 3.
 *
 * @see `mintPaperRecoveryEntry` in `team/recovery.ts` — same shape on
 *      a different on-disk path (`_meta/recovery-paper`).
 */
export interface KeyringAuthenticatorWrappingDEKs extends KeyringAuthenticatorBase {
  readonly wrapKind: 'deks'
  /** Base64 AES-GCM ciphertext of `{ deks: { collection: base64rawDek } }`. */
  readonly wrapped_deks: string
  /** Base64 AES-GCM IV used for the `wrapped_deks` ciphertext. */
  readonly iv: string
  /** XOR guard — wrap-DEKs slots must NOT carry wrap-KEK material. */
  readonly wrapped_kek?: never
}

/**
 * Discriminated union over the two wrap-format variants. Reads from
 * disk should always go through this type so the variant is preserved.
 *
 * Discriminator: `wrapKind`. Absent → wrap-KEK (legacy / WebAuthn /
 * OIDC). Present and `'deks'` → wrap-DEKs (password / future on-* that
 * want to sidestep extractable-KEK).
 *
 * The type-level XOR enforces "exactly one of `wrapped_kek` /
 * `wrapped_deks` is present" — a structural guarantee that the runtime
 * dispatch is safe.
 */
export type KeyringAuthenticator =
  | KeyringAuthenticatorWrappingKEK
  | KeyringAuthenticatorWrappingDEKs

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
   * Passphrase canary — base64 AES-KW-wrapped form of a known constant
   * 256-bit value, wrapped under the keyring's KEK (#113).
   *
   * Optional: pre-#113 keyrings load with no canary and fall back to
   * the multi-DEK corruption heuristic from #82. Keyrings written after
   * #113 carry one and let `loadKeyring` distinguish wrong-passphrase
   * from corruption even when ALL DEKs (including a single-DEK keyring's
   * sole DEK) are corrupted.
   *
   * AES-KW is deterministic — every write site mints fresh on each
   * persist; same KEK + same constant input always produces the same
   * ciphertext, so this round-trips without state.
   */
  readonly canary?: string
  /**
   * Tier-2 authenticator slots (multi-slot keyring extension).
   * Optional / append-only: keyring files written before the
   * extension load with an empty list. Each slot independently wraps
   * the same KEK; any one of them unlocks.
   *
   * @see KeyringAuthenticator
   */
  readonly authenticators?: readonly KeyringAuthenticator[]
  /**
   * Per-keyring policy override (reserved). The on-disk format
   * accepts the field for forward compatibility with the Option C
   * merge engine deferred to a later release; v1.0 reads only the
   * vault-level `_meta/policy` document, so this field is parsed and
   * round-tripped but never enforced.
   */
  readonly policy?: VaultPolicyOnDisk
  /**
   * Optional — authorization spec capability bits. Absent on keyrings written
   * before the RFC implementation. Loading falls back to role-based
   * defaults (owner/admin get bundle-on, everyone else off).
   */
  readonly export_capability?: ExportCapability
  /**
   * Optional bundle-slot expiry. ISO-8601 timestamp; past
   * the cutoff `loadKeyring` throws `KeyringExpiredError` before any
   * DEK unwrap is attempted. Useful for time-boxed audit access:
   * "this slot works for 30 days then becomes opaque to its holder."
   *
   * Absent on live keyrings written via `db.grant()` — the field is
   * meaningful for `BundleRecipient` slots produced by
   * `writeNoydbBundle({ recipients: [...] })`. Setting it on a live
   * keyring is allowed but unusual.
   */
  readonly expires_at?: string
  /**
   * Optional — issue  import-capability bits. Absent on keyrings
   * written before  landed. Loading falls back to default-closed
   * for every role and every format.
   */
  readonly import_capability?: ImportCapability
  /**
   * hierarchical access clearance. Absent → 0 (advisory;
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
   * compat with backups, which only stored data collections —
   * loading a backup leaves the ledger empty (and `verifyBackupIntegrity`
   * skips the chain check, surfacing only a console warning).
   */
  readonly _internal?: VaultSnapshot
  /**
   * Verifiable-backup metadata. Embeds the ledger head at
   * dump time so `load()` can cross-check that the loaded chain matches
   * exactly what was exported. A backup whose chain has been tampered
   * with — either by modifying ledger entries or by modifying data
   * envelopes that the chain references — fails this check.
   *
   * Optional for backwards compat with backups; missing means
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
   * `dictionaries` snapshot from the output. Has no effect
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
   * collection. Captured once at stream-start and held
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

/**
 * #228c — a same-device cross-tab write conflict: another tab overwrote a
 * document this tab had written, having diverged from an older base. Records
 * are decrypted (cross-tab handlers reconcile in plaintext). `base` is the
 * common ancestor from history, or null when history is unavailable.
 */
export interface WriteConflict {
  readonly vault: string
  readonly collection: string
  readonly docId: string
  readonly local: unknown
  readonly remote: unknown
  readonly base: unknown
  readonly localVersion: number
  readonly remoteVersion: number
  readonly baseVersion: number
}

export type ConflictStrategy =
  | 'local-wins'
  | 'remote-wins'
  | 'version'
  | ((conflict: Conflict) => 'local' | 'remote')

/**
 * Collection-level conflict policy.
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

/** Options for targeted push operations. */
export interface PushOptions {
  /** Only push records belonging to these collections. Omit to push all dirty. */
  collections?: string[]
}

/** Options for targeted pull operations. */
export interface PullOptions {
  /** Only pull these collections. Omit to pull all. */
  collections?: string[]
  /**
   * Only pull records with `_ts` strictly after this ISO timestamp.
   * Stores that implement `listSince` use it directly; others fall back
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

/** Result of a sync transaction commit. */
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

// ─── Sync Target ─────────────────────────────────────────

export type SyncTargetRole = 'sync-peer' | 'backup' | 'archive'

/**
 * A sync target with role and optional per-target policy.
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
  /**
   * Same-instance signal that this vault's schema-fence state changed
   * (#232). For UI integration (#233). Cross-client coordination goes
   * through the store, not this event.
   */
  'schema:fence-changed': { vault: string; currentSchemaVersion: number; fenceState: 'normal' | 'draining' | 'migrating' | 'complete' }
  'sync:push': PushResult
  'sync:pull': PullResult
  'sync:conflict': Conflict
  'write:conflict': WriteConflict
  'sync:online': void
  'sync:offline': void
  'sync:backup-error': { vault: string; target: string; error: Error }
  'history:save': { vault: string; collection: string; id: string; version: number }
  'history:prune': { vault: string; collection: string; id: string; pruned: number }
  /**
   * Emitted when a persisted-index side-car put/delete fails after the
   * main record write already succeeded. The main record is durable; the
   * index mirror may have drifted. Operators reconcile via
   * `collection.reconcileIndex(field)`.
   */
  'index:write-partial': {
    vault: string
    collection: string
    id: string
    action: 'put' | 'delete'
    error: Error
  }
  /**
   * emitted by `Collection.ensurePersistedIndexesLoaded()`
   * once per field on first lazy-mode query when
   * `reconcileOnOpen: 'auto' | 'dry-run'` is configured. `applied` is
   * `0` in `'dry-run'` mode. `skipped` is reserved for a future
   * drift-stamp optimization that short-circuits the reconcile when
   * the mirror version matches what's on disk — currently always
   * `false` (the full reconcile runs every session).
   */
  'index:reconciled': {
    vault: string
    collection: string
    field: string
    missing: readonly string[]
    stale: readonly string[]
    applied: number
    skipped: boolean
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
   * Optional `@noy-db/as-*` export capability. Omit or
   * leave undefined to apply role-based defaults (see
   * `hasExportCapability` and `ExportCapability`).
   */
  readonly exportCapability?: ExportCapability
  /**
   * Optional `@noy-db/as-*` import capability (issue ). Omit or
   * leave undefined for default-closed semantics — no plaintext format
   * is grantable until positively listed; bundle import is denied.
   */
  readonly importCapability?: ImportCapability
  /**
   * Skip phrase-format strength validation (issue #7). Defaults to
   * false — `grant()` rejects phrases that don't meet the configured
   * `PassphrasePolicy`. Test fixtures and CLI scripts pass `true`.
   */
  readonly allowWeakPassphrase?: boolean
  /**
   * Initial user-envelope payload for the new principal. Sealed under
   * the same vault DEK (the reserved `_users` collection's DEK) and
   * persisted alongside the keyring during grant.
   *
   * **Bootstrap-only.** Once the new user activates and writes their
   * own envelope, the own-only write rule kicks in — admins cannot
   * edit a teammate's envelope after activation. Use this field for
   * pre-fill at invite time (e.g. "displayName: Bob, locale: en-US")
   * and let the user take over from there.
   *
   * Hub does not introspect the payload; it is JSON-serialized and
   * encrypted opaquely. Apps own the schema.
   *
   * @see docs/superpowers/specs/2026-05-05-user-envelope-design.md → Lifecycle
   */
  readonly initialProfile?: unknown
}

/**
 * Caller payload for `db.updateUser` (#54). Mutate one or more
 * identity fields on an existing keyring without rotating any keys.
 *
 * `role`, `displayName`, and `permissions` live in the plaintext header
 * of `_keyring/<userId>` (the sync engine reads them without keys).
 * Mutating them is a JSON header swap — no DEK rewrap, no KEK
 * required, no authenticator slots touched. Tier-2 slots and recovery
 * enrollments survive unchanged. Last-write-wins through the existing
 * keyring put (same concurrency story as `db.grant` / `db.revoke`).
 *
 * Top-level fields are partial-merge: absent fields are not modified.
 * `null` on `displayName` clears the field (stored as the empty string;
 * UI consumers typically render the empty case by falling back to the
 * user id). `undefined` / absent leaves the field untouched. Mirrors
 * the `null`-as-clear convention `UserApi.updateMe` uses (#57).
 *
 * `permissions`, however, is a **full replacement** at the map level —
 * passing `{ invoices: 'rw' }` REPLACES the entire permissions map,
 * silently dropping any other entries. To partially update, read the
 * current keyring and merge: `permissions: { ...current, invoices: 'rw' }`.
 * To clear all permissions, pass `permissions: {}` explicitly.
 *
 * Role-elevation guard: the same hierarchy as `db.grant`. Admins can
 * change `admin` / `operator` / `viewer` / `client` to and from each
 * other; admins cannot promote to or demote from `owner`. Owners can
 * do anything. Non-admin callers (operator/viewer/client) cannot call
 * `db.updateUser` at all — for self-displayName changes, use
 * `vault.user.updateMe` (the user-envelope API).
 *
 * @see #54
 */
export interface UpdateUserOptions {
  readonly userId: string
  readonly role?: Role
  readonly displayName?: string | null
  readonly permissions?: Permissions
}

export interface RevokeOptions {
  readonly userId: string
  readonly rotateKeys?: boolean

  /**
   * Cascade behavior when the revoked user is an admin who has granted
   * other admins.
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

// ─── Cross-vault queries ──────────────────────────────

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
   * Minimum role the caller must hold to include a vault in the
   * result. Vaults where the caller's role is strictly *below*
   * this threshold are silently excluded. Defaults to `'client'`,
   * which means "every vault I can unwrap is returned." Set to
   * `'admin'` for "vaults where I can grant/revoke," or
   * `'owner'` for "vaults I own."
   *
   * The privilege ordering used:
   *   `client (1) < viewer (2) < operator (3) < admin (4) < owner (5)`
   *
   * Note: `viewer` and `client` are conceptually peers in the ACL
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

// ─── Session ───────────────────────────────────────────────

/**
 * Operations that a session policy can require re-authentication for.
 * Passed as the `requireReAuthFor` array in `SessionPolicy`.
 */
export type ReAuthOperation = 'export' | 'grant' | 'revoke' | 'rotate' | 'changeSecret'

/**
 * Session policy controlling lifetime, re-auth requirements, and
 * background-lock behavior.
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

// ─── i18n / Locale ─────────────────────────────────────

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

// ─── plaintextTranslator hook ──────────────────────────────

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

// ─── Presence ─────────────────────────────────────────────

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

// ─── CRDT ─────────────────────────────────────────────────

// Re-exported from crdt.ts so consumers only need one import path.
export type { CrdtMode, CrdtState, LwwMapState, RgaState, YjsState } from './crdt/crdt.js'

// ─── Blob / Attachment Store ────────────────────────

/**
 * Second store shape for blob-store backends (Drive, WebDAV, Git, iCloud)
 * that operate on whole-vault bundles rather than per-record KV.
 *
 * Implement `readBundle` / `writeBundle` instead of the six-method KV
 * contract. Use `wrapBundleStore()` from `@noy-db/hub` to convert to a
 * `NoydbStore` that the rest of the API consumes transparently.
 *
 * Named `NoydbBundleStore` (not `NoydbBundleAdapter`) for consistency
 * with the hub / to-* / in-* rename. Concrete implementations ship
 * in `@noy-db/to-*` packages starting in.
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
   * Hint indicating which store holds the chunk data.
   * Used by `routeStore` size-tiered routing: `'default'` for small blobs
   * stored inline (e.g. DynamoDB), `'blobs'` for large blobs in the overflow
   * store (e.g. S3). Absent when no routing is configured.
   */
  readonly storeHint?: 'default' | 'blobs'
}

// ─── Attachment types ─────────────────────────────────────────

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
 * blob at a specific point in time.
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

// ─── Store Capabilities ─────────────────────────────

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
   * every op atomically at the storage layer. The hub's
   * `db.transaction(fn)` will delegate to `tx(ops)` and surface a
   * single pass/fail outcome. false (or absent) — no native
   * multi-record atomicity; the hub falls back to per-record OCC
   * with best-effort unwind on partial failure.
   */
  txAtomic?: boolean
  /**
   * Maximum raw bytes per blob chunk record.
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
  /**
   * tree-shake seam — optional blob strategy. Pass `withBlobs()`
   * from `@noy-db/hub/blobs` to enable `collection.blob(id)` storage.
   * When omitted, hub's blob machinery stays out of the bundle (ESM
   * tree-shaking) and `collection.blob(id)` throws with a pointer at
   * the subpath. `BlobStrategy` is `@internal` — users only construct
   * it via the subpath factory.
   *
   * @internal
   */
  readonly blobStrategy?: BlobStrategy
  /**
   * tree-shake seam — optional indexing strategy. Pass
   * `withIndexing()` from `@noy-db/hub/indexing` to enable eager-mode
   * `==/in` fast-paths, lazy-mode `.lazyQuery()`, rebuild/reconcile,
   * and auto-reconcile. When omitted, indexing code never reaches the
   * bundle; `.lazyQuery()` throws with a pointer at the subpath, and
   * eager-mode collections fall back to linear scans regardless of
   * `indexes: [...]` declarations. `IndexStrategy` is `@internal` —
   * users only construct it via the subpath factory.
   *
   * @internal
   */
  readonly indexStrategy?: IndexStrategy
  /**
   * tree-shake seam — optional aggregate strategy. Pass
   * `withAggregate()` from `@noy-db/hub/aggregate` to enable
   * `.aggregate()` and `.groupBy()` on Query. When omitted, those
   * methods throw with a pointer at the subpath; the ~886 LOC of
   * Aggregation + GroupedQuery machinery never reaches the bundle.
   * Streaming `scan().aggregate()` works independently of this
   * strategy — it doesn't use the `Aggregation` class.
   *
   * @internal
   */
  readonly aggregateStrategy?: AggregateStrategy
  /**
   * tree-shake seam — optional CRDT strategy. Required when
   * any collection is declared with `crdt: 'lww-map' | 'rga' | 'yjs'`;
   * otherwise the first put/sync-merge hitting the CRDT path throws.
   * When omitted, ~221 LOC of LWW-Map / RGA / merge helpers never
   * reach the bundle.
   *
   * @internal
   */
  readonly crdtStrategy?: CrdtStrategy
  /**
   * tree-shake seam — optional consent-audit strategy. Pass
   * `withConsent()` from `@noy-db/hub/consent` to enable per-op audit
   * writes into `_consent_audit` when a consent scope is active.
   * When omitted, `vault.consentAudit()` returns `[]` and writes are
   * no-ops; the consent module's ~194 LOC never reaches the bundle.
   *
   * @internal
   */
  readonly consentStrategy?: ConsentStrategy
  /**
   * tree-shake seam — optional periods strategy. Pass
   * `withPeriods()` from `@noy-db/hub/periods` to enable
   * `vault.closePeriod()` / `.openPeriod()` / write-guard on closed
   * periods. When omitted, `vault.listPeriods()` returns `[]` and
   * the write-guard is a no-op; the ~363 LOC of period validation +
   * ledger appending stay out of the bundle.
   *
   * @internal
   */
  readonly periodsStrategy?: PeriodsStrategy
  /**
   * tree-shake seam — optional VaultFrame strategy. Pass
   * `withShadow()` from `@noy-db/hub/shadow` to enable
   * `vault.frame()`. Without it, calling `vault.frame()` throws.
   *
   * @internal
   */
  readonly shadowStrategy?: ShadowStrategy
  /**
   * tree-shake seam — optional multi-record transactions. Pass
   * `withTransactions()` from `@noy-db/hub/tx` to enable
   * `db.transaction(fn)`. Without it, calling the method throws.
   *
   * @internal
   */
  readonly txStrategy?: TxStrategy
  /**
   * tree-shake seam — optional history + ledger + time-machine.
   * Pass `withHistory()` from `@noy-db/hub/history` to enable
   * per-record version snapshots, the hash-chained audit ledger, JSON
   * Patch deltas, `vault.ledger()`, `vault.at()`, and the
   * `collection.history()` / `getVersion()` / `revert()` / `diff()` /
   * `clearHistory()` / `pruneRecordHistory()` read APIs. When omitted,
   * snapshots/prune/clear are silent no-ops, the read APIs throw with
   * a pointer at the subpath, and ~1,880 LOC stay out of the bundle.
   *
   * @internal
   */
  readonly historyStrategy?: HistoryStrategy
  /**
   * tree-shake seam — optional i18n strategy. Pass `withI18n()`
   * from `@noy-db/hub/i18n` to enable `i18nText`/`dictKey` field
   * resolution on reads, `i18nText` validation on writes, and
   * `vault.dictionary(name)`. When omitted, locale resolution is the
   * identity (raw values returned), the validators throw with a
   * pointer to the subpath, and ~854 LOC of dictionary + locale
   * machinery stay out of the bundle.
   *
   * @internal
   */
  readonly i18nStrategy?: I18nStrategy
  /**
   * tree-shake seam — optional session-policy strategy. Pass
   * `withSession()` from `@noy-db/hub/session` to enable
   * `sessionPolicy` validation, `PolicyEnforcer` lifecycle (idle /
   * absolute timeouts, lockOnBackground), and global session-token
   * revocation. When omitted, setting `sessionPolicy` throws at
   * `createNoydb()` time, and ~495 LOC of policy + token machinery
   * stay out of the bundle.
   *
   * @internal
   */
  readonly sessionStrategy?: SessionStrategy
  /**
   * tree-shake seam — optional sync engine + presence strategy.
   * Pass `withSync()` from `@noy-db/hub/sync` to enable
   * `db.push()` / `pull()` / replication, `db.transaction(vault)`
   * for sync-aware transactions, and `collection.presence()`. When
   * omitted, configuring `sync` / calling these surfaces throws with
   * a pointer at the subpath, and ~856 LOC of replication + presence
   * machinery stay out of the bundle. Keyring stays core; grant/
   * revoke/magic-link/delegation tree-shake via direct imports.
   *
   * @internal
   */
  readonly syncStrategy?: SyncStrategy
  /**
   * Optional guard strategies — collection-level write guards. Each
   * handle is the output of `withGuard()` from `@noy-db/hub/guards`.
   * Multiple guards per collection are allowed; they are dispatched
   * in registration order on `collection.put()`.
   */
  readonly guardStrategies?: ReadonlyArray<GuardStrategyHandleAny>
  /**
   * Optional derivation strategies — source-to-output projections that
   * fire on `collection.put()`. Each handle is the output of
   * `withDerivation()` from `@noy-db/hub/derivations`. The vault
   * validates the derivation graph for cycles on `openVault`; a cyclic
   * graph throws `DerivationCycleError`.
   */
  readonly derivationStrategies?: ReadonlyArray<DerivationStrategyHandle>
  /**
   * Optional materialized-view strategies (#143, foundation in #150).
   * Each handle returned by `withMaterializedView()` from
   * `@noy-db/hub/materialized-views`. The vault runs unified cycle
   * detection across the MV + derivation graphs at `openVault`; a
   * cyclic graph throws `MaterializedViewCycleError`.
   */
  readonly materializedViewStrategies?: ReadonlyArray<MaterializedViewStrategyHandle>
  /**
   * Optional overlay strategies (#154). Each handle returned by
   * `withOverlayedView()` from `@noy-db/hub/overlay-views`. The vault
   * validates name uniqueness + base concreteness + overlay
   * availability at `openVault`; a clash throws one of the
   * `Overlay*Error` family.
   */
  readonly overlayedViewStrategies?: ReadonlyArray<OverlayedViewStrategyHandle>
  /** Optional remote store(s) for sync. Accepts a single store, a SyncTarget, or an array. */
  readonly sync?: NoydbStore | SyncTarget | SyncTarget[]
  /** User identifier. */
  readonly user: string
  /** Passphrase for key derivation. Required unless encrypt is false or `getKeyring` is provided. */
  readonly secret?: string
  /**
   * Optional callback that returns an unlocked keyring for a given vault.
   * Use this to plug in WebAuthn / OIDC / Shamir / any unlock path that
   * produces an `UnlockedKeyring` outside the passphrase model.
   *
   * When set, `secret` MUST NOT also be set — `createNoydb` throws if both
   * are supplied. When neither is set (and `encrypt !== false`), `createNoydb`
   * also throws.
   *
   * The callback is called lazily, on the first operation that needs the
   * keyring for a given vault. Noydb caches the returned keyring per-vault
   * for the lifetime of the instance, so the callback is invoked at most
   * once per `(instance, vault)` pair (assuming the callback resolves
   * successfully). If the callback rejects, the rejection surfaces from the
   * first vault operation that triggered the unlock; subsequent operations
   * will retry the callback.
   *
   * @example
   * ```ts
   * import { createNoydb } from '@noy-db/hub'
   * import { unlockWebAuthn } from '@noy-db/on-webauthn'
   *
   * const enrollment = await loadEnrollment()
   * const db = await createNoydb({
   *   store,
   *   user: 'alice',
   *   getKeyring: (vault) => unlockWebAuthn(enrollment),
   * })
   * ```
   *
   * Note: this callback is responsible for both the "open existing vault"
   * and the "create new vault" cases. Unlike the passphrase path, there is
   * no automatic `NoAccessError` → `createOwnerKeyring` fallback, because
   * the callback owner has the UI context to decide which path to run.
   * For first-time bootstrap, use a passphrase or recovery code, enroll
   * WebAuthn from the unlocked keyring, then swap to `getKeyring` on
   * subsequent sessions.
   */
  readonly getKeyring?: (vault: string) => Promise<UnlockedKeyring>
  /**
   * Passphrase mode (#14). Default `'standard'`.
   *
   *   - `'standard'` — the legacy flow. `secret` supplies the
   *     plaintext passphrase, the user knows it, and the policy gate
   *     `rotate-passphrase` is enabled.
   *   - `'managed'` — rubber-hose-resistant mode. Hub generates a
   *     256-bit random passphrase at first open and seals it under
   *     the provided `sealingKey`. The user never sees or types the
   *     passphrase, defeating the $5-wrench attack. Mutually
   *     exclusive with `secret` and `getKeyring`.
   *
   * @see docs/subsystems/session-tiers.md → Managed-passphrase mode
   */
  readonly passphraseMode?: 'standard' | 'managed'
  /**
   * Provider that seals/unseals the auto-generated managed-mode
   * passphrase. Required when `passphraseMode === 'managed'`; ignored
   * otherwise. Implementations live in per-platform packages
   * (`@noy-db/seal-macos-keychain`, `@noy-db/seal-wincred`,
   * `@noy-db/seal-libsecret`, `@noy-db/seal-aws-kms`, …).
   */
  readonly sealingKey?: SealingKeyProvider
  /** Required to use `profile: 'shamir'` recovery. Pass
   *  `shamirRecoveryProvider()` from `@noy-db/on-shamir`. */
  readonly shamirRecovery?: ShamirRecoveryProvider
  /** Auth method. Default: 'passphrase'. */
  readonly auth?: 'passphrase' | 'biometric'
  /** Enable encryption. Default: true. */
  readonly encrypt?: boolean
  /** Conflict resolution strategy. Default: 'version'. */
  readonly conflict?: ConflictStrategy
  /**
   * Sync scheduling policy. Controls when push/pull fire.
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
   * background-lock behavior. When supplied, replaces the
   * legacy `sessionTimeout` field.
   */
  readonly sessionPolicy?: SessionPolicy
  /**
   * Validate passphrase strength against the phrase format
   * (`@noy-db/hub` issue #7) on first-time keyring creation. When
   * `true`, weak phrases throw {@link WeakPassphraseError} from
   * `createNoydb()` / `db.rotatePassphrase()`. Default: `false` for
   * back-compat in v0.1.x; planned to flip to `true` at v1.0.
   */
  readonly validatePassphrase?: boolean
  /**
   * Vault-level policy gate document (issue #9). When present, the hub
   * persists the merged policy at `_meta/policy` on first-time vault
   * creation and gates sensitive operations (`db.rotatePassphrase`,
   * `db.export*`, …) against it. Omitted ⇒ the engine uses
   * {@link PERSONAL_POLICY}. Use {@link STRICT_POLICY} for regulated
   * deployments.
   *
   * The on-disk document is the source of truth — the policy field
   * is only honored at vault creation; subsequent runs read from
   * `_meta/policy`. Use `db.updatePolicy()` to change it deliberately.
   *
   * Imported from `@noy-db/hub` as a type-only reference; the runtime
   * import lives in `policy/index.ts`.
   */
  readonly policy?: VaultPolicy
  /**
   * Mandatory recovery profile enrollment (issue #10). Vaults with
   * `recover-passphrase` enabled MUST register at least one profile
   * before being production-ready, otherwise `createNoydb()` throws
   * {@link RecoveryNotEnrolledError}. Set
   * `policy.gates['recover-passphrase'].enabled = false` to
   * deliberately opt out of recovery (passphrase loss = data loss).
   *
   * v0.1.0-pre.5 supports the `'paper'` profile end-to-end. Other
   * profiles ship the API shape and throw
   * {@link RecoveryProfileNotImplementedError} during use.
   */
  readonly recovery?: ReadonlyArray<RecoveryEnrollment>
  /**
   * When `true`, `createNoydb` rejects vaults with no recovery
   * entries persisted (per the spec's mandatory-enrollment
   * requirement). Default `false` for v0.1.x back-compat; planned to
   * flip to `true` at v1.0. Apps in regulated environments should
   * turn this on now.
   */
  readonly requireRecovery?: boolean
  /**
   * What to do when `openVault` finds an existing keyring in the store that
   * cannot be decrypted with the supplied credentials (`InvalidKeyError`).
   *
   * - `'error'` (default) — propagate the error. The app must prompt the user
   *   to supply the correct credentials or clear both the data and auth stores.
   * - `'reset'` — delete the stale keyring and re-initialise the vault from
   *   scratch using the current credentials. Use this when the data store can
   *   become detached from the auth store (e.g. the user cleared the IndexedDB
   *   data records but not the keyring row, or a WebAuthn credential was rotated).
   *   **All previously encrypted data is unrecoverable after a reset.**
   *
   * Only applies to the passphrase (`secret`) path. When `getKeyring` is used,
   * the callback is responsible for handling stale-keyring detection itself.
   */
  readonly onInvalidKey?: 'error' | 'reset'
  /**
   * Enable the public envelope subsystem (`docs/subsystems/public-envelope.md`).
   * Pass `true` for the default schema (every standard field, 256 KB
   * icon cap, 200-char text cap), or a `PublicEnvelopeSchema` to
   * narrow what the owner can set. Off by default — vaults written
   * by hubs without this option carry no envelope, full stop.
   */
  readonly publicEnvelope?: true | PublicEnvelopeSchema
  /** Audit history configuration. */
  readonly history?: HistoryConfig
  /**
   * Consumer-supplied translation function for `i18nText` fields with
   * `autoTranslate: true`.
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

// ─── Bulk operations ──────────────────────────────────────

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
 * `atomic: true` switches the call from best-effort loop
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
