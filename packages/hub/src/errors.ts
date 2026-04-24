/**
 * All NOYDB error classes — a single import surface for `catch` blocks and
 * `instanceof` checks.
 *
 * ## Class hierarchy
 *
 * ```
 * Error
 *  └─ NoydbError (code: string)
 *       ├─ Crypto errors
 *       │    ├─ DecryptionError        — AES-GCM tag failure
 *       │    ├─ TamperedError          — ciphertext modified after write
 *       │    └─ InvalidKeyError        — wrong passphrase / corrupt keyring
 *       ├─ Access errors
 *       │    ├─ NoAccessError          — no DEK for this collection
 *       │    ├─ ReadOnlyError          — ro permission, write attempted
 *       │    ├─ PermissionDeniedError  — role too low for operation
 *       │    ├─ PrivilegeEscalationError — grant wider than grantor holds
 *       │    └─ StoreCapabilityError   — optional store method missing
 *       ├─ Sync errors
 *       │    ├─ ConflictError          — optimistic-lock version mismatch
 *       │    ├─ BundleVersionConflictError — bundle push rejected by remote
 *       │    └─ NetworkError           — push/pull network failure
 *       ├─ Data errors
 *       │    ├─ NotFoundError          — get(id) on missing record
 *       │    ├─ ValidationError        — application-level guard failed
 *       │    └─ SchemaValidationError  — Standard Schema v1 rejection
 *       ├─ Query errors
 *       │    ├─ JoinTooLargeError      — join row ceiling exceeded
 *       │    ├─ DanglingReferenceError — strict ref() points at nothing
 *       │    ├─ GroupCardinalityError  — groupBy bucket cap exceeded
 *       │    ├─ IndexRequiredError      — lazy-mode query touches unindexed field
 *       │    └─ IndexWriteFailure       — index side-car put/delete failed post-main
 *       ├─ i18n / Dictionary errors
 *       │    ├─ ReservedCollectionNameError
 *       │    ├─ DictKeyMissingError
 *       │    ├─ DictKeyInUseError
 *       │    ├─ MissingTranslationError
 *       │    ├─ LocaleNotSpecifiedError
 *       │    └─ TranslatorNotConfiguredError
 *       ├─ Backup errors
 *       │    ├─ BackupLedgerError      — hash-chain verification failed
 *       │    └─ BackupCorruptedError   — envelope hash mismatch in dump
 *       ├─ Bundle errors
 *       │    └─ BundleIntegrityError   — .noydb body sha256 mismatch
 *       └─ Session errors
 *            ├─ SessionExpiredError
 *            ├─ SessionNotFoundError
 *            └─ SessionPolicyError
 * ```
 *
 * ## Catching all NOYDB errors
 *
 * ```ts
 * import { NoydbError, InvalidKeyError, ConflictError } from '@noy-db/hub'
 *
 * try {
 *   await vault.unlock(passphrase)
 * } catch (e) {
 *   if (e instanceof InvalidKeyError) { showBadPassphraseUI(); return }
 *   if (e instanceof NoydbError) { logToSentry(e.code, e); return }
 *   throw e  // unexpected — re-throw
 * }
 * ```
 *
 * @module
 */

/**
 * Base class for all NOYDB errors.
 *
 * Every error thrown by `@noy-db/hub` extends this class, so consumers can
 * catch all NOYDB errors in a single `catch (e) { if (e instanceof NoydbError) ... }`
 * block. The `code` field is a machine-readable string (e.g. `'DECRYPTION_FAILED'`)
 * suitable for `switch` statements and logging pipelines.
 */
export class NoydbError extends Error {
  /** Machine-readable error code. Stable across library versions. */
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'NoydbError'
    this.code = code
  }
}

// ─── Crypto Errors ─────────────────────────────────────────────────────

/**
 * Thrown when AES-GCM decryption fails.
 *
 * The most common cause is a wrong passphrase or a corrupted ciphertext.
 * A `DecryptionError` at the wrong passphrase level is caught internally
 * and re-thrown as `InvalidKeyError` — so in practice this surfaces for
 * per-record corruption rather than authentication failures.
 */
export class DecryptionError extends NoydbError {
  constructor(message = 'Decryption failed') {
    super('DECRYPTION_FAILED', message)
    this.name = 'DecryptionError'
  }
}

/**
 * Thrown when GCM tag verification fails, indicating the ciphertext was
 * modified after encryption.
 *
 * AES-256-GCM is authenticated encryption — the tag over the ciphertext
 * is checked on every decrypt. If any byte was flipped (accidental
 * corruption or deliberate tampering), decryption throws this error.
 * Treat it as a security alert: the stored bytes are not what NOYDB wrote.
 */
export class TamperedError extends NoydbError {
  constructor(message = 'Data integrity check failed — record may have been tampered with') {
    super('TAMPERED', message)
    this.name = 'TamperedError'
  }
}

/**
 * Thrown when key unwrapping fails, typically because the passphrase is wrong
 * or the keyring file is corrupted.
 *
 * NOYDB uses AES-KW (RFC 3394) to wrap DEKs with the KEK. If AES-KW
 * unwrapping fails, it means either the KEK was derived from the wrong
 * passphrase (PBKDF2 with 600K iterations) or the keyring bytes are
 * corrupted. This is the error shown to the user on a failed unlock attempt.
 */
export class InvalidKeyError extends NoydbError {
  constructor(message = 'Invalid key — wrong passphrase or corrupted keyring') {
    super('INVALID_KEY', message)
    this.name = 'InvalidKeyError'
  }
}

// ─── Access Errors ─────────────────────────────────────────────────────

/**
 * Thrown when the authenticated user does not have a DEK for the requested
 * collection — i.e. the collection is not in their keyring at all.
 *
 * This is the "no key for this door" error. It is different from
 * `ReadOnlyError` (user has a key but it only grants ro) and from
 * `PermissionDeniedError` (user's role doesn't allow the operation).
 */
export class NoAccessError extends NoydbError {
  constructor(message = 'No access — user does not have a key for this collection') {
    super('NO_ACCESS', message)
    this.name = 'NoAccessError'
  }
}

/**
 * Thrown when a user with read-only (`ro`) permission attempts a write
 * operation (`put` or `delete`) on a collection.
 *
 * The user has a DEK for the collection (they can decrypt and read), but
 * their keyring grants only `ro`. To fix: re-grant the user with `rw`
 * permission, or do not attempt writes as a viewer/client role.
 */
export class ReadOnlyError extends NoydbError {
  constructor(message = 'Read-only — user has ro permission on this collection') {
    super('READ_ONLY', message)
    this.name = 'ReadOnlyError'
  }
}

/**
 * Thrown when a write is attempted against a historical view produced
 * by `vault.at(timestamp)`. Time-machine views are read-only by
 * contract — mutating the past would require either the shadow-vault
 * mechanism (v0.16 #217) or a ledger-history rewrite (which breaks
 * the tamper-evidence guarantee).
 *
 * Distinct from {@link ReadOnlyError} (keyring-level) and
 * {@link PermissionDeniedError} (role-level): this error is about the
 * *view* being historical, independent of the caller's permissions.
 */
export class ReadOnlyAtInstantError extends NoydbError {
  constructor(operation: string, timestamp: string) {
    super(
      'READ_ONLY_AT_INSTANT',
      `Cannot ${operation}() on a vault view anchored at ${timestamp} — time-machine views are read-only`,
    )
    this.name = 'ReadOnlyAtInstantError'
  }
}

/**
 * Thrown when a write is attempted against a shadow-vault frame
 * produced by `vault.frame()`. Frames are read-only by contract —
 * the use case is screen-sharing / demos / compliance review where
 * the operator wants to prevent accidental edits.
 *
 * Behavioural enforcement only — the underlying keyring still holds
 * write-capable DEKs. See {@link VaultFrame} for the full caveat.
 */
export class ReadOnlyFrameError extends NoydbError {
  constructor(operation: string) {
    super(
      'READ_ONLY_FRAME',
      `Cannot ${operation}() on a vault frame — frames are read-only presentations of the current vault`,
    )
    this.name = 'ReadOnlyFrameError'
  }
}

/**
 * Thrown when the authenticated user's role does not permit the requested
 * operation — e.g. a `viewer` calling `grantAccess()`, or an `operator`
 * calling `rotateKeys()`.
 *
 * This is a role-level check (what the user's role allows), distinct from
 * `NoAccessError` (collection not in keyring) and `ReadOnlyError` (in
 * keyring, but write not allowed).
 */
export class PermissionDeniedError extends NoydbError {
  constructor(message = 'Permission denied — insufficient role for this operation') {
    super('PERMISSION_DENIED', message)
    this.name = 'PermissionDeniedError'
  }
}

/**
 * Thrown when an `@noy-db/as-*` export is attempted without the
 * required capability bit on the invoking keyring (RFC #249).
 *
 * Two sub-cases discriminated by the `tier` field:
 *
 * - `tier: 'plaintext'` — a plaintext-tier export (`as-xlsx`,
 *   `as-csv`, `as-blob`, `as-zip`, …) was attempted but the
 *   keyring's `exportCapability.plaintext` does not include the
 *   requested `format` (nor the `'*'` wildcard). Default for every
 *   role is `plaintext: []` — the owner must positively grant.
 * - `tier: 'bundle'` — an encrypted `as-noydb` bundle export was
 *   attempted but the keyring's `exportCapability.bundle` is
 *   `false`. Default for `owner`/`admin` is `true`; for
 *   `operator`/`viewer`/`client` it is `false`.
 *
 * Distinct from `PermissionDeniedError` (role-level check) and
 * `NoAccessError` (collection not readable). Surfaces separately so
 * UI layers can show a "request the export capability from your
 * admin" flow rather than a generic permission error.
 */
export class ExportCapabilityError extends NoydbError {
  readonly tier: 'plaintext' | 'bundle'
  readonly format?: string
  readonly userId: string

  constructor(opts: {
    tier: 'plaintext' | 'bundle'
    userId: string
    format?: string
    message?: string
  }) {
    const msg =
      opts.message ??
      (opts.tier === 'plaintext'
        ? `Export capability denied — keyring "${opts.userId}" is not granted plaintext-export capability for format "${opts.format ?? '<unknown>'}". Ask a vault owner or admin to grant it via vault.grant({ exportCapability: { plaintext: ['${opts.format ?? '<format>'}'] } }).`
        : `Export capability denied — keyring "${opts.userId}" is not granted encrypted-bundle export capability. Ask a vault owner or admin to grant it via vault.grant({ exportCapability: { bundle: true } }).`)
    super('EXPORT_CAPABILITY', msg)
    this.name = 'ExportCapabilityError'
    this.tier = opts.tier
    this.userId = opts.userId
    if (opts.format !== undefined) this.format = opts.format
  }
}

/**
 * Thrown when a grant would give the grantee a permission the grantor
 * does not themselves hold — the "admin cannot grant what admin cannot
 * do" rule from the v0.5 #62 admin-delegation work.
 *
 * Distinct from `PermissionDeniedError` so callers can tell the two
 * cases apart in logs and tests:
 *
 *   - `PermissionDeniedError` — "you are not allowed to perform this
 *     operation at all" (wrong role).
 *   - `PrivilegeEscalationError` — "you are allowed to grant, but not
 *     with these specific permissions" (widening attempt).
 *
 * Under the v0.5 admin model the grantee of an admin-grants-admin call
 * inherits the caller's entire DEK set by construction, so this error
 * is structurally unreachable in typical flows. The check and error
 * class exist so that future per-collection admin scoping (tracked
 * under v0.6+ deputy-admin work) cannot accidentally bypass the subset
 * rule — the guard is already wired in.
 *
 * `offendingCollection` carries the first collection name that failed
 * the subset check, to make the violation actionable in error output.
 */
/**
 * Thrown when a caller invokes an API that requires an optional
 * store capability the active store does not implement (v0.5
 * #63).
 *
 * Today the only call site is `Noydb.listAccessibleVaults()`,
 * which depends on the optional `NoydbStore.listVaults()`
 * method. The error message names the missing method and the calling
 * API so consumers know exactly which combination is unsupported,
 * and the `capability` field is machine-readable so library code can
 * pattern-match in catch blocks (e.g. fall back to a candidate-list
 * shape).
 *
 * The class lives in `errors.ts` rather than as a generic
 * `ValidationError` because the diagnostic shape is different: a
 * `ValidationError` says "the inputs you passed are wrong"; this
 * error says "the inputs are fine, but the store you wired up
 * doesn't support what you're asking for." Different fix, different
 * documentation.
 */
export class StoreCapabilityError extends NoydbError {
  /** The store method/capability that was missing. */
  readonly capability: string

  constructor(capability: string, callerApi: string, storeName?: string) {
    super(
      'STORE_CAPABILITY',
      `${callerApi} requires the optional store capability "${capability}" ` +
        `but the active store${storeName ? ` (${storeName})` : ''} does not implement it. ` +
        `Use a store that supports "${capability}" (store-memory, store-file) or pass an explicit ` +
        `vault list to bypass enumeration.`,
    )
    this.name = 'StoreCapabilityError'
    this.capability = capability
  }
}

export class PrivilegeEscalationError extends NoydbError {
  readonly offendingCollection: string

  constructor(offendingCollection: string, message?: string) {
    super(
      'PRIVILEGE_ESCALATION',
      message ??
        `Privilege escalation: grantor has no DEK for collection "${offendingCollection}" and cannot grant access to it.`,
    )
    this.name = 'PrivilegeEscalationError'
    this.offendingCollection = offendingCollection
  }
}

/**
 * Thrown by `Collection.put` / `.delete` when the target record's
 * envelope `_ts` falls within a closed accounting period (v0.17 #201).
 *
 * Distinct from `ReadOnlyError` (keyring-level), `ReadOnlyAtInstantError`
 * (historical view), and `ReadOnlyFrameError` (shadow vault): this
 * error is about the STORED RECORD being sealed by an operator call
 * to `vault.closePeriod()`, independent of caller permissions or
 * view type. The `periodName` and `endDate` fields name the sealing
 * period so audit UIs can surface a "this record is locked in
 * FY2026-Q1 (closed 2026-03-31)" message without parsing the error
 * string.
 *
 * To apply a correction after close, book a compensating entry in a
 * new period rather than unlocking the old one. Re-opening a closed
 * period is deliberately unsupported.
 */
export class PeriodClosedError extends NoydbError {
  readonly periodName: string
  readonly endDate: string
  readonly recordTs: string

  constructor(periodName: string, endDate: string, recordTs: string) {
    super(
      'PERIOD_CLOSED',
      `Cannot modify record (last written ${recordTs}) — sealed by closed period ` +
        `"${periodName}" (endDate: ${endDate}). Post a compensating entry in a ` +
        `new period instead.`,
    )
    this.name = 'PeriodClosedError'
    this.periodName = periodName
    this.endDate = endDate
    this.recordTs = recordTs
  }
}

// ─── Hierarchical Access Errors (v0.18 #205–#210) ─────────────────────

/**
 * Thrown when a user tries to act at a tier they are not cleared for.
 *
 * This is the umbrella error for tier write refusals:
 *   - `put({ tier: N })` when the user's keyring lacks tier-N DEK.
 *   - `elevate(id, N)` when the caller cannot reach tier N.
 *
 * Distinct from `TierAccessDeniedError` which covers *read* refusals on
 * the invisibility/ghost path.
 */
export class TierNotGrantedError extends NoydbError {
  readonly tier: number
  readonly collection: string

  constructor(collection: string, tier: number) {
    super(
      'TIER_NOT_GRANTED',
      `User has no DEK for tier ${tier} in collection "${collection}"`,
    )
    this.name = 'TierNotGrantedError'
    this.collection = collection
    this.tier = tier
  }
}

/**
 * Thrown when `demote()` is called by someone who is not the original
 * elevator and not an owner.
 */
export class TierDemoteDeniedError extends NoydbError {
  constructor(id: string, tier: number) {
    super(
      'TIER_DEMOTE_DENIED',
      `Only the original elevator or an owner can demote record "${id}" from tier ${tier}`,
    )
    this.name = 'TierDemoteDeniedError'
  }
}

/**
 * Thrown when `db.delegate()` is called against a user that has no
 * keyring in the target vault — the delegation token cannot be
 * constructed without the target user's KEK wrap.
 */
export class DelegationTargetMissingError extends NoydbError {
  readonly toUser: string

  constructor(toUser: string) {
    super(
      'DELEGATION_TARGET_MISSING',
      `Delegation target user "${toUser}" has no keyring in this vault`,
    )
    this.name = 'DelegationTargetMissingError'
    this.toUser = toUser
  }
}

// ─── Sync Errors ───────────────────────────────────────────────────────

/**
 * Thrown when a `put()` detects an optimistic concurrency conflict.
 *
 * NOYDB uses version numbers (`_v`) for optimistic locking. If a `put()`
 * is called with `expectedVersion: N` but the stored record is at version
 * `M ≠ N`, the write is rejected and the caller must re-read, re-apply their
 * change, and retry. The `version` field carries the actual stored version
 * so callers can decide whether to retry or surface the conflict to the user.
 */
export class ConflictError extends NoydbError {
  /** The actual stored version at the time of conflict. */
  readonly version: number

  constructor(version: number, message = 'Version conflict') {
    super('CONFLICT', message)
    this.name = 'ConflictError'
    this.version = version
  }
}

/**
 * Thrown when a bundle push is rejected because the remote has been updated
 * since the local bundle was last pulled.
 *
 * Unlike `ConflictError` (per-record), this is a whole-bundle conflict —
 * the remote's bundle handle has changed. The caller must pull the new
 * bundle, merge, and re-push. `remoteVersion` is the handle of the newer
 * remote bundle for use in diagnostics.
 */
export class BundleVersionConflictError extends NoydbError {
  /** The bundle handle of the newer remote version that rejected the push. */
  readonly remoteVersion: string

  constructor(remoteVersion: string, message = 'Bundle version conflict — remote has been updated') {
    super('BUNDLE_VERSION_CONFLICT', message)
    this.name = 'BundleVersionConflictError'
    this.remoteVersion = remoteVersion
  }
}

/**
 * Thrown when a sync operation (push or pull) fails due to a network error.
 *
 * NOYDB's offline-first design means network errors are expected during sync.
 * Callers should catch `NetworkError`, surface connectivity status in the UI,
 * and rely on the `SyncScheduler` to retry when connectivity is restored.
 */
export class NetworkError extends NoydbError {
  constructor(message = 'Network error') {
    super('NETWORK_ERROR', message)
    this.name = 'NetworkError'
  }
}

// ─── Data Errors ───────────────────────────────────────────────────────

/**
 * Thrown when `collection.get(id)` is called with an ID that does not exist.
 *
 * NOYDB collections are memory-first, so this error is synchronous and cheap —
 * it does not make a network round-trip. Callers that expect the record to be
 * absent should use `collection.getOrNull(id)` instead.
 */
export class NotFoundError extends NoydbError {
  constructor(message = 'Record not found') {
    super('NOT_FOUND', message)
    this.name = 'NotFoundError'
  }
}

/**
 * Thrown when application-level validation fails before encryption.
 *
 * Distinct from `SchemaValidationError` (Standard Schema v1 validator)
 * and `MissingTranslationError` (i18nText). `ValidationError` is the
 * general-purpose validation base — use it for custom guards in `put()`
 * hooks or store middleware.
 */
export class ValidationError extends NoydbError {
  constructor(message = 'Validation error') {
    super('VALIDATION_ERROR', message)
    this.name = 'ValidationError'
  }
}

/**
 * Thrown when a Standard Schema v1 validator rejects a record on
 * `put()` (input validation) or on read (output validation). Carries
 * the raw issue list so callers can render field-level errors.
 *
 * `direction` distinguishes the two cases:
 *   - `'input'`: the user passed bad data into `put()`. This is a
 *     normal error case that application code should handle — typically
 *     by showing validation messages in the UI.
 *   - `'output'`: stored data does not match the current schema. This
 *     indicates a schema drift (the schema was changed without
 *     migrating the existing records) and should be treated as a bug
 *     — the application should not swallow it silently.
 *
 * The `issues` type is deliberately `readonly unknown[]` on this class
 * so that `errors.ts` doesn't need to import from `schema.ts` (and
 * create a dependency cycle). Callers who know they're holding a
 * `SchemaValidationError` can cast to the more precise
 * `readonly StandardSchemaV1Issue[]` from `schema.ts`.
 */
export class SchemaValidationError extends NoydbError {
  readonly issues: readonly unknown[]
  readonly direction: 'input' | 'output'

  constructor(
    message: string,
    issues: readonly unknown[],
    direction: 'input' | 'output',
  ) {
    super('SCHEMA_VALIDATION_FAILED', message)
    this.name = 'SchemaValidationError'
    this.issues = issues
    this.direction = direction
  }
}

// ─── Query DSL Errors ─────────────────────────────────────────────────

/**
 * Thrown when `.groupBy().aggregate()` produces more than the hard
 * cardinality cap (default 100_000 groups). v0.6 #98.
 *
 * The cap exists because `.groupBy()` materializes one bucket per
 * distinct key value in memory, and runaway cardinality — a groupBy
 * on a high-uniqueness field like `id` or `createdAt` — is almost
 * always a query mistake rather than legitimate use. A hard error is
 * better than silent OOM: the consumer sees an actionable message
 * naming the field and the observed cardinality, with guidance to
 * either narrow the query with `.where()` or accept the ceiling
 * override.
 *
 * A separate one-shot warning fires at 10% of the cap (10_000
 * groups) so consumers get a heads-up before the hard error — same
 * pattern as `JoinTooLargeError` and the `.join()` row ceiling.
 *
 * **Not overridable in v0.6.** The 100k cap is a fixed constant so
 * the failure mode is consistent across the codebase; a
 * `{ maxGroups }` override can be added later without a break if a
 * real consumer asks.
 */
export class GroupCardinalityError extends NoydbError {
  /** The field being grouped on. */
  readonly field: string
  /** Observed number of distinct groups at the moment the cap tripped. */
  readonly cardinality: number
  /** The cap that was exceeded. */
  readonly maxGroups: number

  constructor(field: string, cardinality: number, maxGroups: number) {
    super(
      'GROUP_CARDINALITY',
      `.groupBy("${field}") produced ${cardinality} distinct groups, ` +
        `exceeding the ${maxGroups}-group ceiling. This is almost always a ` +
        `query mistake — grouping on a high-uniqueness field like "id" or ` +
        `"createdAt" produces one bucket per record. Narrow the query with ` +
        `.where() before grouping, or group on a lower-cardinality field ` +
        `(status, category, clientId). If you genuinely need high-cardinality ` +
        `grouping, file an issue with your use case.`,
    )
    this.name = 'GroupCardinalityError'
    this.field = field
    this.cardinality = cardinality
    this.maxGroups = maxGroups
  }
}

/**
 * Thrown in lazy mode when a `.query()` / `.where()` / `.orderBy()` clause
 * references a field that does not have a declared index.
 *
 * Lazy-mode queries only work when every touched field is indexed.
 * This is deliberate — silent scan-fallback would hide the performance
 * cliff that lazy-mode indexes exist to prevent.
 *
 * Payload:
 * - `collection` — name of the collection queried
 * - `touchedFields` — every field referenced by the query (filter + order)
 * - `missingFields` — subset of `touchedFields` that have no declared index
 */
export class IndexRequiredError extends NoydbError {
  readonly collection: string
  readonly touchedFields: readonly string[]
  readonly missingFields: readonly string[]

  constructor(args: { collection: string; touchedFields: readonly string[]; missingFields: readonly string[] }) {
    super(
      'INDEX_REQUIRED',
      `Collection "${args.collection}": query references unindexed fields in lazy mode ` +
      `(missing: ${args.missingFields.join(', ')}). ` +
      `Declare an index on each field, or use collection.scan() for non-indexed iteration.`,
    )
    this.name = 'IndexRequiredError'
    this.collection = args.collection
    this.touchedFields = [...args.touchedFields]
    this.missingFields = [...args.missingFields]
  }
}

/**
 * Thrown (or surfaced via the `index:write-partial` event) when one or more
 * per-indexed-field side-car writes fail after the main record write has
 * already succeeded.
 *
 * Not thrown out of `.put()` / `.delete()` directly — those succeed when the
 * main record succeeds. Instead, `IndexWriteFailure` instances are collected
 * into the session-scoped reconcile queue and emitted on the Collection
 * emitter as `index:write-partial`.
 *
 * Payload:
 * - `recordId` — the id of the main record whose side-car writes failed
 * - `field` — the indexed field whose side-car write failed
 * - `op` — `'put'` or `'delete'`, indicating which mutation was in flight
 * - `cause` — the underlying error from the store
 */
export class IndexWriteFailure extends NoydbError {
  readonly recordId: string
  readonly field: string
  readonly op: 'put' | 'delete'
  override readonly cause: unknown

  constructor(args: { recordId: string; field: string; op: 'put' | 'delete'; cause: unknown }) {
    super(
      'INDEX_WRITE_FAILURE',
      `Index side-car ${args.op} failed for field "${args.field}" on record "${args.recordId}"`,
    )
    this.name = 'IndexWriteFailure'
    this.recordId = args.recordId
    this.field = args.field
    this.op = args.op
    this.cause = args.cause
  }
}

// ─── Bundle Format Errors (v0.6 #100) ─────────────────────────────────

/**
 * Thrown by `readNoydbBundle()` when the body bytes don't match
 * the integrity hash declared in the bundle header — i.e. someone
 * modified the bytes between write and read.
 *
 * Distinct from a generic `Error` (which would be thrown for
 * format violations like a missing magic prefix or malformed
 * header JSON) so consumers can pattern-match the corruption case
 * and handle it differently from a producer bug. A
 * `BundleIntegrityError` indicates "the bytes you got are not
 * what was written"; a plain `Error` from `parsePrefixAndHeader`
 * indicates "what was written wasn't a valid bundle in the first
 * place."
 *
 * Also thrown when decompression fails after the integrity hash
 * passed — that's a producer bug (the wrong algorithm byte was
 * written) but it surfaces with the same error class because the
 * end result is "the body cannot be turned back into a dump."
 */
export class BundleIntegrityError extends NoydbError {
  constructor(message: string) {
    super('BUNDLE_INTEGRITY', `.noydb bundle integrity check failed: ${message}`)
    this.name = 'BundleIntegrityError'
  }
}

// ─── i18n / Dictionary Errors (v0.8 #81 #82) ──────────────────────────

/**
 * Thrown when `vault.collection()` is called with a name that is
 * reserved for NOYDB internal use (any name starting with `_dict_`).
 *
 * Dictionary collections are accessed exclusively via
 * `vault.dictionary(name)` — attempting to open one as a regular
 * collection would bypass the dictionary invariants (ACL, rename
 * tracking, reserved-name policy).
 */
export class ReservedCollectionNameError extends NoydbError {
  /** The rejected collection name. */
  readonly collectionName: string

  constructor(collectionName: string) {
    super(
      'RESERVED_COLLECTION_NAME',
      `"${collectionName}" is a reserved collection name. ` +
        `Use vault.dictionary("${collectionName.replace(/^_dict_/, '')}") ` +
        `to access dictionary collections.`,
    )
    this.name = 'ReservedCollectionNameError'
    this.collectionName = collectionName
  }
}

/**
 * Thrown by `DictionaryHandle.get()` and `DictionaryHandle.delete()` when
 * the requested key does not exist in the dictionary.
 *
 * Distinct from `NotFoundError` (which is for data records) so callers
 * can distinguish "data record missing" from "dictionary key missing"
 * without inspecting error messages.
 */
export class DictKeyMissingError extends NoydbError {
  /** The dictionary name. */
  readonly dictionaryName: string
  /** The key that was not found. */
  readonly key: string

  constructor(dictionaryName: string, key: string) {
    super(
      'DICT_KEY_MISSING',
      `Dictionary "${dictionaryName}" has no entry for key "${key}".`,
    )
    this.name = 'DictKeyMissingError'
    this.dictionaryName = dictionaryName
    this.key = key
  }
}

/**
 * Thrown by `DictionaryHandle.delete()` in strict mode when the key to
 * be deleted is still referenced by one or more records.
 *
 * The caller must either rename the key first (the only sanctioned
 * mass-mutation path) or pass `{ mode: 'warn' }` to skip the check
 * (development only).
 */
export class DictKeyInUseError extends NoydbError {
  /** The dictionary name. */
  readonly dictionaryName: string
  /** The key that is still referenced. */
  readonly key: string
  /** Name of the first collection found to reference this key. */
  readonly usedBy: string
  /** Number of records in `usedBy` that reference this key. */
  readonly count: number

  constructor(
    dictionaryName: string,
    key: string,
    usedBy: string,
    count: number,
  ) {
    super(
      'DICT_KEY_IN_USE',
      `Cannot delete key "${key}" from dictionary "${dictionaryName}": ` +
        `${count} record(s) in "${usedBy}" still reference it. ` +
        `Use dictionary.rename("${key}", newKey) to rewrite references first.`,
    )
    this.name = 'DictKeyInUseError'
    this.dictionaryName = dictionaryName
    this.key = key
    this.usedBy = usedBy
    this.count = count
  }
}

/**
 * Thrown by `Collection.put()` when an `i18nText` field is missing one
 * or more required translations.
 *
 * The `missing` array names each locale code that was absent from the
 * field value. The `field` property names the field so callers can
 * render a field-level error message without parsing the string.
 */
export class MissingTranslationError extends NoydbError {
  /** The field name whose translation(s) are missing. */
  readonly field: string
  /** Locale codes that were required but absent. */
  readonly missing: readonly string[]

  constructor(field: string, missing: readonly string[], message?: string) {
    super(
      'MISSING_TRANSLATION',
      message ??
        `Field "${field}": missing required translation(s): ${missing.join(', ')}.`,
    )
    this.name = 'MissingTranslationError'
    this.field = field
    this.missing = missing
  }
}

/**
 * Thrown when reading an `i18nText` field without specifying a locale —
 * either at the call site (`get(id, { locale })`) or on the vault
 * (`openVault(name, { locale })`).
 *
 * Also thrown when `resolveI18nText()` exhausts the fallback chain and
 * no translation is available for the requested locale.
 *
 * The `field` property names the field that triggered the error so the
 * caller can surface it in the UI.
 */
export class LocaleNotSpecifiedError extends NoydbError {
  /** The field name that required a locale. */
  readonly field: string

  constructor(field: string, message?: string) {
    super(
      'LOCALE_NOT_SPECIFIED',
      message ??
        `Cannot read i18nText field "${field}" without a locale. ` +
        `Pass { locale } to get()/list()/query() or set a default via ` +
        `openVault(name, { locale }).`,
    )
    this.name = 'LocaleNotSpecifiedError'
    this.field = field
  }
}

// ─── Translator Errors (v0.8 #83) ─────────────────────────────────────

/**
 * Thrown when a collection has an `i18nText` field with
 * `autoTranslate: true` but no `plaintextTranslator` was configured
 * on `createNoydb()`.
 *
 * The error is raised at `put()` time (not at schema construction) so
 * the mis-configuration is surfaced by the first write rather than
 * silently at startup.
 */
export class TranslatorNotConfiguredError extends NoydbError {
  /** The field that requested auto-translation. */
  readonly field: string
  /** The collection the put was targeting. */
  readonly collection: string

  constructor(field: string, collection: string) {
    super(
      'TRANSLATOR_NOT_CONFIGURED',
      `Field "${field}" in collection "${collection}" has autoTranslate: true, ` +
        `but no plaintextTranslator was configured on createNoydb(). ` +
        `Either configure a plaintextTranslator or remove autoTranslate from the schema.`,
    )
    this.name = 'TranslatorNotConfiguredError'
    this.field = field
    this.collection = collection
  }
}

// ─── Backup Errors (v0.4 #46) ─────────────────────────────────────────

/**
 * Thrown when `Vault.load()` finds that a backup's hash chain
 * doesn't verify, or that its embedded `ledgerHead.hash` doesn't
 * match the chain head reconstructed from the loaded entries.
 *
 * Distinct from `BackupCorruptedError` so callers can choose to
 * recover from one but not the other (e.g., a corrupted JSON file is
 * unrecoverable; a chain mismatch might mean the backup is from an
 * incompatible noy-db version).
 */
export class BackupLedgerError extends NoydbError {
  /** First-broken-entry index, if known. */
  readonly divergedAt?: number

  constructor(message: string, divergedAt?: number) {
    super('BACKUP_LEDGER', message)
    this.name = 'BackupLedgerError'
    if (divergedAt !== undefined) this.divergedAt = divergedAt
  }
}

/**
 * Thrown when `Vault.load()` finds that the backup's data
 * collection content doesn't match the ledger's recorded
 * `payloadHash`es. This is the "envelope was tampered with after
 * dump" detection — the chain itself can be intact, but if any
 * encrypted record bytes were swapped, this check catches it.
 */
export class BackupCorruptedError extends NoydbError {
  /** The (collection, id) pair whose envelope failed the hash check. */
  readonly collection: string
  readonly id: string

  constructor(collection: string, id: string, message: string) {
    super('BACKUP_CORRUPTED', message)
    this.name = 'BackupCorruptedError'
    this.collection = collection
    this.id = id
  }
}

// ─── Session Errors (v0.7 #109) ───────────────────────────────────────

/**
 * Thrown by `resolveSession()` when the session token's `expiresAt`
 * timestamp is in the past. The session key is also removed from the
 * in-memory store when this is thrown, so retrying with the same sessionId
 * will produce `SessionNotFoundError`.
 *
 * Separate from `SessionNotFoundError` so callers can distinguish between
 * "session is gone" (key store cleared, tab reloaded) and "session is
 * still in the store but has exceeded its lifetime" (idle timeout, absolute
 * timeout, policy-driven expiry). The remediation differs: expired sessions
 * should prompt a fresh unlock; not-found sessions may indicate a bug or a
 * cross-tab scenario where the session was never established.
 */
export class SessionExpiredError extends NoydbError {
  readonly sessionId: string

  constructor(sessionId: string) {
    super('SESSION_EXPIRED', `Session "${sessionId}" has expired. Re-unlock to continue.`)
    this.name = 'SessionExpiredError'
    this.sessionId = sessionId
  }
}

/**
 * Thrown by `resolveSession()` when the session key cannot be found in
 * the module-level store. This happens when:
 *   - The session was explicitly revoked via `revokeSession()`.
 *   - The JS context was reloaded (tab navigation, page refresh, worker restart).
 *   - `Noydb.close()` was called (which calls `revokeAllSessions()`).
 *   - The sessionId is wrong or was generated by a different JS context.
 *
 * The session token (if the caller holds it) is permanently useless after
 * this error — the key is gone and cannot be recovered.
 */
export class SessionNotFoundError extends NoydbError {
  readonly sessionId: string

  constructor(sessionId: string) {
    super('SESSION_NOT_FOUND', `Session key for "${sessionId}" not found. The session may have been revoked or the page reloaded.`)
    this.name = 'SessionNotFoundError'
    this.sessionId = sessionId
  }
}

/**
 * Thrown when a session policy blocks an operation — for example,
 * `requireReAuthFor: ['export']` is set and the caller attempts to
 * call `exportStream()` without re-authenticating for this session.
 *
 * The `operation` field names the specific operation that was blocked
 * (e.g. `'export'`, `'grant'`, `'rotate'`) so the caller can surface
 * a targeted prompt ("Please re-enter your passphrase to export data").
 */
export class SessionPolicyError extends NoydbError {
  readonly operation: string

  constructor(operation: string, message?: string) {
    super(
      'SESSION_POLICY',
      message ?? `Operation "${operation}" requires re-authentication per the active session policy.`,
    )
    this.name = 'SessionPolicyError'
    this.operation = operation
  }
}

// ─── Query / Join Errors (v0.6 #73) ────────────────────────────────────

/**
 * Thrown when a `.join()` would exceed its configured row ceiling on
 * either side. The ceiling defaults to 50,000 per side and can be
 * overridden via the `{ maxRows }` option on `.join()`.
 *
 * Carries both row counts so the error message can show which side
 * tripped the limit (e.g. "left had 60,000 rows, right had 1,200,
 * max was 50,000"). The `side` field is machine-readable so test
 * code and devtools can match on it without regex-parsing the
 * message.
 *
 * The row ceiling exists because v0.6 joins are bounded in-memory
 * operations over materialized record sets. Consumers whose
 * collections genuinely exceed the ceiling should track #76
 * (streaming joins over `scan()`) or filter the left side further
 * with `where()` / `limit()` before joining.
 */
export class JoinTooLargeError extends NoydbError {
  readonly leftRows: number
  readonly rightRows: number
  readonly maxRows: number
  readonly side: 'left' | 'right'

  constructor(opts: {
    leftRows: number
    rightRows: number
    maxRows: number
    side: 'left' | 'right'
    message: string
  }) {
    super('JOIN_TOO_LARGE', opts.message)
    this.name = 'JoinTooLargeError'
    this.leftRows = opts.leftRows
    this.rightRows = opts.rightRows
    this.maxRows = opts.maxRows
    this.side = opts.side
  }
}

/**
 * Thrown by `.join()` in strict `ref()` mode when a left-side record
 * points at a right-side id that does not exist in the target
 * collection.
 *
 * Distinct from `RefIntegrityError` so test code can pattern-match
 * on the *read-time* dangling case without catching *write-time*
 * integrity violations. Both indicate "ref points at nothing" but
 * happen at different lifecycle phases and deserve different
 * remediation in documentation: a RefIntegrityError on `put()`
 * means the input is invalid; a DanglingReferenceError on `.join()`
 * means stored data has drifted and `vault.checkIntegrity()`
 * is the right tool to find the full set of orphans.
 */
export class DanglingReferenceError extends NoydbError {
  readonly field: string
  readonly target: string
  readonly refId: string

  constructor(opts: {
    field: string
    target: string
    refId: string
    message: string
  }) {
    super('DANGLING_REFERENCE', opts.message)
    this.name = 'DanglingReferenceError'
    this.field = opts.field
    this.target = opts.target
    this.refId = opts.refId
  }
}
