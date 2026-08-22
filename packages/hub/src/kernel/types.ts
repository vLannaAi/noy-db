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
import type { DeferredNumberingConfig } from '../with-commit/numbering/descriptor.js'
import type { SyncPolicy, ReadinessState, PushMode, PullMode } from './sync-policy.js'
import type { BlobsStrategy } from '../port/with/blob-strategy.js'
import type { ArchiveStrategy } from '../with-fork/archive/index.js'
import type { IndexingStrategy } from '../with-lookup/indexing/strategy.js'
import type { ReduceStrategy } from '../with-lookup/reduce/strategy.js'
import type { ConsentStrategy } from '../with-audit/consent/strategy.js'
import type { PeriodsStrategy } from '../with-audit/periods/strategy.js'
import type { ShadowStrategy } from '../with-fork/shadow/strategy.js'
import type { TransactionsStrategy } from '../with-commit/tx/strategy.js'
import type { HistoryStrategy } from '../with-commit/history/strategy.js'
import type { VaultHeadStrategy } from '../with-commit/vault-head/strategy.js'
import type { ForgetStrategy } from '../with-audit/forget/strategy.js'
import type { SnapshotsStrategy } from '../with-fork/snapshots/strategy.js'
import type { DerivationSkippedFrozen } from './via/dispatch.js'
import type { AttestationStrategy } from '../with-audit/attestation/strategy.js'
import type { ClassifiedStrategy } from '../port/with/classified-strategy.js'
import type { TiersStrategy } from '../with-audit/tiers/strategy.js'
import type { SealedRecordStrategy } from '../with-audit/sealed-record/strategy.js'
import type { PortabilityStrategy } from '../with-audit/portability/strategy.js'
import type { SequenceStrategy } from '../with-commit/sequence/strategy.js'
import type { CustodyStrategy } from '../with-party/custody/strategy.js'
import type { TeamStrategy } from '../port/with/team-strategy.js'
import type { BrokerStrategy } from '../port/with/broker-strategy.js'
import type { LazyStrategy } from '../port/with/lazy-strategy.js'
import type { SearchStrategy } from '../with-lookup/search/strategy.js'
import type { CargoStrategy } from '../with-cargo/strategy.js'
import type { Layer, I18nStrategy } from '../port/with/i18n-strategy.js'
import type { SessionStrategy } from '../with-party/session/strategy.js'
import type { SyncStrategy } from '../with-sync/strategy.js'
import type { GuardStrategyAny } from '../with-audit/guards/types.js'
import type { DerivationStrategy } from '../with-formula/derivations/types.js'
import type { UnlockedKeyring } from '../with-party/team/keyring.js'
import type { SecretPolicy, EchoSecretPolicy } from './validation.js'
import type { CoverSchema } from '../with-party/directory/cover/types.js'
import type { MaterializedViewStrategy } from '../with-formula/materialized-views/types.js'
import type { OverlayedViewStrategy } from '../with-formula/overlay-views/types.js'
import type { NoydbSealer, RecipientHint } from '../with-party/team/managed-secret.js'
import type { NoydbShamir } from '../with-party/team/noydb-shamir.js'
import type { ObjectProjection } from '../with-shape/blobs/object-projection.js'
import type { NoydbMesh } from '../port/by/types.js'
import type { ScriptWarning } from '../port/with/i18n-strategy.js'
import type { ViaDescriptor } from './via/index.js'
import type { EnclaveKey, EchoSecretParts } from './enclave/index.js'
import type { NoydbDeviceSeal } from '../port/with/device-seal-strategy.js'

export type { EchoSecretParts }

/** Format version for encrypted record envelopes. */
export const NOYDB_FORMAT_VERSION = 1 as const

/** Format version for keyring files. */
// Bumped 1 -> 2 (#1115): the roster tag now covers the DEK key SET, so a tag
// minted by an earlier version cannot verify under the current canonicalization.
// The field is plaintext and store-writable — it is read ONLY to choose the
// error MESSAGE, never the decision, which is "refuse" either way.
export const NOYDB_KEYRING_VERSION = 2 as const

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
 * | Role        | Collections      | Can grant/revoke | Can export |
 * |-------------|-----------------|:----------------:|:----------:|
 * | `owner`     | all (rw)        | Yes (all roles)  | Yes        |
 * | `admin`     | all (rw)        | Yes (≤ admin)    | Yes        |
 * | `custodian` | all (rw)        | No (see below)   | Yes        |
 * | `operator`  | explicit (rw)   | No               | ACL-scoped |
 * | `viewer`    | all (ro)        | No               | Yes        |
 * | `client`    | explicit (ro)   | No               | ACL-scoped |
 *
 * **`custodian` (FR-6 sovereign custody).** Operationally admin-rank —
 * rw + access on every collection, receives all collection DEKs on grant
 * — but is *provably non-owning*: it CANNOT grant, revoke, rotate keys,
 * destructively withdraw/sever, or extract-and-sever a partition (rotate is
 * blocked in `rotateKeys`, sever in `withdrawAccessibleData`, and extract in
 * `extractPartition`). Only the (sealed Deed) **owner** may
 * mint or remove a custodian; an admin cannot. This is the inalienability
 * floor — a custodian can run the vault day-to-day yet never escalate to
 * the owner credential.
 */
export type Role = 'owner' | 'admin' | 'custodian' | 'operator' | 'viewer' | 'client'

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
   * Opaque provenance source id — which party/registry wrote this version.
   * Unencrypted; present only when the collection opts into `provenance: true`
   * and a `source` is supplied to `put()`. Off by default (zero cost).
   */
  readonly _source?: string
  /** ISO-8601 timestamp the provenance source was recorded. Present alongside `_source`. */
  readonly _sourceTs?: string
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
  /**
   * Structural group-encryption. Map of sensitive field name →
   * per-field sealed ciphertext in `iv:data` form (same shape as a `_det`
   * slot). Present only when the collection declares `sensitive` fields and
   * at least one is present on the record. Each field is encrypted under its
   * own HKDF-derived per-field key (`deriveSealedFieldKey`, domain-separated
   * by `<collection>/sealed/<field>`), and is kept OUT of the open `_data`
   * blob — so a reader who can open `_data` still cannot see sealed fields
   * without re-deriving each field key. With no sensitive fields declared the
   * map is absent and `_data` is unchanged (byte-identical to legacy output).
   */
  readonly _sealed?: Record<string, string>
  /**
   * Verify-digest slots (classified stage 2). Map of digest-only field name →
   * AES-256-GCM `iv:data` blob sealed under the HKDF(CEK) vdig slot key with
   * AAD ['noydb-classify-vdig', collection, recordId, field]. The store sees
   * only ciphertext; only the enclave verify path can read the digest. At most
   * one of `_sealed[field]` / `_vdig[field]` exists per field (I4).
   */
  readonly _vdig?: Record<string, string>
  /**
   * Equatable blind-index tags (classified slice 2b). Map of digest-only field
   * name → base64 33-byte tag (1-byte cost/version discriminator ‖ 32-byte keyed
   * MAC), CURRENT VALUE ONLY (the _vdig ring is never indexed). This is the ONLY
   * store-visible classified artifact: a keyed MAC, comparable without a key
   * ceremony, with NO inline cryptographic integrity by construction. Invariant:
   * _bidx[field] present ⇒ _vdig[field] present. Confirm-by-verify (findByDigest)
   * makes any read-side orphan/splice unreturnable.
   */
  readonly _bidx?: Record<string, string>
  /**
   * Per-record content-encryption key (CEK), base64 AES-KW-wrapped under
   * the collection (or tier) DEK. Present only on records written by a
   * collection opened with `perRecordKeys: true`. When present, the body
   * (`_iv`/`_data`) is encrypted under the unwrapped CEK rather than the
   * collection DEK directly.
   *
   * Presence is the format discriminant: `_cek` absent → legacy body
   * keyed off the collection DEK (read unchanged); `_cek` present →
   * unwrap under the collection DEK, then decrypt the body under the CEK.
   *
   * The CEK is stable across every version of a record (insert mints it;
   * updates and history snapshots reuse it), so all `_history` envelopes
   * for a record carry the same `_cek`. This is the foundation for
   * per-record erasure and record-scoped sealing.
   *
   * `_det` slots are deliberately NOT keyed off the CEK — they remain
   * keyed to the collection DEK so blind-equality search keeps working
   * across records.
   */
  readonly _cek?: string
  /**
   * Debug-plaintext marker. Present only on records written by a vault opened
   * with `debugPlaintext: true` (which requires `encrypt: false`). When set,
   * the record's own fields are inlined as top-level keys on this envelope
   * (beside the reserved `_`-prefixed metadata) and `_data` is empty — so
   * native store tooling (jq, S3 console) reads the record directly. The read
   * path reconstructs the record from the non-`_` keys; the marker makes a
   * debug envelope self-describing, so a classic plaintext reader handles it too.
   */
  readonly _debug?: typeof NOYDB_FORMAT_VERSION
  /**
   * #589: this envelope is a delete marker (ordinary `collection.delete()` under
   * sync). Empty `_data`, no `_cek`, but version-ordered — a higher-`_v` re-create
   * resurrects the id. Distinct from a forget crypto-shred tombstone, which is
   * terminal. Reads treat it as absent.
   */
  readonly _del?: true
}

/** Spine policy for one digest-only classified field — the enclave-consumable
 *  projection of a ClassifiedFieldSpec (the enclave never imports with-*). */
export interface VdigFieldPolicy {
  readonly normalize: 'password' | 'secret-answer'
  /** Ring size for reuse refusal; 0 = no ring. Cap 8 (spec Q4). */
  readonly notLastN: number
  readonly rotateDays?: number
  /** default false — refused unless the double door is open (R8) */
  readonly equatable: boolean
}

/**
 * The persisted classified-fields config marker (C-A / R10). Reuses the
 * stage-2 persisted-schema record; this is the shape of the marker stored
 * there.
 */
export interface ClassifiedMarker {
  /** field names declared digest-only (have _vdig); non-empty ⇒ writes need the classified codec */
  readonly digestOnly: readonly string[]
  /** field names additionally declared equatable (have _bidx when covered) */
  readonly equatable: readonly string[]
  /**
   * Lifetime epoch (#597) — same shape/intent as `PairingMarker.epoch`
   * (`with-shape/satellites/types.ts`): an opaque, stable-per-collection-
   * lifetime stamp minted the first time this marker is persisted and
   * carried forward unchanged by an IDENTICAL re-persist for the SAME
   * collection (the equality fast path). NOTE: unlike `PairingMarker` (whose
   * R-S9 refuses divergent redeclares), a classified marker IS rewritten
   * wholesale on a genuine reconfiguration (changed digestOnly/equatable
   * set) — so the epoch re-stamps to the fresh value then (see
   * `config-drift.ts`'s `markerForFields`). Optional: markers persisted
   * before this field existed have none. Deliberately excluded from the
   * classified-marker equality check in
   * `with-shape/persisted-schemas/register.ts`. ADDITIVE ONLY today: no
   * delete-collection API exists yet, so a stale marker on a reused name is
   * unreachable; the epoch-MISMATCH rejection this would enable is a
   * deferred follow-up once name reuse is possible — whoever wires it must
   * first make reconfiguration carry the prior epoch forward.
   */
  readonly epoch?: string
}

/** Verdict-only egress of the enclave oracle (spec §3). */
export interface ClassifiedVerdict {
  readonly ok: boolean
  /** I1: present ONLY when ok === true — never computed for a false verdict. */
  readonly mustRotate?: true
}

/**
 * Opaque access gate for a sealed (`sensitive`) field returned by a public
 * read (the access layer). The handle carries only the per-field
 * **ciphertext** — the plaintext is never materialised into the working-set
 * cache. Call {@link Sealed.reveal} to decrypt the value on demand.
 *
 * A handle is intentionally NOT usable as `V`: it serialises to a non-leaking
 * marker (`JSON.stringify` / structured logging emit `'[sealed]'`, never the
 * value) and exposes no synchronous accessor.
 */
export interface Sealed<V> {
  /** Discriminant — always `true`, lets callers narrow a field to a handle. */
  readonly sealed: true
  /** Decrypt and return the underlying value. */
  reveal(): Promise<V>
}

/**
 * The shape a public read returns for a collection that declares `sensitive`
 * fields `S`: every sealed field becomes an opaque {@link Sealed} handle while
 * the rest of the record is unchanged. The `[S] extends [never]` guard collapses
 * `SealedView<T, never>` to exactly `T`, so collections with no sensitive fields
 * are unaffected — a plain `Omit<T, never>` is *not* a faithful identity for
 * generic intersection record types (it can degrade intersection-only members to
 * `unknown`), which would break consumers like the derivation/MV `_derivedFrom` /
 * `_materializedFrom` reads.
 */
export type SealedView<T, S extends keyof T> = [S] extends [never]
  ? T
  : Omit<T, S> & {
      readonly [K in S]: Sealed<T[K]>
    }

/**
 * The type of a field-name argument to the query/scan DSL (`where`, `orderBy`,
 * …) for a collection whose sealed (`sensitive`) fields are `S`.
 *
 * Guarded so the common case is unchanged: with **no** sensitive fields
 * (`S = never`) it is exactly `string` — collections that don't opt into
 * `sensitive` keep today's permissive DSL, zero churn. Once a field is
 * declared `sensitive`, the DSL narrows to the non-sensitive field names, so
 * `where('ssn', …)` becomes a compile error. TypeScript cannot subtract a
 * literal from `string`, so refusing a sensitive name necessarily means
 * narrowing to the known field-name union — this is intentional and only
 * affects collections that opted in.
 *
 * When `Q` (the indexed-field set) is given, `where()` is additionally
 * restricted to `Q` minus any sensitive fields — the escape hatch for
 * non-indexed filters is `scan()`. `Q = never` (the default) preserves the
 * existing 2-param behaviour exactly (zero churn).
 */
export type QueryField<T, S extends keyof T = never, Q extends keyof T & string = never> =
  [Q] extends [never]
    ? ([S] extends [never] ? string : Exclude<keyof T & string, S>)
    : Exclude<Q, S>

/**
 * The type of a field-name reference in a collection's index-declaration
 * options (`indexes`, `deterministicFields`, `textIndexes`). Same guarded
 * narrowing as {@link QueryField}: permissive `string` until a field is
 * declared `sensitive`, then the sensitive names are refused (a plaintext
 * secondary index over a sealed field defeats non-residency). Kept distinct
 * from `QueryField` so the two DSL surfaces can diverge later without coupling.
 *
 * When `Q` (the indexed-field set) is given, the `indexes` option is
 * additionally restricted to `Q` minus any sensitive fields — declaring `Q`
 * but listing a different field in `indexes` becomes a compile error.
 * `Q = never` (the default) preserves the existing 2-param behaviour.
 */
export type IndexFieldName<T, S extends keyof T = never, Q extends keyof T & string = never> =
  [Q] extends [never]
    ? ([S] extends [never] ? string : Exclude<keyof T & string, S>)
    : Exclude<Q, S>

/**
 * Generic form of the runtime `IndexDef` (see `indexing/eager-indexes.ts`)
 * parameterised by the allowed field-name set `F`. Used to refuse `sensitive`
 * fields in the `indexes` collection option at compile time while leaving the
 * runtime `IndexDef` (string-based) untouched. `IndexDefFor<string>` is
 * structurally identical to `IndexDef`, which is why `vault.collection` can cast
 * the narrowed public option to `IndexDef[]` at the runtime boundary (through
 * `unknown`, solely to drop the `readonly`).
 * **Keep this in sync with `IndexDef`** — if `IndexDef` gains a new union member,
 * add it here too, or that boundary cast will silently admit shapes the runtime
 * machinery does not narrow.
 */
export type IndexDefFor<F extends string> =
  | F
  | { readonly fields: readonly F[]; readonly unique?: boolean }
  | readonly F[]

/**
 * The type of the `sensitive` collection option, conditional on whether the
 * caller opted into compile-time refusal via an explicit second generic.
 * With no 2nd generic (`S = never`) it accepts any field array — runtime
 * sealing only, no compile refusal, non-breaking. With `S` given, it is
 * `readonly S[]`, which ties the runtime array to the declared sensitive
 * union so the two cannot drift.
 */
export type SensitiveOpt<T, S extends keyof T> = [S] extends [never]
  ? readonly (keyof T & string)[]
  : readonly S[]

/**
 * The type of the `moneyFields` collection option, conditional on whether the
 * caller opted into compile-time money-field typing via the 4th generic `M`.
 * Typed against the opaque {@link ViaDescriptor} marker rather than the
 * concrete `MoneyDescriptor` — the kernel never inspects a Via feature's
 * descriptor shape, only its declaring service does.
 * A `money()` descriptor structurally satisfies `ViaDescriptor` (it carries
 * `_viaBrand: 'money'`), so this stays publicly assignable from `money()`
 * call sites. With no `M` (`M = never`) it accepts any
 * `Record<string, ViaDescriptor>` — runtime money only, no compile-level
 * narrowing, non-breaking. With `M` given, it is `Record<M, ViaDescriptor>`,
 * tying the runtime map to the declared money-field union so the two cannot
 * drift.
 */
export type MoneyFieldsOpt<T, M extends keyof T & string = never> =
  [M] extends [never] ? Record<string, ViaDescriptor> : Record<M, ViaDescriptor>

/**
 * Concrete {@link Sealed} handle. Holds the reveal closure (which captures the
 * field's ciphertext blob and the unseal routine) in a private field, so it is
 * invisible to `JSON.stringify`, `util.inspect`, and `Object.keys`. `toJSON`
 * returns the marker `'[sealed]'` — a handle can never leak its value through
 * serialisation or logging because the plaintext is not stored on it at all.
 */
export class SealedHandle<V> implements Sealed<V> {
  readonly sealed = true as const
  readonly #reveal: () => Promise<V>

  constructor(reveal: () => Promise<V>) {
    this.#reveal = reveal
  }

  reveal(): Promise<V> {
    return this.#reveal()
  }

  /** Non-leaking serialisation marker — never the underlying value. */
  toJSON(): string {
    return '[sealed]'
  }
}

/**
 * Handover-capable provider. Implemented additionally by asymmetric/granted
 * providers (cloud-KMS asymmetric, Azure RSA Key Vault, AWS KMS with grant).
 * Self-only providers (macOS Keychain, env-var, WebAuthn-PRF) do NOT
 * implement this — the §11.2 capability matrix lives in the type system.
 *
 * Per foundation §11.4. A function that requires recipient-target sealing
 * takes `RecipientSealer`, not `NoydbSealer` — the compiler rejects
 * passing a self-only provider at the spec site.
 */
export interface RecipientSealer {
  readonly id: string
  /** Produce hint material a sender uses to seal-for-this-recipient. */
  publishRecipientHint(): Promise<RecipientHint>
  /**
   * Seal plaintext for the recipient described by `hint`. Returns opaque
   * bytes — same contract as `NoydbSealer.seal()`. The bundle
   * layer base64-encodes the bytes into `SealedAutoUnlockEntry.sealed`
   * without inspecting them.
   */
  sealForRecipient(plaintext: Uint8Array, hint: RecipientHint): Promise<Uint8Array>
}

/**
 * Thin delivery envelope persisted at
 * `_sealed_cek/<collection>/<id>/<pid>`. The grantor writes one per
 * (record, recipient host) pair. `payload` is the base64 of the bytes returned
 * by {@link RecipientSealer.sealForRecipient} over a UTF-8
 * `JSON.stringify({@link SealedCekBinding})`.
 *
 * `expiresAt` is duplicated here for a cheap pre-unseal reject, but is NOT
 * authoritative — the binding inside `payload` carries the expiry the host
 * verifies after unsealing, so a tampered delivery envelope cannot extend a
 * grant.
 */
export interface SealedCekDeliveryEnvelope {
  /** Envelope schema version. */
  readonly v: 1
  /** Magic marker for forensics + format detection. */
  readonly _noydb_sealed_cek: 1
  /** Recipient host provider id; matches the sealer's `.id` / hint `pid`. */
  readonly pid: string
  /** base64 of the sealed {@link SealedCekBinding} bytes. */
  readonly payload: string
  /** Fast-path expiry hint (ISO 8601). Authoritative copy is inside `payload`. */
  readonly expiresAt: string
}

/**
 * The plaintext struct sealed for the recipient host. After the host unseals
 * `SealedCekDeliveryEnvelope.payload` it parses this and MUST verify:
 *  - `collection` + `id` match the record envelope it is decrypting, and
 *  - `expiresAt` has not passed (authoritative expiry check).
 *
 * `cek` is the base64 of the raw 32-byte AES-256-GCM record CEK.
 */
export interface SealedCekBinding {
  /** Collection the CEK belongs to. */
  readonly collection: string
  /** Record id the CEK belongs to. */
  readonly id: string
  /** base64 of the raw AES-256-GCM CEK bytes. */
  readonly cek: string
  /** Authoritative expiry (ISO 8601). */
  readonly expiresAt: string
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

  /**
   * Optional declared store capabilities (CAS atomicity, native tx, blob
   * size limits, auth). Consumers that require a capability — e.g.
   * `vault.sequence().next()` needs `casAtomic` — read it here.
   */
  capabilities?: StoreCapabilities

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
   * The store's authoritative time as a bounded-uncertainty interval.
   * Present iff `capabilities.serverWriteTime` is true. Monotonic
   * non-decreasing across calls on a single store.
   */
  getStoreTime?(): Promise<StoreTime>

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
   * `runTransaction` for the exact semantics and crash window). The
   * hub also falls back when the staged batch isn't statically safe
   * to submit as one write set — see `canCommitAtomically`.
   *
   * Native implementations today: `to-memory` (one synchronous burst of
   * Map mutations) and the SQL-backed stores in the sibling `noy-db-to`
   * repo. `to-dynamo` (`TransactWriteItems`) and `to-browser-idb` (one
   * `readwrite` transaction) CAN implement it but do not yet. File / S3
   * cannot implement it atomically and should omit the method.
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
 * model is declared further down in this file (#9), see {@link VaultPolicy}.
 * Declared here as an `unknown`-typed map (rather than `VaultPolicy` itself)
 * so the `KeyringFile.policy` field can still round-trip foreign/older
 * documents that don't strictly satisfy the current shape.
 *
 * @internal
 */
export type VaultPolicyOnDisk = Record<string, unknown>

/**
 * Recovery profile enrolled at vault creation.
 *
 * - `paper` — `on-recovery` codes (the standard end-to-end profile).
 * - `shamir` / `multi-channel` / `admin-mediated` — API surface ships;
 *   per-profile dispatch lands in follow-up issues. Calling
 *   `db.recoverSecret` against these throws
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
 * @see https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/services/session-tiers.md → Tier 2 — Authenticate (multi-slot)
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
 * `wrapKind` is optional/absent on older slots — those
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
 * (sensitive ops like `enrollAuthenticator` / `rotateSecret`
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

/**
 * Echo-secret (3-part ceremony) declaration on a keyring — spec
 * design-history/2026-08-02-echo-secret-design.md (#940).
 * Optional / append-only: keyrings written before the extension (or
 * using standard/managed modes) simply lack it.
 */
export interface KeyringEchoBlock {
  readonly v: 1
  /** Salt + AES-KW verifier gating the reveal on the typed prompt (600K PBKDF2). */
  readonly prompt_salt: string
  readonly prompt_verifier: string
  /** Salt + AES-KW verifier for a TYPED echo (degraded path). */
  readonly echo_salt: string
  readonly echo_verifier: string
  /** Hybrid reveal policy (spec decision 4). */
  readonly reveal:
    | { readonly kind: 'portable'; readonly blob: string; readonly iv: string; readonly salt: string }
    | { readonly kind: 'sealed'; readonly blob: string; readonly provider_hint: string }
    | { readonly kind: 'none' }
  /** Optional display-masking hint — pure player-UI concern. */
  readonly mask_hint?: string
}

export interface KeyringFile {
  readonly _noydb_keyring: typeof NOYDB_KEYRING_VERSION
  readonly user_id: string
  readonly display_name: string
  readonly role: Role
  readonly permissions: Permissions
  readonly deks: Record<string, string>
  /**
   * DEKs for a rotation that has STARTED but not committed (#1074).
   *
   * `rotateKeys` persists the new DEK here *before* rewriting any record, so an
   * interruption can never strand records under a key that was only ever in
   * memory. On commit these move into `deks` and this is cleared.
   *
   * Present on disk ⇒ a rotation was interrupted and the collection may hold
   * records on both sides of the migration. Re-running `rotateKeys` resumes
   * with this key rather than minting a fresh one.
   *
   * Optional: absent on every keyring written before this existed, and absent
   * in the normal committed state.
   */
  readonly pending_deks?: Record<string, string>
  readonly salt: string
  readonly created_at: string
  readonly granted_by: string
  /**
   * Secret canary — base64 AES-KW-wrapped form of a known constant
   * 256-bit value, wrapped under the keyring's KEK.
   *
   * Lets `loadKeyring` distinguish wrong-secret from corruption even when
   * ALL DEKs (including a single-DEK keyring's sole DEK) are corrupted: the
   * canary unwrapping proves the KEK correct independent of any DEK byte.
   *
   * AES-KW is deterministic — every write site mints fresh on each
   * persist; same KEK + same constant input always produces the same
   * ciphertext, so this round-trips without state.
   *
   * REQUIRED as of #1096 (no-legacy policy): the pre-canary fallback
   * heuristic is deleted, so an absent canary is not an old file, it is a
   * store that stripped the field — `KeyringTamperedError('canary-missing')`.
   */
  readonly canary: string
  /**
   * #1096 — AES-GCM({iv,data}) of the canonical authority fields
   * (user_id, role, permissions, granted_by, expires_at, capabilities)
   * under the vault roster key (carried as `deks[ROSTER_KEY_ID]`).
   * Required: a valid canary with a missing or mismatching tag is refused
   * as KeyringTamperedError — absence must itself be an error, or a store
   * opts out of verification by deleting a plaintext field.
   */
  readonly roster_tag: { readonly iv: string; readonly data: string }
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
   * meaningful for `PodRecipient` slots produced by
   * `writePod({ recipients: [...] })`. Setting it on a live
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
  /**
   * Echo-secret (3-part ceremony) declaration. Absent for keyrings
   * using standard/managed mode, or written before this extension.
   */
  readonly echo?: KeyringEchoBlock
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
   * Export locale (BCP 47, e.g. `'th'`). When set, records are read at this
   * locale through the **`export` layer**: `i18nText` fields collapse to
   * the locale string (honoring each field's `export`-layer `onMissing` policy)
   * and `dictKey`/`staticDict` `<field>Label`s are resolved — a single-locale
   * export. The raw `dictionaries` snapshot is then redundant and omitted. This
   * applies to BOTH `exportStream()` and `exportJSON()`.
   *
   * Default: `undefined` — raw `{locale}` maps + the `_dictionaries` snapshot
   * (a full, all-locale backup; format packages apply their own locale strategy).
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
 * #590: sync suppressed a live envelope because a crypto-shred tombstone is
 * terminal for its record id. Reported on push/pull results (`erasures`) and
 * via the `'sync:erasure'` event; conflict resolvers are never consulted for
 * tombstone pairs.
 */
export interface ErasureEnforcement {
  readonly vault: string
  readonly collection: string
  readonly id: string
  /** The winning tombstone (as stored after enforcement). */
  readonly tombstone: EncryptedEnvelope
  /** The live envelope that lost: a suppressed dirty local edit, or the remote copy destroyed by re-assertion. */
  readonly suppressed: EncryptedEnvelope
  readonly direction: 'pull' | 'push'
}

/**
 * A same-device cross-tab write conflict: another tab overwrote a
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
 *
 * **Delete-vs-edit caveat:** `'last-writer-wins'`, `'first-writer-wins'`,
 * and `'manual'` compare/hand over raw envelopes, so an edit CAN win over
 * a delete marker (a later `_ts`, an earlier `_v`, or the app's own
 * `resolve()` choice). A custom fn, and the CRDT merge modes `'lww-map'`/
 * `'rga'` (`crdtStrategy`), CANNOT: their shared resolver wrapper decrypts
 * both sides first and short-circuits to whichever side is the
 * shredded/tombstoned one *before* the merge function (or CRDT merge)
 * ever runs — delete unconditionally wins. CRDT mode `'yjs'` is the
 * exception among CRDT modes: it never decrypts and falls back to a
 * plain higher-`_v`-wins compare, so an edit can beat a delete there too.
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
  /**
   * #807 — period-scoped pull (thin-client bootstrap). `{ current: true }`
   * pulls only records at-or-after the latest closed period's boundary;
   * an array of closed-period names backfills exactly those periods'
   * windows. Membership is by envelope write-time `_ts` (the freeze/
   * archive store-tier law — the engine never sees business dates).
   *
   * Never filtered regardless of this option: the `_periods` summaries +
   * companions (always pulled first — the navigation index), delete
   * markers/tombstones (the #589/#590 convergence law), and reserved
   * lookup collections. Composes with `collections` as an intersection.
   * Requires the periods service (`periodsStrategy: withPeriods()`) to
   * resolve windows once the vault holds `_periods` records. Push is
   * never period-filtered.
   */
  periods?: string[] | { current: true }
}

export interface PushResult {
  readonly pushed: number
  readonly conflicts: Conflict[]
  readonly errors: Error[]
  /** #590: tombstone enforcements applied during this run (never resolver-visible). */
  readonly erasures?: ErasureEnforcement[]
}

export interface PullResult {
  readonly pulled: number
  readonly conflicts: Conflict[]
  readonly errors: Error[]
  /** #590: tombstone enforcements applied during this run (never resolver-visible). */
  readonly erasures?: ErasureEnforcement[]
  /**
   * #807: present on period-scoped pulls only — per-phase KPI counters
   * (`summaries` = the `_periods` navigation index + companions; `records`
   * = everything after it). `records`/`bytes` count envelopes applied to
   * the local store; `bytes` approximates ciphertext payload size
   * (`_data` + `_iv` length), for bounding a first sync's download budget.
   */
  readonly phases?: {
    readonly summaries: { readonly records: number; readonly bytes: number }
    readonly records: { readonly records: number; readonly bytes: number }
  }
}

/** Result of a sync transaction commit. */
export interface SyncTransactionResult {
  readonly status: 'committed' | 'conflict'
  readonly pushed: number
  readonly conflicts: Conflict[]
  /** #590: staged writes suppressed by tombstone enforcement during commit. */
  readonly erasures?: ErasureEnforcement[]
}

export interface SyncStatus {
  readonly dirty: number
  /**
   * ISO 8601 timestamp of the last push that completed with **no errors**, or
   * `null` if none ever has (#1036). A failed attempt does not advance it — so
   * this answers "when did my data last reach the remote?", which is the reading
   * the name invites and the one the field previously did not honour.
   */
  readonly lastPush: string | null
  /** As {@link SyncStatus.lastPush}, for pulls: last pull that had no errors. */
  readonly lastPull: string | null
  /**
   * Whether the **browser** reports network connectivity — driven solely by the
   * global `online`/`offline` events (#1034). It is NOT target reachability: an
   * unreachable store never flips it, and losing Wi-Fi flips it for every target
   * at once. To detect a failing target, read {@link SyncStatus.lastError}.
   */
  readonly online: boolean
  /**
   * The failure that ended the most recent push/pull, cleared by the next
   * success (#1036). **Absent** when nothing has failed since the last success —
   * so `lastPush: null` with no `lastError` means "never synced", while
   * `lastPush` set plus a `lastError` means "synced then, failing since".
   *
   * Live state, not persisted: a reload cannot know whether the target still
   * fails, so it starts absent until the next attempt says otherwise.
   */
  readonly lastError?: {
    /** ISO 8601 timestamp of the failed attempt. */
    readonly at: string
    readonly op: 'push' | 'pull'
    /** Message of the first error the attempt collected. */
    readonly message: string
  }
  /**
   * Per-collection readiness under a `'phased'` pull policy (#809). **Absent**
   * for every other policy, and a collection the sequence never names is absent
   * from the map — `undefined` means *"no claim made"*, never a reason to gate
   * a UI. Only `'live'` asserts that a miss from `get()` is a real absence.
   */
  readonly readiness?: ReadonlyMap<string, ReadinessState>
  /** 1-based position in the phased sequence; `null` once it has drained. */
  readonly phase?: { readonly index: number; readonly total: number } | null
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
  /**
   * Per-target sync policy. Inherits the store-category default when absent —
   * but only a *declared* policy starts automation (#897), so a target with no
   * `policy` and no instance-level `syncPolicy` syncs on explicit calls only.
   */
  readonly policy?: SyncPolicy
  /** Human-readable label for DevTools and audit logs. */
  readonly label?: string
}

/**
 * Introspection view of a wired sync target, returned by `Noydb.listSyncTargets()`
 * (#948). Deliberately omits any preset *name* — a resolved `SyncPolicy` doesn't
 * retain which preset (if any) it came from, so only its push/pull mode is surfaced.
 */
/**
 * Per-target sync state (#1034). `syncStatus()` answers for the vault as a
 * whole; this answers per target, which is what a redundant topology needs in
 * order to say "the LAN store is unavailable — syncing via the cloud" rather
 * than just "something is wrong".
 *
 * Deliberately carries **no `online` flag.** `SyncStatus.online` reflects the
 * *browser's* global connectivity — it is set only by the `online`/`offline`
 * window events and no store outcome ever changes it, so every engine flips at
 * once for the same reason. Exposing it per target would make a global signal
 * look per-target: a status list would appear to update row by row while every
 * row actually moved together. Per-target *reachability* derived from real
 * store outcomes is a separate, still-unbuilt thing.
 */
export interface SyncTargetStatus {
  /** As registered. `undefined` when the target was declared without one. */
  readonly label: string | undefined
  readonly role: SyncTargetRole
  /** Pending local writes for this target. */
  readonly dirty: number
  /** Last push that completed with no errors, or `null`. See {@link SyncStatus.lastPush}. */
  readonly lastPush: string | null
  /** Last pull that completed with no errors, or `null`. */
  readonly lastPull: string | null
  /**
   * Nothing queued for this target — `dirty === 0`.
   *
   * Well-defined for every role: for a `sync-peer` it means the two sides
   * agree as of the last exchange; for a push-only `backup` it means every
   * local write has reached it. It is a statement about the *outbound* queue
   * only, and says nothing about whether the target holds data this client has
   * not pulled.
   */
  readonly caughtUp: boolean
}

export interface SyncTargetInfo {
  readonly label: string | undefined
  readonly role: SyncTargetRole
  readonly policy: {
    readonly push: { readonly mode: PushMode }
    readonly pull: { readonly mode: PullMode }
  } | undefined
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
   * Same-instance signal that this vault's schema-fence state changed.
   * For UI integration. Cross-client coordination goes
   * through the store, not this event.
   */
  'schema:fence-changed': { vault: string; currentSchemaVersion: number; fenceState: 'normal' | 'draining' | 'migrating' | 'complete' }
  'sync:push': PushResult
  'sync:pull': PullResult
  'sync:erasure': ErasureEnforcement
  'sync:conflict': Conflict
  'write:conflict': WriteConflict
  'sync:online': void
  'sync:offline': void
  'sync:backup-error': { vault: string; target: string; error: Error }
  'history:save': { vault: string; collection: string; id: string; version: number }
  'history:prune': { vault: string; collection: string; id: string; pruned: number }
  /**
   * A non-fatal i18n script violation under `onScriptViolation: 'warn' | 'filter'`.
   * 'warn' stored the value as-is; 'filter' stripped disallowed characters
   * (the event is the only signal the stored data was mutated). 'reject'
   * throws `ScriptViolationError` and emits nothing.
   */
  'i18n:script-violation': {
    vault: string
    collection: string
    id: string
    mode: 'warn' | 'filter'
    warning: ScriptWarning
  }
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
  /**
   * #638 Task 5 — a dispatch-driven derivation/rollup/MV output write targeted a row whose
   * period is closed. The write is SKIPPED (the historical value stands); the SOURCE write
   * that triggered the recompute still succeeded. See `kernel/via/dispatch.ts#putDerivedOutput`.
   * `source.id` may be a non-record sentinel (e.g. `'refreshView'`) for manual bulk-refresh-
   * triggered skips, not a real source record id.
   */
  'derivation:skipped-frozen': DerivationSkippedFrozen
  /**
   * #654 — an ordinary-delete lookup-ref `cascade`/`nullify` propagation edge whose compare-key
   * could not be resolved from the backing row (matrix custom-key row unreadable — corruption
   * class). The delete itself proceeds (only `restrict` edges fail closed, via
   * `RestrictRefUnresolvableError`); this edge's propagation is skipped and reported here instead
   * of silently dropped — the ordinary-delete counterpart of the forget path's
   * `ForgetResult.lookupReferencesResidue` channel. `residue` entries are `backing:key:
   * collection.field`, one per un-propagated edge (see `VaultLinks.applyLookupRefsPropagation`).
   */
  'lookup:propagation-residue': { vault: string; dimension: string; key: string; residue: readonly string[] }
  /**
   * #640 rider (#644 item 3) — the sync/cutover/restore dispatch wave's per-id recompute failed
   * (a genuine decrypt failure, a derive()/executor bug, a schema violation on the output, ...).
   * ADDITIVE to the existing `console.warn` in `runGraphDispatchWave` — never replaces it, so no
   * listener-dependent silence. One event per failed (collection, id); the wave still isolates
   * the failure to just that one record. See `kernel/via/dispatch.ts#runGraphDispatchWave`.
   */
  'derivation:wave-error': { collection: string; id: string; error: unknown }
}

// ─── Grant / Revoke ────────────────────────────────────────────────────

export interface GrantOptions {
  readonly userId: string
  readonly displayName: string
  readonly role: Role
  readonly secret: string
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
   * `SecretPolicy`. Test fixtures and CLI scripts pass `true`.
   */
  readonly allowWeakSecret?: boolean
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
   * @see design-history/2026-05-05-user-envelope-design.md → Lifecycle
   */
  readonly initialProfile?: unknown
}

/**
 * Caller payload for `db.updateUser`. Mutate one or more
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
 * the `null`-as-clear convention `UserApi.updateMe` uses.
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
 */
export interface UpdateUserOptions {
  readonly userId: string
  readonly role?: Role
  readonly displayName?: string | null
  readonly permissions?: Permissions
}

export interface RevokeOptions {
  readonly userId: string

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
  /**
   * Open shards non-creatingly — a missing grant throws instead of
   * self-provisioning. Default: `true` (create iff the vault has no
   * `_keyring/*`). Pass `false` for strict open-existing semantics
   * (e.g. federation read fan-out where shards are pre-provisioned
   * and an absent grant should fail closed).
   */
  readonly create?: boolean
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
   * secret or perform a fresh WebAuthn assertion) before proceeding,
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
  /**
   * @internal — the resolution layer this read belongs to (`'read'` by
   * default). Threaded by layer-tagged read facades (guard / derivation)
   * so `applyI18nLocale` and dictKey `resolvePolicy` select that layer's
   * `onMissing` policy instead of the `'read'` policy. Not part of the
   * public read API — callers select policy via the field's `onMissing`
   * map, not by setting this.
   */
  readonly _layer?: Layer
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

/** Per-collection CRDT mode. */
export type CrdtMode = 'lww-map' | 'rga' | 'yjs'

// Hoisted from with-commit/crdt/crdt.ts (C3 — #667: breaks the
// types.ts ↔ crdt.ts cycle by making crdt.ts's re-export of these
// three types leaf-ward only). crdt.ts re-exports them from here so
// existing importers of that module are unaffected.

/**
 * Per-field last-write-wins registers.
 * Each field carries its latest value and the ISO timestamp of the last write.
 * Merge: for each field, keep the entry with the lexicographically higher `ts`.
 */
export interface LwwMapState {
  readonly _crdt: 'lww-map'
  readonly fields: Record<string, { readonly v: unknown; readonly ts: string }>
}

/**
 * Simplified Replicated Growable Array.
 * Items are assigned stable NID (noy-db id) strings on first insertion.
 * Deleted items are tracked as tombstones so concurrent removals commute.
 *
 * The resolved snapshot is the ordered list of non-tombstoned `v` values.
 */
export interface RgaState {
  readonly _crdt: 'rga'
  readonly items: ReadonlyArray<{ readonly nid: string; readonly v: unknown }>
  readonly tombstones: readonly string[]
}

/**
 * Yjs binary state marker. `update` is base64(Y.encodeStateAsUpdate()).
 * Core stores and retrieves the blob opaquely. `@noy-db/yjs` is responsible
 * for encoding, decoding, and merging via `Y.mergeUpdates`.
 * Core falls back to last-write-wins (higher `_v`) for conflict resolution.
 */
export interface YjsState {
  readonly _crdt: 'yjs'
  /** base64-encoded Y.encodeStateAsUpdate() bytes. */
  readonly update: string
}

export type CrdtState = LwwMapState | RgaState | YjsState

/**
 * Seam interface. `@internal`.
 *
 * @internal
 */
export interface CrdtStrategy {
  buildLwwMapState(
    record: Record<string, unknown>,
    previous: LwwMapState | undefined,
    now: string,
  ): LwwMapState
  buildRgaState(
    items: readonly unknown[],
    previous: RgaState | undefined,
    idGen: () => string,
  ): RgaState
  mergeCrdtStates(local: CrdtState, remote: CrdtState): CrdtState
  resolveCrdtSnapshot(state: CrdtState): unknown
}

// ─── Blob / Attachment Store ────────────────────────

/**
 * Second store shape for blob-store backends (Drive, WebDAV, Git, iCloud)
 * that operate on whole-vault bundles rather than per-record KV.
 *
 * Implement `readBundle` / `writeBundle` instead of the six-method KV
 * contract. Use `wrapPodStore()` from `@noy-db/hub` to convert to a
 * `NoydbStore` that the rest of the API consumes transparently.
 *
 * Named `NoydbPodStore` for consistency
 * with the hub / to-* / in-* rename. Concrete implementations ship
 * in `@noy-db/to-*` packages starting in.
 */
export interface NoydbPodStore {
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
   * past `expectedVersion` — throw `PodVersionConflictError`.
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
   * Base64 AES-KW-wrapped per-blob **content CEK** (wrapped under the `_blob`
   * DEK). Present on erasable-collection blobs (`perRecordKeys`): the chunks
   * are encrypted under this content CEK rather than directly under the `_blob`
   * DEK, so deleting this BlobObject at `refCount → 0` crypto-shreds the chunks
   * (they become permanently undecryptable). Absent → legacy blob, chunks
   * decrypt directly under the `_blob` DEK (read unchanged). See
   * design-history/2026-06-13-per-blob-cek-design.md.
   */
  readonly _cek?: string
  /**
   * Transient migration marker. Present only while a legacy
   * blob is being migrated to a content CEK: it holds the wrapped content CEK
   * BEFORE the chunks have been re-encrypted under it. Readers **ignore**
   * `_cekPending` (they key off `_cek`), so the blob stays readable under the
   * `_blob` DEK during migration AND the content CEK survives a crash → a
   * re-run resumes and promotes `_cekPending` → `_cek`. Never set on a settled blob.
   */
  readonly _cekPending?: string
  /**
   * Hint indicating which store holds the chunk data.
   * Used by `routeStore` size-tiered routing: `'default'` for small blobs
   * stored inline (e.g. DynamoDB), `'blobs'` for large blobs in the overflow
   * store (e.g. S3). Absent when no routing is configured.
   */
  readonly storeHint?: 'default' | 'blobs'
  /**
   * Bounded ring (K=8 — an AUDIT-VISIBLE concurrency bound, not an
   * implementation detail) of the most recent op-stamp identities applied to
   * this object's `refCount`. Appended in the SAME CAS write as the
   * `refCount` change it stamps (`BlobSet`'s `casUpdateRefCountStamped`),
   * never a separate write — no crash window between the two. Oldest entry
   * is evicted once the ring exceeds K entries.
   *
   * The blob durability journal (#753, spec §7 C2/C4) uses membership here
   * as its test-and-set: a stamped mutator re-reads this ring on every CAS
   * attempt (including retries) BEFORE computing its delta — stamp already
   * present → that mutation already landed → skip re-applying it. This is
   * what makes a crash-resumed refCount decrement/increment exactly-once
   * rather than at-least-once.
   *
   * Two acceptances, by design — SHRED only (see the #746 whole-branch
   * review correction below for rehome):
   *  - **Eviction beyond K, for SHRED.** More than 8 distinct in-flight
   *    stamped operations racing the SAME object between reads is far
   *    outside any expected co-ownership fan-out; a 9th racer whose stamp
   *    gets evicted before it re-reads can only double-apply an idempotent
   *    CAS delta — never silently lose one (the DECREMENT delta is bounded
   *    by the marker's authoritative captured `hold.n`, applied as ONE CAS
   *    per eTag — never per-row — so eviction has nothing row-scoped to
   *    re-apply against). Not a data-loss risk for shred, just a documented
   *    concurrency bound.
   *  - **Stale stamps on a retained object.** A `retainedShared` object (one
   *    reference released, others still live) keeps whatever stamp its last
   *    CAS write appended even after that operation's marker is gone —
   *    harmless bookkeeping, not crypto material (unlike `_cek`), that sits
   *    inert until the object's next CAS write evicts or overwrites it.
   *
   * **#746 whole-branch review correction — this ring is NOT the sole
   * idempotency source for REHOME.** Rehome's destination `+1`s are
   * ROW-SCOPED (`${opId}:${slotName}` / `${opId}:${versionKey}`, one stamp
   * PER CONTRIBUTING ROW, not one per eTag). Within a SINGLE op this ring is
   * sufficient — rows are processed sequentially and each row's referencing
   * update lands before the next row's `+1`, so a row whose stamp is later
   * evicted is already seen as "moved" (skipped) on resume, never
   * re-incremented. The genuine over-count is **concurrent independent ops**
   * (distinct `opId`s) converging on one shared destination: ≥8 of them can
   * evict a crashed op's row-stamp before it resumes, and a naive ring-only
   * resume would then double-apply that row's `+1` — a real, silent,
   * permanent-leak over-count, not merely eviction-tolerant like shred's.
   * `BlobIntent.appliedStamps` (`blob-intent.ts`) is rehome's ring-INDEPENDENT
   * backstop: an unbounded, per-op, per-record log of confirmed row-stamps,
   * consulted BEFORE this ring on every resume (see
   * `BlobSet.applyStampedIncrement`). This ring stays the fast first-line
   * check; `appliedStamps` makes correctness independent of ring eviction
   * **except** in one intrinsic non-atomic window: the destination `+1`/ring
   * write (A) and the `appliedStamps` append (B) are separate object writes,
   * A before B (deliberately — B-first could under-count and crypto-shred a
   * still-referenced object, i.e. data loss, strictly worse than a
   * retained-too-long leak). A crash BETWEEN A and B followed by ≥8 concurrent
   * evictions before resume can still over-count. This window is intrinsic
   * (rehome, unlike shred, cannot pre-capture destinations at mint time) and
   * fail-safe-directed; it is a documented residual (see the arc changeset).
   */
  readonly lastOps?: readonly string[]
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
  /**
   * Reference to the `BlobObject` in `_blob_index` (chunk-based blobs).
   * Empty string (`''`) for an `external` slot, whose bytes live in the
   * `ObjectProjection` rather than `_blob_chunks` — read `external` instead.
   */
  readonly eTag: string
  /**
   * External-projection reference. Present when the blob field is declared
   * `external`: the raw bytes live in the vault's `ObjectProjection` at `key`
   * (unencrypted), not in `_blob_chunks`. This slot record (in the encrypted
   * collection) remains the catalog entry — the anchoring invariant.
   */
  readonly external?: {
    readonly key: string
    readonly contentType?: string
    readonly public?: boolean
    /** Opaque-token backlink stamped on the object (when `backlink:'opaque-token'`). */
    readonly backlink?: string
    /**
     * Secondary metadata store synced from the object / its processing pipeline
     * (e.g. video `duration`, image `width`/`height`, arbitrary metatags).
     * Populated via `BlobSet.setExternalMeta()` — typically an AWS-side callback.
     */
    readonly meta?: Record<string, unknown>
  }
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
  /**
   * Internal rehome-journal bookkeeping (#746 spec §7 review, carried
   * finding (b)) — NEVER part of the public `list()`/`SlotInfo` contract
   * (`BlobSet.list()` filters it out explicitly). Set, in the SAME CAS
   * write that points this slot at its new (rehomed) eTag, to the OLD eTag
   * still awaiting its refCount release: `putUnderDEK`'s slot-CAS and its
   * old-eTag release are two separate writes, and a crash between them
   * would otherwise lose the only record of which object still needs
   * releasing (the slot map itself has already moved past it) — a
   * permanent stranded-refcount leak. Cleared once the release lands.
   * Only ever set under a marker-governed (stamped) rehome; absent on
   * every ordinary `put()`.
   */
  readonly pendingRelease?: string
}

/** Result of `BlobSet.list()` — slot record plus its named slot key. */
export interface SlotInfo extends SlotRecord {
  /** The slot name (key in the record's slot map). */
  readonly name: string
  /**
   * DEVICE-LOCAL (#808): slot is pinned for offline on THIS device. Read from
   * the `withBlobs()` pin registry at list time — never stored in (or synced
   * through) the vault store; present only when `true`. Pinned slots are
   * exempt from `vault.compact()` eviction and the cache-budget pass.
   */
  readonly pinned?: boolean
  /**
   * DEVICE-LOCAL (#808): ISO timestamp of the last local read of this slot on
   * this device — the LRU input for `vault.compact({ cacheBudget })`. Absent
   * when the slot was never read here (the budget pass falls back to
   * `uploadedAt`).
   */
  readonly lastAccessAt?: string
  /**
   * DEVICE-LOCAL (#808): byte size of the local encrypted side-cache copy of
   * an `external` slot on this device (see `BlobPinEntry.cipher`). Absent for
   * internal slots and for external slots with no local copy.
   */
  readonly cachedBytes?: number
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
  /**
   * User-visible filename to store on the slot. Defaults to the slot name.
   * Differs from the slot name when the caller wants a display/download name
   * (e.g. slot `attachment` holding `invoice-2024.pdf`); this is the value
   * that the L1 lexical index tokenizes for blob fields.
   */
  filename?: string
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

/** Vendor-neutral short-lived store credentials. `kind` is the credential-PAYLOAD
 *  discriminator — orthogonal to StoreAuthKind ('iam'|'api-key'|…), which is unchanged. */
export type StoreCredentials =
  | { readonly kind: 'aws'
      readonly accessKeyId: string
      readonly secretAccessKey: string
      readonly sessionToken?: string
      readonly expiresAt?: string }              // ISO 8601
  | { readonly kind: 'token'                     // postgres/turso/supabase/webdav/bearer — a LATER slice
      readonly token: string
      readonly expiresAt?: string }
  | { readonly kind: 'password'                  // connection-auth stores: to-postgres/to-mysql user+password; to-smb NTLM via `domain`
      readonly username: string
      readonly password: string
      readonly domain?: string                   // NTLM domain (to-smb); postgres/mysql omit it
      readonly expiresAt?: string }              // ISO 8601 — cloud IAM auth tokens are password-shaped and expire

/** Refresh hook a store calls when it has no credentials or they are near expiry. */
export type StoreCredentialSource = () => Promise<StoreCredentials>

/**
 * The store's authoritative clock as a bounded-uncertainty interval
 * (Spanner TrueTime model). True time is provably within [earliest, latest];
 * `latest - earliest` is the clock-uncertainty bound ε. Used by deferred
 * numbering to order records by store-commit-time and to commit-wait. Never
 * the client wall clock.
 */
export interface StoreTime {
  readonly earliest: number
  readonly latest: number
}

export interface StoreCapabilities {
  /**
   * true — the store's expectedVersion check and write are atomic at the
   * storage layer. Two concurrent puts with the same expectedVersion will
   * produce exactly one success and one ConflictError.
   * false — check and write are separate operations with a race window.
   */
  casAtomic: boolean
  /**
   * true — the store exposes an authoritative {@link NoydbStore.getStoreTime}
   * clock and records are ordered by store-commit-time. Required for
   * `withDeferredNumbering`. Absent/false — the store cannot back deferred
   * numbering (use CAS `sequence().next()` or per-series).
   */
  serverWriteTime?: boolean
  /**
   * Advisory geographic region this store serves (e.g. `'eu'`, `'us'`).
   * Purely declarative — no behavior change for stores that omit it. The
   * federation data-residency guard compares this against a
   * `sharding.regionOf(record)` to refuse non-compliant shard placement.
   */
  region?: string
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
  /**
   * true — the store is a tiered router (`routeStore`) with a cold route,
   * so `compact(vault, { before })` can relocate records hot → cold and
   * reads fall through to cold. `vault.archivePeriod()` requires this.
   */
  coldArchival?: boolean
}

// ─── Factory Options ───────────────────────────────────────────────────

export interface NoydbOptions {
  /** The ciphertext store. Optional — defaults to the built-in `memoryStore()` (non-persistent). */
  readonly store?: NoydbStore
  /**
   * tree-shake seam — optional blob strategy. Pass `withBlobs()`
   * from `@noy-db/hub/blobs` to enable `collection.blob(id)` storage.
   * When omitted, hub's blob machinery stays out of the bundle (ESM
   * tree-shaking) and `collection.blob(id)` throws with a pointer at
   * the subpath. `BlobsStrategy` is `@internal` — users only construct
   * it via the subpath factory.
   *
   * @internal
   */
  readonly blobsStrategy?: BlobsStrategy
  /**
   * Cold-storage archival target. `withArchive({ store })` designates a
   * second store that holds archived record envelopes. Enables
   * `vault.archive()` / `vault.restore()` / `vault.listArchived()`.
   */
  readonly archiveStrategy?: ArchiveStrategy
  /**
   * tree-shake seam — optional indexing strategy. Pass
   * `withIndexing()` from `@noy-db/hub/indexing` to enable eager-mode
   * `==/in` fast-paths, lazy-mode `.lazyQuery()`, rebuild/reconcile,
   * and auto-reconcile. When omitted, indexing code never reaches the
   * bundle; `.lazyQuery()` throws with a pointer at the subpath, and
   * eager-mode collections fall back to linear scans regardless of
   * `indexes: [...]` declarations. `IndexingStrategy` is `@internal` —
   * users only construct it via the subpath factory.
   *
   * @internal
   */
  readonly indexingStrategy?: IndexingStrategy
  /**
   * tree-shake seam — optional aggregate strategy. Pass
   * `withReduce()` from `@noy-db/hub/reduce` to enable
   * `.aggregate()` and `.groupBy()` on Query. When omitted, those
   * methods throw with a pointer at the subpath; the ~886 LOC of
   * Reduction + GroupedQuery machinery never reaches the bundle.
   * Streaming `scan().aggregate()` works independently of this
   * strategy — it doesn't use the `Reduction` class.
   *
   * @internal
   */
  readonly reduceStrategy?: ReduceStrategy
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
   * tree-shake seam — strategy for the collection-level hierarchical-tier
   * operations. Pass `withTiers()` from `@noy-db/hub/tiers` to enable
   * `putAtTier`/`getAtTier`/`listAtTier`/`elevate`/`demote` on collections
   * declared with `{ tiers: [...] }`. When omitted, all five throw
   * `TiersNotEnabledError` and the tier read/write/re-key engine never
   * reaches the bundle.
   *
   * @internal
   */
  readonly tiersStrategy?: TiersStrategy
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
   * `withTransactions()` from `@noy-db/hub/transactions` to enable
   * `db.transaction(fn)`. Without it, calling the method throws.
   *
   * @internal
   */
  readonly transactionsStrategy?: TransactionsStrategy
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
   * #1044 — opt in to the vault head, which detects a store that WITHHOLDS.
   * `withVaultHead()` from `@noy-db/hub/vault-head`. Costs one small write per
   * commit; on a single-device offline vault it defends against nothing, which
   * is why it is opt-in while AAD is not.
   */
  readonly vaultHeadStrategy?: VaultHeadStrategy
  /**
   * GDPR right-to-erasure. Pass `withForget({ subjects })`
   * from `@noy-db/hub/forget` to declare which collections carry erasable
   * subject data and the record field naming the data subject. Enables
   * `vault.forget(subjectId)` crypto-shred (rewrite-to-tombstone of the live
   * record + every history version → body permanently undecryptable, single
   * `op:'forget'` ledger entry, chain still verifies). Each declared
   * collection is forced to `perRecordKeys: true`. When omitted (the
   * `NO_FORGET` default), `vault.forget()` throws
   * `ForgetStrategyNotConfiguredError` and no subject-index write hooks run.
   * Requires `historyStrategy` (the ledger) for the erasure-proof entry.
   */
  readonly forgetStrategy?: ForgetStrategy
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
   * Tree-shake seam — optional snapshot-lifecycle service. Pass
   * `withSnapshots({ store })` from `@noy-db/hub/snapshots` to enable
   * `db.snapshot()`, `db.listSnapshots()`, and `db.restoreSnapshot()`.
   * When omitted, all three methods throw with a pointer at the subpath.
   */
  readonly snapshotsStrategy?: SnapshotsStrategy
  /**
   * Tree-shake seam — optional attestation capability. Pass
   * `withAttestation()` from `@noy-db/hub/attestation` to enable
   * `vault.issueAttestation()`, `vault.getDocumentSigningPublicKey()`,
   * `vault.revokeAttestation()`, `vault.unrevokeAttestation()`,
   * `vault.getRevokedDocIds()`, and `vault.publishRevocationList()`. When
   * omitted, all six throw `AttestationNotEnabledError` and the issue/revoke/
   * signer engines are tree-shaken out.
   */
  readonly attestationStrategy?: AttestationStrategy
  /**
   * Tree-shake seam — optional classified-field capability. Pass
   * `withClassified()` from `@noy-db/hub/classified` to enable
   * `collection.reveal()`. When omitted, `reveal()` throws
   * `ClassifiedNotEnabledError` and the reveal engine is tree-shaken out.
   */
  readonly classifiedStrategy?: ClassifiedStrategy
  /**
   * Tree-shake seam — optional sealed-record (grantor-side) capability. Pass
   * `withSealedRecord()` from `@noy-db/hub/sealed-record` to enable
   * `vault.sealRecordToHost()`, `vault.revokeSealedRecord()`, and
   * `vault.rotateRecordCek()`. When omitted, all three throw
   * `SealedRecordNotEnabledError` and the record-keys grantor engine is reached
   * only via opt-in. The host-side `openSealedRecord` opener stays ungated.
   */
  readonly sealedRecordStrategy?: SealedRecordStrategy
  /**
   * Tree-shake seam — optional portability (data-sovereignty) capability. Pass
   * `withPortability()` from `@noy-db/hub/portability` to enable the
   * `vault.user.*` export/withdrawal surface (`exportMyAccessibleData`,
   * `unilateralWithdrawal`, `requestWithdrawal`, `listWithdrawalRequests`,
   * `approveWithdrawal`, `rejectWithdrawal`). When omitted, all six throw
   * `PortabilityNotEnabledError` and the export/withdraw/request engines are
   * reached only via opt-in.
   */
  readonly portabilityStrategy?: PortabilityStrategy
  /**
   * Tree-shake seam — optional atomic-sequence capability. Pass
   * `withSequence()` from `@noy-db/hub` to enable `vault.sequence(name)`
   * (`.next()` / `.peek()` / `.seedTo()`). When omitted, `vault.sequence()`
   * throws `SequenceNotEnabledError` and the CAS `SequenceStore` engine is
   * reached only via opt-in. Deferred-numbering series (`numbering:
   * [withDeferredNumbering(...)]`) are a separate capability and stay live.
   */
  readonly sequenceStrategy?: SequenceStrategy
  /**
   * Tree-shake seam — optional sovereign-custody (FR-6) capability. Pass
   * `withCustody()` from `@noy-db/hub` to enable minting / removing a
   * `custodian` (`db.grantCustodian` / `db.revokeCustodian` and the
   * `vault.custody.*` facade) plus the `vault.custody.liberate()` ceremony.
   * When omitted, those throw `CustodyNotEnabledError` and the liberate engine
   * is reached only via opt-in. The lower-level `liberateVault` free function
   * stays ungated (it has no createNoydb instance to gate against).
   */
  readonly custodyStrategy?: CustodyStrategy
  /**
   * Tree-shake seam — optional multi-user team capability (#267
   * keyring-grant → team split). Pass `withTeam()` from `@noy-db/hub/team`
   * to enable `db.grant` / `db.revoke` / `db.rotate`. When omitted, those
   * throw `TeamNotEnabledError` and the keyring grant/revoke/rotate engines
   * are reached only via opt-in — the always-on floor is single-user.
   * Single-user primitives (owner keyring, unlock, `listUsers`,
   * `updateUser`, secret rotate/recover) stay ungated, as does the
   * `createDeedOwner` free function (no createNoydb instance to gate
   * against).
   */
  readonly teamStrategy?: TeamStrategy
  /**
   * Tree-shake seam — optional credential-broker capability (#479). Pass
   * `brokerStrategy: withBroker(config)` from `@noy-db/hub/broker` to
   * enable `vault.broker()` (`.enroll()` / `.rotate()` /
   * `.credentialSource(profile?)`). When omitted, `vault.broker()` throws
   * `BrokerNotEnabledError` and the seed lifecycle + network/cache engine
   * are reached only via opt-in.
   */
  readonly brokerStrategy?: BrokerStrategy
  /**
   * Opt-in seam — the `lazy` service (#267). Pass `withLazy()` from
   * `@noy-db/hub/lazy` to explicitly enable lazy mode's bounded-LRU
   * working set for collections declared with `prefetch: false`. When
   * omitted, `prefetch: false` still works via the deprecated implicit
   * back-compat path (identical behavior, one-time deprecation warn);
   * the implicit path will be removed at 1.0.
   */
  readonly lazyStrategy?: LazyStrategy
  /**
   * Tree-shake seam — optional search / retrieval capability. Pass
   * `withSearch()` from `@noy-db/hub` to enable a collection's `search`
   * / `retrieve` / `similarTo` / `warmIndex` / `flushIndex` methods and the
   * put()-time embedding-vector compute for collections declaring `embeddings`.
   * When omitted, those throw `SearchNotEnabledError` and the search/retrieval
   * engine is reached only via opt-in. Embedding compute is paired with search
   * (a vector no gated retrieval could read would be dead weight).
   */
  readonly searchStrategy?: SearchStrategy
  /**
   * Tree-shake seam — optional cargo (partition extraction) capability
   * (FR-6/FR-7). Pass `withCargo()` from `@noy-db/hub/cargo` to enable the
   * source-side `extractPartition(vault, …)` free function. When omitted, it
   * throws `CargoNotEnabledError` and the extraction crypto is reached only via
   * opt-in. The recipient-side `adoptPartition` / `decryptExtractedPartition`
   * free functions — and `diffVault` (shared import/merge infra) — operate
   * without a gated source instance and stay ungated.
   */
  readonly cargoStrategy?: CargoStrategy
  /**
   * @deprecated renamed to `blobsStrategy` (#873).
   *
   * Declared as `never` on purpose — see the block note below.
   */
  readonly blobStrategy?: never
  /**
   * @deprecated renamed to `indexingStrategy` (#873).
   *
   * Declared as `never` on purpose — see the block note below.
   */
  readonly indexStrategy?: never
  /**
   * @deprecated renamed to `transactionsStrategy` (#873).
   *
   * Declared as `never` on purpose — see the block note below.
   */
  readonly txStrategy?: never
  /**
   * @deprecated renamed to `reduceStrategy` (#873).
   *
   * The four keys above are the `#873` strategy-key renames, carried as
   * unusable `never` slots rather than simply deleted (#993).
   *
   * An ABSENT key is answered by TypeScript's excess-property check with the
   * nearest known key by edit distance, so `txStrategy` was reported as "Did
   * you mean to write `crdtStrategy`?" — a suggestion that silently enables a
   * CRDT strategy for a caller who trusts it. A DECLARED `never` key matches
   * exactly, so the compiler surfaces the `@deprecated` line naming the real
   * replacement instead of guessing.
   *
   * One release of carry; drop with the rest of the 0.4.0-pre compatibility
   * surface.
   */
  readonly aggregateStrategy?: never
  /**
   * Optional guard strategies — collection-level write guards. Each
   * handle is the output of `withGuard()` from `@noy-db/hub/guards`.
   * Multiple guards per collection are allowed; they are dispatched
   * in registration order on `collection.put()`.
   */
  readonly guardStrategies?: ReadonlyArray<GuardStrategyAny>
  /**
   * Deferred-numbering series declared via `withDeferredNumbering(...)`.
   * `vault.sequence(series).next({ for })` then assigns gap-free serials at a
   * numbering pass (`vault.runNumberingPass(series)`) instead of via CAS.
   */
  readonly numbering?: ReadonlyArray<DeferredNumberingConfig>
  /**
   * Optional derivation strategies — source-to-output projections that
   * fire on `collection.put()`. Each handle is the output of
   * `withDerivation()` from `@noy-db/hub/derivations`. The vault
   * validates the derivation graph for cycles on `openVault`; a cyclic
   * graph throws `DerivationCycleError`.
   */
  readonly derivationStrategies?: ReadonlyArray<DerivationStrategy>
  /**
   * Optional materialized-view strategies.
   * Each handle returned by `withMaterializedView()` from
   * `@noy-db/hub/materialized-views`. The vault runs unified cycle
   * detection across the MV + derivation graphs at `openVault`; a
   * cyclic graph throws `MaterializedViewCycleError`.
   */
  readonly materializedViewStrategies?: ReadonlyArray<MaterializedViewStrategy>
  /**
   * Optional overlay strategies. Each handle returned by
   * `withOverlayedView()` from `@noy-db/hub/overlay-views`. The vault
   * validates name uniqueness + base concreteness + overlay
   * availability at `openVault`; a clash throws one of the
   * `Overlay*Error` family.
   */
  readonly overlayedViewStrategies?: ReadonlyArray<OverlayedViewStrategy>
  /** Optional remote store(s) for sync. Accepts a single store, a SyncTarget, or an array. */
  readonly sync?: NoydbStore | SyncTarget | SyncTarget[]
  /** User identifier. */
  readonly user: string
  /**
   * Secret for key derivation. Required unless encrypt is false or
   * `getKeyring` is provided. A plain `string` for `'standard'` /
   * `'managed'` mode; an {@link EchoSecretParts} 3-part struct for
   * `'echo'` mode (spec design-history/2026-08-02-echo-secret-design.md, #940).
   */
  readonly secret?: string | EchoSecretParts
  /**
   * Optional callback that returns an unlocked keyring for a given vault.
   * Use this to plug in WebAuthn / OIDC / Shamir / any unlock path that
   * produces an `UnlockedKeyring` outside the secret model.
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
   * and the "create new vault" cases. Unlike the secret path, there is
   * no automatic `NoAccessError` → `createOwnerKeyring` fallback, because
   * the callback owner has the UI context to decide which path to run.
   * For first-time bootstrap, use a secret or recovery code, enroll
   * WebAuthn from the unlocked keyring, then swap to `getKeyring` on
   * subsequent sessions.
   */
  readonly getKeyring?: (vault: string) => Promise<UnlockedKeyring>
  /**
   * Secret mode. Default `'standard'`.
   *
   *   - `'standard'` — the legacy flow. `secret` supplies the
   *     plaintext secret, the user knows it, and the policy gate
   *     `rotate-secret` is enabled.
   *   - `'managed'` — rubber-hose-resistant mode. Hub generates a
   *     256-bit random secret at first open and seals it under
   *     the provided `sealingKey`. The user never sees or types the
   *     secret, defeating the $5-wrench attack. Mutually
   *     exclusive with `secret` and `getKeyring`.
   *   - `'echo'` — 3-part ceremony (prompt / echo / key). `secret`
   *     takes an {@link EchoSecretParts} struct instead of a plain
   *     string (spec design-history/2026-08-02-echo-secret-design.md, #940).
   *
   * @see https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/services/session-tiers.md → Managed-secret mode
   */
  readonly secretMode?: 'standard' | 'echo' | 'managed'
  /**
   * Provider that seals/unseals the auto-generated managed-mode
   * secret. Required when `secretMode === 'managed'`; ignored
   * otherwise. Implementations live in per-platform packages
   * (`@noy-db/seal-macos-keychain`, `@noy-db/seal-wincred`,
   * `@noy-db/seal-libsecret`, `@noy-db/seal-aws-kms`, …).
   */
  readonly sealingKey?: NoydbSealer
  /**
   * Device-local sealer for the echo reveal-blob. Echo mode only.
   * Absent ⇒ live keyrings enroll `reveal: 'portable'`; present ⇒
   * `sealed` (attacker-B resistance). Spec resolved question 4.
   */
  readonly deviceSeal?: NoydbDeviceSeal
  /**
   * Echo enrollment only: optional display hint for the masked echo,
   * threaded to the owner keyring's `KeyringEchoBlock.mask_hint` (surfaced
   * later by `beginEchoUnlock`'s `maskHint`). Echo mode only — rejected
   * (`ValidationError`) when `secretMode` isn't `'echo'`.
   *
   * Counterpart of `RotateSecretInput.echoOptions.maskHint` /
   * `CreateOwnerKeyringOptions.echoMaskHint` for first-boot enrollment via
   * `createNoydb` instead of a later `rotateSecret`.
   */
  readonly echoMaskHint?: string
  /** Required to use `profile: 'shamir'` recovery. Pass
   *  `shamirRecoveryProvider()` from `@noy-db/on-shamir`. */
  readonly shamirRecovery?: NoydbShamir
  /** Enable encryption. Default: true. */
  readonly encrypt?: boolean
  /**
   * Debug-only: lay plaintext records out as directly-inspectable store
   * objects (record fields inlined beside envelope metadata, `_debug: 1`) so
   * native store tooling can read them without unwrapping `_data`. Requires
   * `encrypt: false` — combining with encryption throws `DebugPlaintextError`
   * at construction. NEVER enable for production or client data.
   */
  readonly debugPlaintext?: boolean
  /**
   * Object projection for direct-serve / external blob fields (`as-*`, e.g.
   * `@noy-db/as-aws-s3`). Blob fields declared `external` route their RAW bytes
   * to this projection as a single native object (servable from S3/CDN) instead
   * of the encrypted-chunk path; the encrypted record/slot stays the catalog.
   * Sees plaintext bytes — outside the zero-knowledge guarantee.
   */
  readonly objectStore?: ObjectProjection
  /** Conflict resolution strategy. Default: 'version'. */
  readonly conflict?: ConflictStrategy
  /**
   * Sync scheduling policy. Controls when push/pull fire.
   * Default inferred from store category: per-record → `on-change`,
   * bundle → `debounce 30s`.
   */
  readonly syncPolicy?: SyncPolicy
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
   * Validate secret strength against the phrase format
   * on first-time keyring creation. When
   * `true`, weak phrases throw {@link WeakSecretError} from
   * `createNoydb()` / `db.team.rotateSecret()`. Default: `false` for
   * back-compat; planned to flip to `true` in a future major release.
   */
  readonly validateSecret?: boolean
  /**
   * Per-vault strength-policy knobs for the ECHO (3-part) secret's
   * prompt / combined floors, applied at first-time keyring creation
   * when `validateSecret` is on. Echo mode only — rejected
   * (`ValidationError`) when `secretMode` isn't `'echo'`.
   *
   * This is the parts-path counterpart of `SecretPolicy` (there is no
   * `secretPolicy` field on `NoydbOptions` itself — the standard/string
   * secret path has no per-`createNoydb` override point today; see
   * `RotateSecretInput.secretPolicy` / `RecoverSecretInput.secretPolicy`
   * for where the string-path pairing lives).
   */
  readonly echoSecretPolicy?: EchoSecretPolicy
  /**
   * Vault-level policy gate document. When present, the hub
   * persists the merged policy at `_meta/policy` on first-time vault
   * creation and gates sensitive operations (`db.rotateSecret`,
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
   * Mandatory recovery profile enrollment. Vaults with
   * `recover-secret` enabled MUST register at least one profile
   * before being production-ready, otherwise `createNoydb()` throws
   * {@link RecoveryNotEnrolledError}. Set
   * `policy.gates['recover-secret'].enabled = false` to
   * deliberately opt out of recovery (secret loss = data loss).
   *
   * The `'paper'` profile is supported end-to-end. Other
   * profiles ship the API shape and throw
   * {@link RecoveryProfileNotImplementedError} during use.
   */
  readonly recovery?: ReadonlyArray<RecoveryEnrollment>
  /**
   * When `true`, `createNoydb` rejects vaults with no recovery
   * entries persisted (per the spec's mandatory-enrollment
   * requirement). Default `false` for back-compat; planned to
   * flip to `true` in a future major release. Apps in regulated
   * environments should turn this on now.
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
   * Only applies to the secret (`secret`) path. When `getKeyring` is used,
   * the callback is responsible for handling stale-keyring detection itself.
   */
  readonly onInvalidKey?: 'error' | 'reset'
  /**
   * Enable the cover service (`https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/services/public-envelope.md`).
   * Pass `true` for the default schema (every standard field, 256 KB
   * icon cap, 200-char text cap), or a `CoverSchema` to narrow what
   * the owner can set. Off by default — vaults written by hubs
   * without this option carry no cover, full stop.
   */
  readonly cover?: true | CoverSchema
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
  /**
   * Drain-barrier coordination transport for the schema fence.
   * When omitted, the kernel uses a {@link NoydbMesh} backed by the
   * primary store (`StoreMesh`), reproducing today's
   * store-polling fence behavior byte-for-byte. `@noy-db/by-tabs` /
   * `@noy-db/by-peer` inject a real-time push transport here; an external
   * orchestrator (`@klum-db/lobby`) drives it through the `Noydb` handle.
   *
   * @internal
   */
  readonly mesh?: NoydbMesh
  /**
   * Pre-resolved factory for the `vault.user` per-principal user-envelope
   * API. `createNoydb()` always resolves this itself (dynamically
   * importing `with-party/directory/user-envelope/api.js`) before
   * constructing `Noydb` — mirrors the {@link mesh}
   * pre-resolve above. There is no supported way to override it; it exists
   * as an options-bag field only so `createNoydb()` can thread the
   * pre-resolved value into the constructor without a second parameter.
   *
   * @internal
   */
  readonly userApiFactory?: UserApiFactory
  /**
   * Pre-resolved factory for the `NoydbPolicy` service (vault-policy
   * read/update/bootstrap + session-policy enforcer wiring).
   * `createNoydb()` always resolves this itself (dynamically importing
   * `with-party/policy/index.js`) before constructing `Noydb` — mirrors the
   * {@link mesh} / {@link userApiFactory} pre-resolves
   * above. There is no supported way to override it.
   *
   * @internal
   */
  readonly policyFactory?: NoydbPolicyFactory
  /**
   * Pre-resolved policy-gate engine function (`checkGate`).
   * `createNoydb()` always resolves this itself (dynamically importing
   * `with-party/policy/index.js`) before constructing `Noydb` — same
   * pre-resolve pattern as {@link policyFactory}.
   *
   * @internal
   */
  readonly policyCheckGateFn?: PolicyCheckGateFn
  /**
   * Stable id for the session that owns this instance's writers (one user's
   * writers across vaults). Tags every {@link WriterPresence} the fence
   * watcher reports. Defaults to a fresh ULID per `Noydb` instance.
   *
   * @internal
   */
  readonly sessionId?: string
}

// ─── History / Audit Trail ─────────────────────────────────────────────

/** History configuration. */
export interface HistoryConfig {
  /** Enable history tracking. Default: true. */
  readonly enabled?: boolean
  /** Maximum history entries per record. Oldest pruned on overflow. Default: unlimited. */
  readonly maxVersions?: number
  /**
   * Participate in the vault-wide hash-chained tamper ledger. Default:
   * `true` (every write of this collection appends a ledger entry when
   * `withHistory()` is active). Set `false` to exclude this collection's
   * writes from the chain — its puts/deletes leave no ledger entry,
   * confining tamper-evidence to the collections where it carries weight.
   * Independent of `enabled`, which gates per-record snapshots. Has no
   * effect when `withHistory()` is not active (there is no ledger).
   */
  readonly ledger?: boolean
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

// ─── User Envelope (vault.user contract) ───────────────────────────────
//
// The per-principal user-envelope service's PUBLIC CONTRACT lives here in
// the spine; the implementation (`UserApi` / `createUserApi`, storage
// primitives) lives at `with-party/directory/user-envelope/` and is wired
// in by `createNoydb()` via the pre-resolved `userApiFactory` option above
// — the same dynamic-import-then-stash pattern used for the default
// `NoydbMesh`.
//
// @see design-history/2026-05-05-user-envelope-design.md

/**
 * Thin reader view of a user envelope. The on-disk shape is the standard
 * {@link EncryptedEnvelope}; this is what callers see after the storage
 * layer has decrypted the payload.
 *
 * Hub commits to the `keyringId` ⇔ `userId` identity and the `_v` / `_ts`
 * envelope metadata. The `data` payload is fully app-defined — hub does
 * not introspect, validate, or reserve any keys inside it.
 */
export interface UserEnvelope<T> {
  /** The principal id this envelope belongs to. Equals the keyring `user_id`. */
  readonly keyringId: string
  /** App-owned payload. Opaque to hub. */
  readonly data: T
  /** Optimistic-concurrency version. Increments on every write. */
  readonly _v: number
  /** ISO timestamp of the last write. */
  readonly _ts: string
}

/**
 * Recursive partial. Used for `updateMe(patch)` so callers can hand in
 * deeply-nested partial shapes and have them deep-merged onto the
 * current envelope.
 */
export type DeepPartial<T> = T extends object
  ? { [P in keyof T]?: DeepPartial<T[P]> }
  : T

/**
 * Recursive partial with `null` allowed at every level — used by
 * `updateMe` to express deletion intent in addition to merge.
 *
 * Semantics inside `updateMe`:
 *   - `undefined` (or absent key) — skip; source value preserved
 *   - `null` — delete the key from the resulting envelope
 *   - any other value — overwrite (deep-merge for plain objects,
 *     replace for primitives / arrays)
 *
 * Matches lodash `_.merge` behavior on `null` and Firestore's
 * `FieldValue.delete()` semantics. Loosened from `DeepPartial<T>`.
 * Consumers wanting the original "merge-only" surface can keep
 * importing `DeepPartial` and avoid passing `null`.
 */
export type DeepPartialOrNull<T> = T extends object
  ? { [P in keyof T]?: DeepPartialOrNull<T[P]> | null }
  : T

/** Cancel a previously-registered subscription. */
export type Unsubscribe = () => void

/**
 * Optional factor-proof bundle threaded into gated user-envelope
 * operations. Same shape as `Noydb.checkGate(vault, gate, presented)`
 * accepts elsewhere — apps that have already presented a TOTP/email-OTP
 * for this session pass it here to satisfy tightened policies.
 */
export interface UserEnvelopePresented {
  readonly factors?: readonly FactorProof[]
  readonly sharedDevice?: boolean
}

/**
 * Callback used by `UserApi` to validate the active session against a
 * policy gate. Provided by the `Vault` constructor; in production this
 * delegates to `Noydb.checkGate(vault, gate, presented)`. In tests, a
 * no-op stub is fine.
 */
export type UserEnvelopeCheckGate = (
  gate:
    | 'edit-own-profile'
    | 'view-team-profiles'
    | 'client-unilateral-withdraw'
    | 'user-request-withdrawal'
    | 'approve-user-withdrawal',
  presented?: UserEnvelopePresented,
) => Promise<void>

/**
 * Reactive handle returned by `live()`. `current` is the most recently
 * observed value; `subscribe(cb)` fires on subsequent local writes.
 * `stop()` releases the underlying subscription.
 */
export interface LiveUserEnvelope<T> {
  current(): UserEnvelope<T> | null
  subscribe(cb: (env: UserEnvelope<T> | null) => void): Unsubscribe
  stop(): void
}

/**
 * The 2nd positional parameter of a {@link PortabilityStrategy} method
 * (index 1, right after the leading `vault` argument).
 */
type PortabilityParam1<K extends keyof PortabilityStrategy> = Parameters<PortabilityStrategy[K]>[1]
/**
 * The 3rd positional parameter (index 2) — only present on
 * `approveWithdrawal` / `rejectWithdrawal` (requestId is index 1 there).
 */
type PortabilityParam2<K extends keyof PortabilityStrategy> = Parameters<PortabilityStrategy[K]>[2]
type PortabilityReturn<K extends keyof PortabilityStrategy> = ReturnType<PortabilityStrategy[K]>

/**
 * Public `vault.user.*` API surface — the CONTRACT. The implementation
 * (`UserApi`) lives at `with-party/directory/user-envelope/api.ts` and
 * `implements` this interface; `createNoydb()` wires it in via the
 * pre-resolved {@link UserApiFactory}.
 *
 * Three families:
 *  - Write-self: `me` / `updateMe` / `setMe` — always target the writer's
 *    own keyringId. **Own-only write rule** is structural — no method
 *    exists to write someone else's envelope.
 *  - Read-anyone: `get` / `list` — read other principals' envelopes
 *    (subject to `view-team-profiles` policy gate).
 *  - Reactive: `subscribe` / `live` — in-process event emission on local
 *    writes. Cross-instance updates land via the team/sync engine and
 *    surface to subscribers when the sync diff replays through this API.
 *
 * @see design-history/2026-05-05-user-envelope-design.md
 */
export interface VaultUserApi {
  requestWithdrawal(opts?: PortabilityParam1<'requestWithdrawal'>): PortabilityReturn<'requestWithdrawal'>
  listWithdrawalRequests(opts?: PortabilityParam1<'listWithdrawalRequests'>): PortabilityReturn<'listWithdrawalRequests'>
  approveWithdrawal(
    requestId: PortabilityParam1<'approveWithdrawal'>,
    opts?: PortabilityParam2<'approveWithdrawal'>,
  ): PortabilityReturn<'approveWithdrawal'>
  rejectWithdrawal(
    requestId: PortabilityParam1<'rejectWithdrawal'>,
    opts?: PortabilityParam2<'rejectWithdrawal'>,
  ): PortabilityReturn<'rejectWithdrawal'>
  unilateralWithdrawal(opts: PortabilityParam1<'withdrawAccessibleData'>): PortabilityReturn<'withdrawAccessibleData'>
  exportMyAccessibleData(opts?: PortabilityParam1<'exportAccessibleData'>): PortabilityReturn<'exportAccessibleData'>
  me<T = unknown>(): Promise<UserEnvelope<T> | null>
  updateMe<T extends object = Record<string, unknown>>(
    patch: DeepPartialOrNull<T>,
    presented?: UserEnvelopePresented,
  ): Promise<UserEnvelope<T>>
  setMe<T = unknown>(payload: T, presented?: UserEnvelopePresented): Promise<UserEnvelope<T>>
  getMyVisibility(): Promise<{ readonly hidden: boolean }>
  setMyVisibility(visibility: { readonly hidden: boolean }): Promise<void>
  get<T = unknown>(keyringId: string, presented?: UserEnvelopePresented): Promise<UserEnvelope<T> | null>
  list<T = unknown>(presented?: UserEnvelopePresented): Promise<UserEnvelope<T>[]>
  subscribe<T = unknown>(keyringId: string, cb: (env: UserEnvelope<T> | null) => void): Unsubscribe
  live<T = unknown>(keyringId: string): LiveUserEnvelope<T>
}

/**
 * Constructor dependencies for `UserApi` (the {@link VaultUserApi}
 * implementation). Built by `Vault`'s constructor and passed to the
 * pre-resolved {@link UserApiFactory}.
 */
export interface UserApiDeps {
  readonly adapter: NoydbStore
  readonly vaultName: string
  /** The writer's own keyringId. Frozen at construction time. */
  readonly writerKeyringId: string
  readonly getDek: () => Promise<EnclaveKey>
  /**
   * Policy-gate validator. When omitted, gates are skipped — useful
   * for low-level tests that exercise the storage layer directly.
   * Production paths always wire the Noydb-backed implementation.
   */
  readonly checkGate?: UserEnvelopeCheckGate
  /**
   * Noydb-backed `exportMyAccessibleData`, injected by the Vault
   * (which holds the keyring + bundle machinery). Omitted in low-level tests.
   */
  readonly exportAccessible?: (opts: PortabilityParam1<'exportAccessibleData'>) => PortabilityReturn<'exportAccessibleData'>
  /**
   * Noydb-backed `unilateralWithdrawal`, injected by the Vault.
   * Destructive — extract + dispose (delete | freeze). Omitted in low-level tests.
   */
  readonly unilateralWithdraw?: (opts: PortabilityParam1<'withdrawAccessibleData'>) => PortabilityReturn<'withdrawAccessibleData'>
  /**
   * Noydb-backed two-party withdrawal ceremony, injected by the
   * Vault. requestWithdraw = requester side; the rest = owner side.
   */
  readonly requestWithdraw?: (opts: PortabilityParam1<'requestWithdrawal'>) => PortabilityReturn<'requestWithdrawal'>
  readonly listWithdrawals?: (opts: PortabilityParam1<'listWithdrawalRequests'>) => PortabilityReturn<'listWithdrawalRequests'>
  readonly approveWithdraw?: (
    requestId: PortabilityParam1<'approveWithdrawal'>,
    opts: PortabilityParam2<'approveWithdrawal'>,
  ) => PortabilityReturn<'approveWithdrawal'>
  readonly rejectWithdraw?: (
    requestId: PortabilityParam1<'rejectWithdrawal'>,
    opts: PortabilityParam2<'rejectWithdrawal'>,
  ) => PortabilityReturn<'rejectWithdrawal'>
}

/**
 * Factory that builds the `vault.user` API implementation from its
 * dependencies. `createNoydb()` pre-resolves the real implementation
 * (`with-party/directory/user-envelope/api.js#createUserApi`) via a
 * dynamic import before constructing `Noydb`, so `Vault`'s constructor
 * can call it synchronously — the two sync `subscribe`/`live` methods on
 * `VaultUserApi` are why `vault.user` must be built synchronously.
 */
export type UserApiFactory = (deps: UserApiDeps) => VaultUserApi

// ─── Policy gates (VaultPolicy contract) ───────────────────────────────
//
// Sensitive operations (rotate the secret, enroll an authenticator,
// export plaintext, grant a user, …) are gated by a typed policy
// object. The developer supplies a {@link VaultPolicy} at vault
// creation; the hub merges it onto a built-in preset and persists the
// merged document at `_meta/policy`.
//
// The CONTRACT (this section) lives here in the spine; the engine
// (`checkGate`/`describeGate`), the presets (`PERSONAL_POLICY` /
// `STRICT_POLICY`), storage (`loadVaultPolicy`/`saveVaultPolicy`), and the
// `NoydbPolicy` facade implementation live at `with-party/policy/` and are
// wired in by `createNoydb()` via the pre-resolved {@link NoydbPolicyFactory}
// / {@link PolicyCheckGateFn} options above — the same
// dynamic-import-then-stash pattern used for the default
// `NoydbMesh` / `UserApiFactory`.
//
// @see https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/services/session-tiers.md → Policy gates DSL

/**
 * A single factor surface — the proof an actor presents at gate time.
 *
 * | Kind | Source | Off-device? |
 * |---|---|---|
 * | `totp` | RFC 6238 authenticator app (Google Auth, 1Password) | yes |
 * | `email-otp` | one-time code mailed to the user | yes |
 * | `recovery` | printable Base32 code (`@noy-db/on-recovery`) | yes (paper) |
 * | `shamir` | k-of-n threshold share (`@noy-db/on-shamir`) | yes |
 * | `webauthn-roaming` | hardware key (YubiKey, SoloKey, Titan) | yes (key portable) |
 * | `webauthn-platform` | platform passkey (Touch ID, Face ID, Hello) | no (device-bound) |
 * | `password` | tier-2 password (`@noy-db/on-password`) | no |
 * | `pin` | tier-3 quick-resume PIN (`@noy-db/on-pin`) | no |
 *
 * Off-device kinds (TOTP, email-OTP, recovery, shamir, roaming WebAuthn)
 * are the strongest factor proofs because they require something
 * separate from the device the user just unlocked. Platform / password /
 * PIN are useful for "fresh proof of *this* user" but don't bind across
 * devices — policies can require ANY of them or insist on a count of 2
 * to force a mix.
 *
 * `webauthn-platform`, `password`, `pin` — for consumers with no
 * off-device infrastructure (no TOTP, no email-OTP, paper recovery not
 * enrolled) who want to require "any second factor I have wired"
 * without losing the freshness guarantee.
 */
export type FactorKind =
  | 'totp'
  | 'email-otp'
  | 'recovery'
  | 'shamir'
  | 'webauthn-roaming'
  | 'webauthn-platform'
  | 'password'
  | 'pin'

/**
 * One factor requirement entry. The default is "any one of the listed
 * factors, fresh within the last 5 minutes". Bumping `count` requires N
 * distinct fresh proofs; bumping `freshnessMs` widens the acceptance
 * window.
 */
export interface FactorRequirement {
  readonly anyOf: ReadonlyArray<FactorKind>
  /** Number of distinct factors required. Default 1. */
  readonly count?: number
  /** How recent each proof must be. Default 5 minutes. */
  readonly freshnessMs?: number
}

/** Soft signals layered on top of the gate verdict — never block on their own. */
export interface WarningRules {
  /** Behavior on shared-device tier-1 ops. `'block'` raises a `PolicyDeniedError`. */
  readonly sharedDevice?: 'warn' | 'block'
  /** Behavior on weak tier-2 (e.g. password-only) for sensitive ops. */
  readonly weakAuthenticator?: 'warn' | 'block'
}

/**
 * Policy applied to one named gate. `enabled: false` disables the
 * action entirely (useful in managed-secret mode where rotation is
 * impossible by construction).
 */
export interface GatePolicy {
  /** Minimum tier the active session must hold. */
  readonly minTier: 1 | 2 | 3
  /** Extra freshness-bound proofs required at gate time. */
  readonly factors?: ReadonlyArray<FactorRequirement>
  readonly warn?: WarningRules
  readonly enabled?: boolean
}

/**
 * Built-in gate names. App-defined gates live in the `app:*` namespace
 * and use the same engine; the engine treats unknown names with no
 * configured policy as "no gate" (no-op).
 */
export type BuiltInGateName =
  | 'rotate-secret'
  | 'recover-secret'
  | 'enroll-authenticator'
  | 'remove-authenticator'
  /**
   * Authorize a deliberate paper-recovery-code regeneration —
   * `db.rotateRecovery`. Symmetric to `rotate-secret` for
   * the case where the user remembers their secret but wants a
   * fresh sheet (lost the printout, suspect compromise of the off-site
   * copy). PERSONAL allows tier-1; STRICT requires an off-device
   * factor so a stolen unlocked laptop cannot silently mint a new
   * sheet for an attacker.
   */
  | 'rotate-recovery'
  /**
   * Authorize a meta-only mutation on an existing authenticator slot —
   * `db.updateAuthenticator`. The slot's wrap material, id, and
   * method are immutable through this gate; only the `meta` blob
   * (nicknames, method-specific labels) can change. Anti-slot-swap
   * guard is preserved structurally regardless of this gate's
   * settings.
   */
  | 'update-authenticator'
  | 'rotate-unlock'
  | 'enroll-user'
  | 'revoke-user'
  | 'export-bundle'
  | 'export-plaintext'
  | 'view-user-auth'
  /** Authorize a write to one's own user envelope. */
  | 'edit-own-profile'
  /** Authorize reading other principals' user envelopes. */
  | 'view-team-profiles'
  /**
   * Authorize an atomic peer-recovery — `db.recoverUser`.
   * Distinct from `revoke-user` because peer-recovery is intentional
   * re-issuance of someone's keyring under a temp secret, NOT
   * removal. Allows owner→owner natively (matches the threat model:
   * a co-owner explicitly recovering another co-owner). Ships with a
   * factor-proof default in `STRICT_POLICY` so the issuer must
   * affirmatively prove identity at the moment of recovery.
   */
  | 'peer-recover-user'
  /**
   * Authorize a post-grant identity mutation — `db.updateUser`.
   * Covers `role`, `displayName`, `permissions` changes on an existing
   * keyring. Pure plaintext-header rewrite — no DEKs touched, no KEK
   * required. The role-elevation guard inside the implementation
   * mirrors `db.grant`'s hierarchy (admin cannot promote to owner)
   * regardless of this gate's settings.
   */
  | 'update-user'
  /**
   * Authorize a non-owner's self-service **destructive** withdrawal —
   * `vault.user.unilateralWithdrawal`. The actor exports their
   * own re-keyed copy and then removes (delete-closure) or freezes the
   * source records. Because it both egresses data AND destroys the
   * firm's live copy, it MUST fail closed: undefined in a policy = denied.
   * Hosts opt in explicitly (and typically pin `minTier`/factor proofs).
   */
  | 'client-unilateral-withdraw'
  /**
   * Authorize FILING a two-party withdrawal request —
   * `vault.user.requestWithdrawal`. Non-destructive (writes a
   * pending request only); enabled by default so a read-only client can ask.
   */
  | 'user-request-withdrawal'
  /**
   * Authorize DECIDING a two-party withdrawal request (approve/reject) —
   * `vault.user.approveWithdrawal` / `rejectWithdrawal`. The approve
   * path is destructive (extract-and-dispose under firm authority), so it
   * defaults to a tier-2 floor; owner/admin role is enforced structurally.
   */
  | 'approve-user-withdrawal'
  /**
   * Authorize minting a **custodian** — `db.grantCustodian` (FR-6). The
   * custodian is the de-facto operational authority on a sealed-owner (Deed)
   * vault, so granting one is an ownership-level act: this gate MUST fail
   * closed (undefined in a policy = denied) and owner-only role is enforced
   * structurally. Hosts opt in explicitly, typically pinning factor proofs.
   */
  | 'grant-custodian'
  /**
   * Authorize the audited **Liberate** ceremony — `vault.custody.liberate`
   * (FR-6). The custodian (holding the live DEKs) claims ownership of a
   * sealed-owner vault under a recorded legal basis, minting a NEW owner
   * keyring. Destructive-of-the-old-ownership and irreversible, so it MUST
   * fail closed (undefined = denied); the caller-is-custodian check is
   * enforced structurally in the ceremony.
   */
  | 'liberate-vault'

/** Either a built-in gate name or an `app:*` custom gate. */
export type GateName = BuiltInGateName | `app:${string}`

/**
 * Top-level policy object. Persisted at `_meta/policy` once at vault
 * creation. The `secret` block configures the strength rules
 * applied at every secret ingress; `gates` configures
 * the action-level requirements.
 */
export interface VaultPolicy {
  readonly secret?: SecretPolicy
  readonly gates: Partial<Record<GateName, GatePolicy>>
}

/** Concrete proof an actor presents to {@link checkGate}. */
export interface FactorProof {
  readonly kind: FactorKind
  /** ISO-8601 timestamp the proof was minted at. Compared against `freshnessMs`. */
  readonly mintedAt?: string
  /** Method-specific payload. The engine treats it as opaque — verification is delegated. */
  readonly payload?: unknown
}

/**
 * Bundle of factor proofs + session-context flags passed to a gated
 * Noydb method. Used as the optional last parameter of every method
 * that runs through `checkGate`: `db.grant`, `db.revoke`, `db.updateUser`,
 * `db.enrollAuthenticator`, `db.removeAuthenticator`, `db.updateAuthenticator`,
 * `db.enrollWebAuthn`, `db.rotateSecret`, `db.recoverSecret`,
 * `db.recoverUser`, `db.enrollUnlock`, `db.describeUserAuth`,
 * `db.describeAllUsersAuth`.
 *
 * Previously this type was inlined at every call site as
 * `{ factors?: ReadonlyArray<FactorProof>; sharedDevice?: boolean }`
 * and parameter names alternated between `factors` and `presented`.
 * Now exported so consumers can name their helpers and so the param
 * name converges to `factors` everywhere.
 */
export interface FactorProofBundle {
  readonly factors?: ReadonlyArray<FactorProof>
  readonly sharedDevice?: boolean
}

/** Active session tier — what the engine compares against `gate.minTier`. */
export type ActiveTier = 1 | 2 | 3

/**
 * Caller-supplied context for the policy engine's `checkGate`/`describeGate`.
 * Structural mirror of `with-party/policy/engine.ts`'s `CheckGateContext` —
 * duplicated here (rather than imported) because the kernel spine may not
 * statically import a with-* service; see {@link PolicyCheckGateFn}.
 */
export interface PolicyCheckGateContext {
  /** Tier the active session currently holds. */
  readonly activeTier: ActiveTier
  /** Proofs the actor is presenting for this gate. */
  readonly factors?: ReadonlyArray<FactorProof>
  /**
   * If the host knows the actor is on a shared device, set this to
   * `true` so the engine can apply `warn.sharedDevice` rules. Defaults
   * to `false`.
   */
  readonly sharedDevice?: boolean
  /**
   * Override `now()` for tests. Defaults to `Date.now()`.
   * @internal
   */
  readonly now?: number
}

/**
 * Structural type of the policy engine's `checkGate` function. The real
 * implementation lives at `with-party/policy/engine.ts#checkGate`;
 * `createNoydb()` pre-resolves it via a dynamic import (mirrors
 * {@link UserApiFactory}) so `Noydb.checkGate` can call it without the
 * spine statically importing the service.
 */
export type PolicyCheckGateFn = (
  policy: VaultPolicy,
  gate: GateName,
  context: PolicyCheckGateContext,
) => Promise<void>

/**
 * Public `NoydbPolicy` surface — the CONTRACT. The implementation
 * (`NoydbPolicy` class) lives at `with-party/policy/noydb-facade.ts`;
 * `createNoydb()` wires it in via the pre-resolved {@link NoydbPolicyFactory}.
 */
export interface NoydbPolicyApi {
  /**
   * Touch the policy enforcer for a vault (records activity, resets
   * idle timer). Also touches the legacy session timer. No-op if no enforcer.
   */
  touchPolicy(vault?: string): void
  /**
   * Check that a policy-guarded operation is permitted.
   * Throws `SessionPolicyError` if re-auth is required.
   */
  checkPolicyOperation(vault: string, op: ReAuthOperation): void
  /**
   * Read the active policy for a vault. Loads from `_meta/policy` on
   * first call; subsequent calls hit the in-memory cache. Throws
   * `ValidationError` if the vault has not been opened.
   */
  getPolicy(vault: string): Promise<VaultPolicy>
  /**
   * Replace the policy document at `_meta/policy` and update the
   * in-memory cache. Gated by the `enroll-user` policy (a policy
   * change is fundamentally a privilege-management action).
   */
  updatePolicy(vault: string, override: Partial<VaultPolicy>): Promise<VaultPolicy>
  /** Read or persist the vault policy at `_meta/policy` on first open. */
  bootstrapPolicy(vault: string, opts?: { skipManagedCheck?: boolean }): Promise<void>
}

/**
 * Constructor dependencies for `NoydbPolicy` (the {@link NoydbPolicyApi}
 * implementation). Everything the policy/session-policy methods touch on
 * the owning `Noydb` instance's `this.*`.
 *
 * The `policyEnforcers` map is typed structurally (rather than importing
 * `PolicyEnforcer` from `with-party/session/session-policy.ts`) so this
 * spine-resident interface never needs a with-* import; the real
 * `PolicyEnforcer` class satisfies this shape.
 */
export interface NoydbPolicyDeps {
  /** In-memory vault-policy cache (Noydb-resident; read/written by reference). */
  readonly policyCache: Map<string, VaultPolicy>
  /** Per-vault session-policy enforcers (Noydb-resident; read/written by reference). */
  readonly policyEnforcers: Map<string, { touch(): void; destroy(): void; checkOperation(op: ReAuthOperation): void }>
  /** The ciphertext store. */
  readonly store: NoydbStore
  /** Whether records are encrypted (`options.encrypt !== false`). */
  readonly encrypted: boolean
  /** The configured session policy, or undefined. */
  readonly sessionPolicy: SessionPolicy | undefined
  /** The developer-supplied default policy, or undefined. */
  readonly policyOption: VaultPolicy | undefined
  /** Whether the owning instance has been closed. */
  isClosed(): boolean
  /** Reset the kernel-resident idle/session timer. */
  resetSessionTimer(): void
  /** Managed-recovery enrolment check (kernel-resident; called on bootstrap). */
  assertRecoveryEnrolled(
    vault: string,
    policy: VaultPolicy,
    opts?: { skipManagedCheck?: boolean },
  ): Promise<void>
  /** Evict the keyring + vault caches when a session is revoked. */
  onSessionRevoke(vault: string): void
}

/**
 * Factory that builds the `NoydbPolicy` service implementation from its
 * dependencies. `createNoydb()` pre-resolves the real implementation
 * (`with-party/policy/noydb-facade.js#createNoydbPolicy`) via a dynamic
 * import before constructing `Noydb`, so the constructor can call it
 * synchronously — mirrors {@link UserApiFactory}.
 */
export type NoydbPolicyFactory = (deps: NoydbPolicyDeps) => NoydbPolicyApi

/**
 * Named field-set declarations for a collection's type-level shape (#839).
 *
 * Replaces the positional `Collection<T, S, Q, M>` tail at every surface a
 * consumer touches. The positional form was unreadable and unsafe: `Q` and `M`
 * are both `keyof T & string`, so swapping them type-checked silently, and
 * reaching `M` meant writing placeholders —
 * `collection<Sale, never, never, 'amount' | 'tax'>`.
 *
 * ```ts
 * vault.collection<Sale, { money: 'amount' | 'tax' }>('sales')
 * vault.collection<Invoice, { sensitive: 'ssn'; indexed: 'clientId' }>('invoices')
 * ```
 *
 * Every member is optional; omitting one keeps that axis permissive, which is
 * what the `[X] extends [never]` guards in {@link QueryField} /
 * {@link IndexFieldName} encode. Those guards are NOT removable — they are the
 * difference between "no indexes declared, so `where()` accepts any field" and
 * "indexes declared, so `where()` is restricted to them" — so they are
 * re-expressed against this shape rather than dropped.
 */
export interface CollectionShape<T> {
  /** Fields sealed at rest; reads return {@link Sealed} handles. */
  readonly sensitive?: keyof T & string
  /** Fields carrying a declared secondary index; narrows `where()` / `orderBy()`. */
  readonly indexed?: keyof T & string
  /** Fields carrying a money descriptor. */
  readonly money?: keyof T & string
}

/** The `sensitive` field set of a {@link CollectionShape}, or `never` if unset. */
export type SensitiveOf<T, O> = O extends { sensitive: infer S } ? (S & keyof T & string) : never
/** The `indexed` field set of a {@link CollectionShape}, or `never` if unset. */
export type IndexedOf<T, O> = O extends { indexed: infer Q } ? (Q & keyof T & string) : never
/** The `money` field set of a {@link CollectionShape}, or `never` if unset. */
export type MoneyOf<T, O> = O extends { money: infer M } ? (M & keyof T & string) : never
