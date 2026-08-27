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
 *       │    ├─ InvalidKeyError        — wrong secret / corrupt keyring
 *       │    ├─ KeyringCorruptError    — partial DEK corruption, KEK correct
 *       │    └─ KeyringTamperedError   — keyring roster failed authentication (#1096)
 *       ├─ Access errors
 *       │    ├─ NoAccessError          — no DEK for this collection
 *       │    ├─ ReadOnlyError          — ro permission, write attempted
 *       │    ├─ PermissionDeniedError  — role too low for operation
 *       │    ├─ PrivilegeEscalationError — grant wider than grantor holds
 *       │    └─ StoreCapabilityError   — optional store method missing
 *       ├─ Sync errors
 *       │    ├─ ConflictError          — optimistic-lock version mismatch
 *       │    ├─ PodVersionConflictError — bundle push rejected by remote
 *       │    └─ NetworkError           — push/pull network failure
 *       ├─ Data errors
 *       │    ├─ NotFoundError          — get(id) on missing record
 *       │    ├─ ValidationError        — application-level guard failed
 *       │    └─ SchemaValidationError  — Standard Schema v1 rejection
 *       ├─ Query errors
 *       │    ├─ JoinTooLargeError                — join row ceiling exceeded
 *       │    ├─ CrossJoinTooLargeError            — cross-join row ceiling exceeded
 *       │    ├─ CrossJoinSourceUnknownError       — target collection not in vault
 *       │    ├─ DanglingReferenceError            — strict ref() points at nothing
 *       │    ├─ GroupCardinalityError             — groupBy bucket cap exceeded
 *       │    ├─ IndexRequiredError                — lazy-mode query touches unindexed field
 *       │    ├─ IndexWriteFailureError            — index side-car put/delete failed post-main
 *       │    ├─ UniqueConstraintError             — duplicate value on unique index
 *       │    ├─ UnsupportedIndexOptionError       — unique+lazy or unique+crdt at registration
 *       │    └─ FieldNotQueryableError            — field's Via posture is queryable: 'none'
 *       ├─ i18n / Dictionary errors
 *       │    ├─ ReservedCollectionNameError
 *       │    ├─ DictKeyMissingError
 *       │    ├─ DictKeyInUseError
 *       │    ├─ RestrictRefUnresolvableError — restrict edge's compare-key unresolvable (#654)
 *       │    ├─ MissingTranslationError
 *       │    ├─ LocaleNotSpecifiedError
 *       │    ├─ ScriptViolationError
 *       │    ├─ StaticDictReadonlyError
 *       │    ├─ UnknownDictCodeError
 *       │    ├─ UnknownLookupKeyError
 *       │    └─ TranslatorNotConfiguredError
 *       ├─ Backup errors
 *       │    ├─ BackupLedgerError      — hash-chain verification failed
 *       │    └─ BackupCorruptedError   — envelope hash mismatch in dump
 *       ├─ Bundle errors
 *       │    └─ PodIntegrityError   — .noydb body sha256 mismatch
 *       ├─ Session errors
 *       │    ├─ SessionExpiredError
 *       │    ├─ SessionNotFoundError
 *       │    └─ SessionPolicyError
 *       ├─ Snapshot errors
 *       │    └─ SnapshotNotFoundError  — snapshot key absent from snapshot store
 *       └─ Computed field errors
 *            └─ ComputedFieldError     — computed function threw during a write
 *       └─ Erasure errors
 *            └─ ForgetStrategyNotConfiguredError — vault.forget() with no withForget
 *       ├─ Sealed-record errors (record-scoped CEK sealing)
 *       │    ├─ SealedRecordExpiredError  — sealed CEK binding past expiresAt
 *       │    ├─ SealedRecordMismatchError — CEK sealed for record A used on record B
 *       │    └─ RecordCekNotFoundError    — record missing or no per-record `_cek`
 *       └─ Embedding errors
 *            ├─ EmbeddingDimMismatchError           — stored vector dim ≠ descriptor dim
 *            └─ EmbeddingModelMismatchError         — stored vector model tag ≠ descriptor model
 * ```
 *
 * ## Catching all NOYDB errors
 *
 * ```ts
 * import { NoydbError, InvalidKeyError, ConflictError } from '@noy-db/hub'
 *
 * try {
 *   await vault.unlock(secret)
 * } catch (e) {
 *   if (e instanceof InvalidKeyError) { showBadSecretUI(); return }
 *   if (e instanceof NoydbError) { logToSentry(e.code, e); return }
 *   throw e  // unexpected — re-throw
 * }
 * ```
 *
 * @module
 */

import { USER_ENVELOPE_MAX_BYTES } from './constants.js'
import type { GateName, GatePolicy } from './types.js'

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

// ─── Debug-mode Errors ─────────────────────────────────────────────────

/**
 * Thrown at construction when `debugPlaintext: true` is combined with
 * encryption (`encrypt` not `false`). Debug-plaintext writes records in
 * cleartext laid out for native store inspection; it is meaningless and
 * unsafe under encryption, so the coupling is rejected loudly rather than
 * silently ignored.
 */
export class DebugPlaintextError extends NoydbError {
  constructor(message = 'debugPlaintext requires encrypt: false') {
    super('DEBUG_PLAINTEXT_REQUIRES_UNENCRYPTED', message)
    this.name = 'DebugPlaintextError'
  }
}

/**
 * Thrown when a record written under `debugPlaintext` carries a top-level
 * field whose name starts with `_`. Debug mode inlines record fields beside
 * the reserved `_`-prefixed envelope metadata, so a `_`-prefixed record field
 * would collide with metadata. The `_` namespace is reserved by NOYDB
 * regardless; rename the field.
 */
export class DebugReservedFieldError extends NoydbError {
  constructor(collection: string, field: string) {
    super(
      'DEBUG_RESERVED_FIELD',
      `Record in "${collection}" has reserved field "${field}": the _ prefix is reserved under debugPlaintext mode`,
    )
    this.name = 'DebugReservedFieldError'
  }
}

// ─── Crypto Errors ─────────────────────────────────────────────────────

/**
 * Thrown when AES-GCM decryption fails.
 *
 * The most common cause is a wrong secret or a corrupted ciphertext.
 * A `DecryptionError` at the wrong secret level is caught internally
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
  /**
   * Why the tag check failed, when the enclave could tell (#1103).
   *
   * `'unbound-legacy-format'` — the body opens under an EMPTY AAD, so it was
   * sealed before identity binding (#1041) and this is a format transition, not
   * an attack. Positive evidence, not a guess: producing a body that decrypts
   * under this DEK requires the DEK, which an untrusted store does not hold.
   *
   * Absent — no benign explanation was found. Treat as the security alert this
   * error has always been.
   *
   * The field is additive and the throw is unchanged, so
   * `catch (e) { if (e instanceof TamperedError) … }` keeps working; callers
   * that want to tell a migration from a breach can now read this.
   */
  readonly reason?: 'unbound-legacy-format'

  constructor(
    message = 'Data integrity check failed — record may have been tampered with',
    reason?: 'unbound-legacy-format',
  ) {
    super('TAMPERED', message)
    this.name = 'TamperedError'
    if (reason !== undefined) this.reason = reason
  }
}

/**
 * Thrown when key unwrapping fails, typically because the secret is wrong
 * or the keyring file is corrupted.
 *
 * NOYDB uses AES-KW (RFC 3394) to wrap DEKs with the KEK. If AES-KW
 * unwrapping fails, it means either the KEK was derived from the wrong
 * secret (PBKDF2 with 600K iterations) or the keyring bytes are
 * corrupted. This is the error shown to the user on a failed unlock attempt.
 */
export class InvalidKeyError extends NoydbError {
  constructor(message = 'Invalid key — wrong secret or corrupted keyring') {
    super('INVALID_KEY', message)
    this.name = 'InvalidKeyError'
  }
}

/**
 * Thrown when a keyring's wrapped-DEK set unwraps partially — at least
 * one DEK succeeds (proving the KEK is correct) but at least one fails.
 * The secret is right; the failed entries are corrupted.
 *
 * This is distinct from {@link InvalidKeyError} so that
 * `NoydbOptions.onInvalidKey: 'reset'` does NOT fire — resetting on
 * partial corruption would destroy the still-valid DEKs and the data
 * they protect, which is silent data loss in response to a feature
 * designed for stale-credential recovery.
 */
export class KeyringCorruptError extends NoydbError {
  readonly failedCollections: readonly string[]
  readonly intactCount: number
  constructor(opts: { failedCollections: readonly string[]; intactCount: number; message?: string }) {
    super(
      'KEYRING_CORRUPT',
      opts.message ??
        `Keyring has ${opts.failedCollections.length} corrupted wrapped DEK(s) ` +
          `(${opts.failedCollections.join(', ')}); ${opts.intactCount} other DEK(s) ` +
          `unwrapped successfully — the secret is correct, the entries are damaged. ` +
          `Do NOT use onInvalidKey: 'reset' here — that would destroy the intact DEKs.`,
    )
    this.name = 'KeyringCorruptError'
    this.failedCollections = opts.failedCollections
    this.intactCount = opts.intactCount
  }
}

/**
 * #1096 — the keyring's plaintext AUTHORITY half failed authentication.
 *
 * Thrown by `loadKeyring` when the canary is absent, when the reserved
 * roster-key DEK entry is absent, or when the keys check out (KEK proven
 * correct) but `roster_tag` is missing or does not match the file.
 *
 * Distinct from {@link KeyringCorruptError}: the KEYS are fine; the ROSTER —
 * `role`, `permissions`, `granted_by`, the capability grants — is what cannot
 * be trusted. A `_keyring` file is stored plaintext so admins can edit a
 * member's authority without holding that member's credential, which left
 * those fields authenticated by nothing; this error is what a hostile store
 * editing them now produces.
 *
 * Deliberately raised only AFTER the key-unwrap epilogue, so a plain
 * wrong-secret keeps reporting as `InvalidKeyError` and is never
 * misannounced to the user as an attack.
 */
/**
 * Why a `_keyring` file failed roster authentication (#1096).
 *
 * Named rather than inlined because a third consumer now reports it without
 * throwing: `RotateResult.unverified` (#1114) lists the members a rotation
 * skipped, and a union duplicated per call site drifts.
 */
export type KeyringTamperedReason =
  | 'canary-missing'
  | 'roster-key-missing'
  | 'roster-tag-missing'
  | 'roster-tag-mismatch'
  /**
   * The tag does not verify AND the file declares an older `_noydb_keyring`
   * than this build writes (#1115) — a format transition, not an attack.
   *
   * Split out of `roster-tag-mismatch` deliberately. That label carries the one
   * UNQUALIFIED accusation in this union, on the grounds that no released
   * version ever wrote a mismatched tag. Widening what the tag covers makes
   * that false for every vault written before the change, so without this the
   * most common cause of a mismatch — you upgraded — would be reported as
   * "the store has changed a member's role".
   *
   * CLASSIFICATION ONLY: the outcome is refusal either way, so a store that
   * rewrites the plaintext version field changes the wording and nothing else.
   */
  | 'format-superseded'
  /**
   * The caller supplied an expected roster epoch and the file carries NONE
   * (#1097). Distinct from `roster-epoch-rewound`, and the distinction is the
   * point: this is what a replay of a PRE-EPOCH file looks like. Reporting it
   * as a rewind would name an attack that may not have happened; collapsing it
   * into "fine" would accept exactly the replay the epoch exists to refuse.
   * Absence is UNKNOWN, never zero.
   */
  | 'roster-epoch-absent'
  /**
   * The file's roster epoch is OLDER than the floor the caller obtained out of
   * band (#1097) — a rewound roster, re-served by a store that kept a copy.
   * The one reason in this union a store cannot produce by editing: the epoch
   * is bound into `rosterCanonical`, so a rewound value arrives only on a file
   * that genuinely carried it.
   */
  | 'roster-epoch-rewound'
  /**
   * The file did not parse at all (#1121). Never thrown by
   * `assertRosterAuthenticated` — which cannot reach a file it could not read —
   * but reported by `verifyRoster` and accepted by `quarantineKeyring`, because
   * truncation and bitrot produce the most literally unauthenticatable file
   * there is and the tools for unauthenticatable files must not be the ones
   * that choke on it.
   */
  | 'unparseable'

/**
 * The user-facing text for a {@link KeyringTamperedError}.
 *
 * ## Why the absence cases do not lead with "your store attacked you"
 *
 * `roster_tag` and the `_roster` key ship for the first time in `0.6.0-pre.21`,
 * so **no keyring written by any earlier release carries either**. On the day a
 * vault upgrades, the base rate for these labels is ~100% benign — the user did
 * nothing but install a new version, and the format changed under them
 * (deliberately, with no migration: #1100 / ADR 0003 Decision 5).
 *
 * ## Why they are still refused, and why no discriminant is possible
 *
 * Do NOT read this as softening the policy. Absence is an alarm, not a skip: a
 * store that could opt out of verification by deleting a plaintext field would
 * make the whole scheme optional.
 *
 * And unlike `TamperedError`'s `'unbound-legacy-format'` (#1103), there is no
 * honest test to add here. That one works because the benign case must produce a
 * body that **decrypts under the DEK**, which an untrusted store cannot fabricate
 * — a successful retry is positive evidence. The keyring's benign case is a
 * **deleted field**, which a store produces trivially and with no key at all.
 * Verified by probe: stripping `_roster` and `roster_tag` from a genuine
 * `pre.21` file yields byte-identical output to opening a real `pre.20` vault.
 * So "absent means old and fine" would be a downgrade attack with extra steps.
 *
 * What is left is the wording. We cannot tell the two apart, so the message must
 * not pretend to — it names both readings and puts the likely one first, rather
 * than accusing the user's storage of an attack it cannot demonstrate.
 */
/**
 * The re-seed recovery, shared by every branch that asks for one. An existing
 * vault cannot self-heal: a client that bootstraps its local vault before
 * loading a bundle hits the stale keyring during setup, so 'open the new
 * bundle' fails and the reader is stuck following the instruction literally.
 */
const RE_SEED =
  ' To re-seed: REMOVE THE VAULT FROM THIS DEVICE FIRST, then import the new bundle. Importing' +
  ' over a vault that is still present does not heal it — the stale keyring is loaded during' +
  ' setup, before the import can replace it, so the same error is raised again.'

function keyringTamperedMessage(
  userId: string,
  reason: KeyringTamperedReason,
  format?: { readonly from: number; readonly to: number },
): string {
  const head = `Keyring for "${userId}" failed roster authentication (${reason}). `
  switch (reason) {
    case 'roster-epoch-absent':
      return (
        head +
        'The caller expected a roster epoch and this keyring carries none. That is what a replay ' +
        'of a keyring written before epochs existed looks like — it is NOT evidence of an attack ' +
        'on its own, and it is not treated as epoch zero either. Re-issue the credential that ' +
        'carries the expected epoch, or open without one if this vault predates the mechanism.'
      )
    case 'roster-epoch-rewound':
      return (
        head +
        'This keyring is OLDER than the roster epoch the caller obtained out of band — the store ' +
        'served a superseded roster. A narrowing re-grant overwrites in place, so an earlier, ' +
        'BROADER file was legitimately minted by this vault and replaying it restores the old ' +
        'role. Refusing is the point. The epoch is bound into the authenticated canonical, so ' +
        'this value was not edited by the store; it came from a genuine, superseded file.'
      )
    case 'canary-missing':
    case 'roster-key-missing':
    case 'roster-tag-missing':
      return (
        head +
        'This vault was most likely written before 0.6.0-pre.21, which is when the roster ' +
        'became authenticated — that format change ships without a migration, so an existing ' +
        'vault must be re-seeded. The same state is what an untrusted store would produce by ' +
        'deleting the field to escape verification, and the two are indistinguishable from ' +
        'here, so access is refused either way. If this vault has been opened by ' +
        '0.6.0-pre.21 or later before, treat it as the second case.' +
        RE_SEED
      )
    case 'unparseable':
      return (
        head +
        'The file did not parse — truncation or corruption in transit or at rest is the ' +
        'likeliest cause, and a store serving deliberate garbage is indistinguishable from it. ' +
        '`verifyRoster()` reports which members are affected; `quarantineKeyring()` removes one.'
      )
    case 'format-superseded':
      return (
        head +
        `This keyring declares ${format ? `keyring format ${format.from}` : 'an older keyring format'}; ` +
        `this build requires ${format ? String(format.to) : 'a newer one'}. The roster tag now ` +
        'protects a wider set of fields (the DEK key set joined it), so a genuine older tag ' +
        'cannot verify here. That format change ships without a migration, so an existing vault ' +
        'must be re-seeded.' +
        RE_SEED +
        ' Access is refused either way, and the version field this branch reads selects only the ' +
        'wording — never the decision — so a store cannot use it to weaken anything.'
      )
    case 'roster-tag-mismatch':
      return (
        head +
        'The roster tag is present but does not match the authority fields it protects, so ' +
        'those fields were altered after they were signed. Unlike a missing tag this is not a ' +
        'format-transition state — a same-format mismatch is one no released version ever ' +
        'wrote (an older FORMAT reports `format-superseded` instead) — so the store ' +
        'serving this vault, or something between you and it, has changed a member\'s role, ' +
        'permissions or expiry.'
      )
  }
}

export class KeyringTamperedError extends NoydbError {
  readonly details: {
    readonly userId: string
    readonly reason: KeyringTamperedReason
    /**
     * The keyring format transition, when one is known: `from` is the version
     * the FILE declares, `to` the version this build writes.
     *
     * Present so a reader can tell which version they hold and which one this
     * build wants, without reverse-engineering it from the prose. The message
     * said "an OLDER FORMAT" and never named either number, which is not
     * enough to work out whether you are one release behind or five.
     *
     * Structured, not parsed out of the message: a consumer that translates
     * the error never sees the English at all.
     */
    readonly format?: { readonly from: number; readonly to: number }
  }
  constructor(details: {
    readonly userId: string
    readonly reason: KeyringTamperedReason
    readonly format?: { readonly from: number; readonly to: number }
  }) {
    super('KEYRING_TAMPERED', keyringTamperedMessage(details.userId, details.reason, details.format))
    this.name = 'KeyringTamperedError'
    this.details = details
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
 * mechanism or a ledger-history rewrite (which breaks
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
 * required capability bit on the invoking keyring.
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
 * Thrown when a keyring file's `expires_at` cutoff has passed.
 * Surfaced by `loadKeyring` before any DEK unwrap is attempted —
 * past the cutoff the slot refuses to open even with the right
 * secret. Distinct from PBKDF2 / unwrap errors so consumer code
 * can show a precise "this bundle slot has expired" message instead
 * of the generic decryption-failure UX.
 *
 * Used predominantly on `PodRecipient` slots produced by
 * `writePod({ recipients: [...] })` to time-box audit access.
 */
export class KeyringExpiredError extends NoydbError {
  readonly userId: string
  readonly expiresAt: string
  constructor(opts: { userId: string; expiresAt: string }) {
    super(
      'KEYRING_EXPIRED',
      `Keyring "${opts.userId}" expired at ${opts.expiresAt}. ` +
        'The slot refuses to unlock past its expiry timestamp.',
    )
    this.name = 'KeyringExpiredError'
    this.userId = opts.userId
    this.expiresAt = opts.expiresAt
  }
}

/**
 * Thrown when a plain single-string secret is offered against an
 * echo-mode keyring. Echo keyrings unlock ONLY via the stepwise
 * ceremony (`beginEchoUnlock`) or a structured `EchoSecretParts`
 * value — never a single field (spec AG-1, #940).
 */
export class EchoCeremonyRequiredError extends NoydbError {
  constructor() {
    super(
      'ECHO_CEREMONY_REQUIRED',
      'This keyring uses an echo secret (3-part ceremony). ' +
        'A single-string secret can never unlock it — run the echo ceremony instead.',
    )
    this.name = 'EchoCeremonyRequiredError'
  }
}

/** Echo ceremony: the typed prompt failed its verifier. */
export class WrongPromptError extends NoydbError {
  constructor() {
    super('WRONG_PROMPT', 'Echo ceremony: the prompt does not match this keyring.')
    this.name = 'WrongPromptError'
  }
}

/** Echo ceremony (degraded path): the TYPED echo failed its verifier. */
export class WrongEchoError extends NoydbError {
  constructor() {
    super('WRONG_ECHO', 'Echo ceremony: the typed echo does not match this keyring.')
    this.name = 'WrongEchoError'
  }
}

/**
 * Thrown when an `@noy-db/as-*` import is attempted but the invoking
 * keyring lacks the required import-capability bit.
 *
 * - `tier: 'plaintext'` — a plaintext-tier import (`as-csv`, `as-json`,
 *   `as-ndjson`, `as-zip`, …) was attempted but the keyring's
 *   `importCapability.plaintext` does not include the requested
 *   `format` (nor the `'*'` wildcard).
 * - `tier: 'bundle'` — a `.noydb` bundle import was attempted but the
 *   keyring's `importCapability.bundle` is not `true`.
 *
 * Default for every role on every dimension is closed — owners and
 * admins must positively grant the capability. Distinct from
 * `PermissionDeniedError` and `NoAccessError` so UI layers can show a
 * specific "request the import capability" flow.
 */
export class ImportCapabilityError extends NoydbError {
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
        ? `Import capability denied — keyring "${opts.userId}" is not granted plaintext-import capability for format "${opts.format ?? '<unknown>'}". Ask a vault owner or admin to grant it via vault.grant({ importCapability: { plaintext: ['${opts.format ?? '<format>'}'] } }).`
        : `Import capability denied — keyring "${opts.userId}" is not granted encrypted-bundle import capability. Ask a vault owner or admin to grant it via vault.grant({ importCapability: { bundle: true } }).`)
    super('IMPORT_CAPABILITY', msg)
    this.name = 'ImportCapabilityError'
    this.tier = opts.tier
    this.userId = opts.userId
    if (opts.format !== undefined) this.format = opts.format
  }
}

/**
 * Thrown when a grant would give the grantee a permission the grantor
 * does not themselves hold — the "admin cannot grant what admin cannot
 * do" rule from the admin-delegation work.
 *
 * Distinct from `PermissionDeniedError` so callers can tell the two
 * cases apart in logs and tests:
 *
 *   - `PermissionDeniedError` — "you are not allowed to perform this
 *     operation at all" (wrong role).
 *   - `PrivilegeEscalationError` — "you are allowed to grant, but not
 *     with these specific permissions" (widening attempt).
 *
 * Under the admin model the grantee of an admin-grants-admin call
 * inherits the caller's entire DEK set by construction, so this error
 * is structurally unreachable in typical flows. The check and error
 * class exist so that future per-collection admin scoping cannot
 * accidentally bypass the subset rule — the guard is already wired in.
 *
 * `offendingCollection` carries the first collection name that failed
 * the subset check, to make the violation actionable in error output.
 */
/**
 * Thrown when a caller invokes an API that requires an optional
 * store capability the active store does not implement.
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

/**
 * Thrown by `StoreLocator.resolve()` (the `@noy-db/hub/to` Locator seam,
 * #945) when a `StoreDescriptor.kind` has no registered factory. Names both
 * the offending kind and every kind currently registered on the locator, so
 * the fix — register the missing factory, or correct a typo'd kind string —
 * is visible without a debugger.
 */
export class UnknownStoreKindError extends NoydbError {
  /** The unregistered descriptor kind that was looked up. */
  readonly kind: string
  /** Every kind currently registered on the locator, for comparison. */
  readonly registeredKinds: readonly string[]

  constructor(kind: string, registeredKinds: readonly string[]) {
    super(
      'UNKNOWN_STORE_KIND',
      `No store factory is registered for kind "${kind}". Registered kinds: ` +
        `${registeredKinds.length > 0 ? registeredKinds.join(', ') : '(none)'}. ` +
        `Call locator.register("${kind}", factory) before resolving a descriptor of this kind.`,
    )
    this.name = 'UnknownStoreKindError'
    this.kind = kind
    this.registeredKinds = registeredKinds
  }
}

/**
 * Thrown by `StoreLocator.register()` (the `@noy-db/hub/to` Locator seam,
 * #945) when `kind` is already registered on the locator. A locator
 * registers each kind exactly once — a duplicate registration is almost
 * always a mistake (a copy-pasted setup block, two satellite packages
 * fighting over the same kind string) — so it fails loudly at the mistake's
 * source rather than silently overwriting (last-wins) and surfacing
 * confusion at some unrelated `resolve()` call later. Mirrors
 * `DuplicateBehaviorNameError`.
 */
export class DuplicateStoreKindError extends NoydbError {
  /** The kind string that was already registered. */
  readonly kind: string

  constructor(kind: string) {
    super(
      'DUPLICATE_STORE_KIND',
      `StoreLocator: kind "${kind}" is already registered. Each kind may ` +
        `be registered once per locator — pick a distinct kind string, or ` +
        `create a separate StoreLocator instance.`,
    )
    this.name = 'DuplicateStoreKindError'
    this.kind = kind
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
 * Thrown when a reserved internal vault name (e.g. `__noydb_state__`) is used
 * as a group name or partition key.
 *
 * Internal vault names are prefixed or surrounded with double-underscores to
 * avoid collisions with user-defined vault names. Attempting to use one as a
 * group name or partition key bypasses the naming policy and is rejected
 * eagerly so the mis-configuration is surfaced immediately.
 */
export class ReservedVaultNameError extends NoydbError {
  /** The rejected vault name. */
  readonly vaultName: string

  constructor(vaultName: string) {
    super(
      'RESERVED_VAULT_NAME',
      `"${vaultName}" is a reserved internal vault name and cannot be used as a group name or partition key`,
    )
    this.name = 'ReservedVaultNameError'
    this.vaultName = vaultName
  }
}

/**
 * Thrown by `Collection.put` / `.delete` when the target record's
 * envelope `_ts` falls within a closed accounting period.
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

/**
 * Thrown when a `put()` or `delete()` is rejected by a guard's `check`
 * function. The `reason` is the message the guard supplied — typically a
 * short business description (e.g. "invoice is issued"). The full
 * collection + id are surfaced so audit UIs can link back to the record.
 */
export class RecordLockedError extends NoydbError {
  readonly collection: string
  readonly id: string
  readonly reason: string

  constructor(collection: string, id: string, reason: string) {
    super(
      'RECORD_LOCKED',
      `Cannot modify ${collection}/${id} — locked by guard: ${reason}. ` +
        `Use withTransactions({ amendment: true, reason }) with admin/owner role to override.`,
    )
    this.name = 'RecordLockedError'
    this.collection = collection
    this.id = id
    this.reason = reason
  }
}

/**
 * Thrown when a `put()` changes one or more fields that are frozen by a
 * `frozenFields` guard. The `fields` list contains the specific paths
 * that were detected as changed.
 */
export class FieldFrozenError extends NoydbError {
  readonly collection: string
  readonly id: string
  readonly fields: readonly string[]

  constructor(collection: string, id: string, fields: readonly string[]) {
    super(
      'FIELD_FROZEN',
      `Cannot change frozen field(s) on ${collection}/${id}: ${fields.join(', ')}. ` +
        `Use withTransactions({ amendment: true, reason }) with admin/owner role to override.`,
    )
    this.name = 'FieldFrozenError'
    this.collection = collection
    this.id = id
    this.fields = fields
  }
}

/**
 * Thrown by a `transitionGuard` when a write moves a state field along an
 * arc that the declared transition graph does not allow — either an
 * update `from → to` that is not a listed edge, or an insert whose
 * initial state is not in the allowed `initial` set (reported with
 * `from: '(none)'`). Override via an amendment transaction by an
 * authorized role, like any guard.
 */
export class IllegalTransitionError extends NoydbError {
  readonly collection: string
  readonly id: string
  readonly from: string
  readonly to: string

  constructor(collection: string, id: string, from: string, to: string) {
    super(
      'ILLEGAL_TRANSITION',
      `Cannot transition ${collection}/${id} from "${from}" to "${to}" — not a declared arc. ` +
        `Use withTransactions({ amendment: true, reason }) with admin/owner role to override.`,
    )
    this.name = 'IllegalTransitionError'
    this.collection = collection
    this.id = id
    this.from = from
    this.to = to
  }
}

/**
 * Thrown by an amendment invariant when the proposed change-set violates
 * the declared business rule (e.g. disbursement total not preserved).
 * Triggers a full transaction rollback via the existing revert pass.
 */
export class InvariantError extends NoydbError {
  constructor(message: string) {
    super('INVARIANT_VIOLATED', message)
    this.name = 'InvariantError'
  }
}

/**
 * Thrown at `withTransactions({ amendment: true })` open if the caller's
 * role is not in the guard's allowed amendment roles. Fail-fast: thrown
 * before any writes are attempted.
 */
export class AmendmentForbiddenError extends NoydbError {
  readonly userId: string
  readonly role: string

  constructor(userId: string, role: string) {
    super(
      'AMENDMENT_FORBIDDEN',
      `User "${userId}" with role "${role}" cannot open an amendment transaction. ` +
        `Amendments require admin or owner role.`,
    )
    this.name = 'AmendmentForbiddenError'
    this.userId = userId
    this.role = role
  }
}

/**
 * Thrown by `listUsersWithEnvelopes` when the vault's user directory
 * has been disabled (via `db.setDirectoryEnabled(vault, false)`) and
 * the caller's role is neither `owner` nor `admin`. Owner/admin can
 * still enumerate users — the toggle is a UX privacy switch, not a
 * security boundary.
 *
 * Honest caveat: this is a UX flag, not a privacy guarantee. The
 * envelope ciphertext is still in the store, the keyring file is
 * still listed at `_keyring/*`, and anyone with direct store read
 * access can count keyrings without going through the hub. See
 * `https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/services/user-envelope.md` → "Directory visibility".
 */
export class DirectoryDisabledError extends NoydbError {
  readonly vault: string

  constructor(vault: string) {
    super(
      'DIRECTORY_DISABLED',
      `Vault "${vault}" has its user directory disabled. ` +
        `Only owners and admins can call listUsersWithEnvelopes() here. ` +
        `Use db.setDirectoryEnabled(vault, true) to re-enable.`,
    )
    this.name = 'DirectoryDisabledError'
    this.vault = vault
  }
}

// ─── Hierarchical Access Errors ─────────────────────

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
 * Thrown when a tier-0 `put()` or `delete()` targets a record whose LIVE
 * envelope is elevated (`_tier > 0`) — regardless of whether the caller
 * holds the tier's DEK. `put()`/`delete()` are the tier-0 write APIs;
 * the sanctioned way to write an elevated record is `putAtTier()`,
 * `elevate()`, or `demote()`.
 *
 * Distinct from `TierNotGrantedError`, which means "no DEK for tier N"
 * and refuses only non-holders. This error refuses HOLDERS too — the
 * problem isn't clearance, it's that `put()`/`delete()` are the wrong
 * API for an already-elevated record (a tier-0 `put()` over one would
 * otherwise silently demote it; a tier-0 `delete()` would write a
 * marker with no `_tier`, erasing the elevation signal). It is also
 * distinct from the read-path invisibility gate (`liveRecordIsElevated`
 * in `tier-visibility.ts`), which throws nothing — elevated records
 * simply read as absent there. This is a write-path refusal, not a
 * read-path ghost.
 *
 * #708: also raised by the coordinated-cutover pre-check
 * (`assertCutoverTierSafe`) — a bulk-rewrite is a third tier-0 write path,
 * so it gets the same refusal with a `detail` override naming the record.
 */
export class TierWriteRefusedError extends NoydbError {
  readonly tier: number
  readonly collection: string

  constructor(collection: string, tier: number, detail?: string) {
    super(
      'TIER_WRITE_REFUSED',
      detail ?? `put()/delete() cannot write to record in collection "${collection}" — ` +
        `it is elevated to tier ${tier}. Use putAtTier()/elevate()/demote() instead.`,
    )
    this.name = 'TierWriteRefusedError'
    this.collection = collection
    this.tier = tier
  }
}

/**
 * Thrown at `vault.collection()` registration when `tiers` is declared
 * together with a derived-artifact feature whose crypto has not yet been
 * made tier-aware (elevate()/demote() do not re-key it), so an elevated
 * record's data would stay readable at tier 0. Mirrors
 * `UnsupportedIndexOptionError` — the refusal happens loudly at
 * registration instead of leaking silently at rest.
 *
 * `feature` names the incompatible feature (e.g. `'blobs'`) so catch
 * blocks can pattern-match without inspecting the error message.
 */
export class UnsupportedTierCompositionError extends NoydbError {
  readonly feature: string
  constructor(feature: string, message: string) {
    super('UNSUPPORTED_TIER_COMPOSITION', message)
    this.name = 'UnsupportedTierCompositionError'
    this.feature = feature
  }
}

/**
 * Thrown by `createIntent` (blob durability journal, #753 spec §7 C8) when a
 * `_blob_intent` marker already exists for `{collection}::{recordId}` — the
 * CAS create-if-absent (`expectedVersion: 0`) lost to a present row. A
 * present marker means a shred or rehome is already in flight for this
 * record and MUST be resumed before any new intent is minted (overwriting it
 * would orphan the prior op's op-stamps — spec C8). Callers catch this and
 * resume the pending marker first, then retry.
 */
export class BlobIntentPendingError extends NoydbError {
  readonly collection: string
  readonly recordId: string
  constructor(collection: string, recordId: string) {
    super(
      'BLOB_INTENT_PENDING',
      `A blob durability marker is already pending for "${collection}::${recordId}" — ` +
        `resume it before starting a new shred/rehome.`,
    )
    this.name = 'BlobIntentPendingError'
    this.collection = collection
    this.recordId = recordId
  }
}

/**
 * Thrown by a blob content read when the bytes are not available locally and
 * cannot be fetched right now (#808 offline read taxonomy) — an `external`
 * slot with no local cached copy while the object store is unreachable, or an
 * internal (chunked) blob whose chunk envelopes are absent from the local
 * store (not yet synced to this device, or evicted). The content still exists
 * at its authoritative home — retry when online/synced, or `pin()` the slot
 * while online to keep it readable offline. Deliberately typed (never a hang,
 * never a silent `null`) so UIs can render "available when online".
 *
 * `slotName` is `undefined` when the failing read was not slot-addressed
 * (e.g. a published-version fetch resolving chunks by eTag).
 */
export class BlobOfflineError extends NoydbError {
  readonly collection: string
  readonly recordId: string
  readonly slotName?: string
  constructor(collection: string, recordId: string, slotName: string | undefined, detail: string, cause?: unknown) {
    super(
      'BLOB_OFFLINE',
      `Blob content for ${slotName !== undefined ? `slot "${slotName}" on ` : ''}record "${recordId}" ` +
        `(collection "${collection}") is not available locally: ${detail}`,
    )
    this.name = 'BlobOfflineError'
    this.collection = collection
    this.recordId = recordId
    if (slotName !== undefined) this.slotName = slotName
    if (cause !== undefined) this.cause = cause
  }
}

/**
 * Thrown when an elevated-handle operation runs after the elevation's
 * TTL expired. Reads continue at the original tier; only writes
 * through the scoped handle flip to throwing once expired.
 */
export class ElevationExpiredError extends NoydbError {
  readonly tier: number
  readonly expiresAt: number

  constructor(opts: { tier: number; expiresAt: number }) {
    super(
      'ELEVATION_EXPIRED',
      `Elevation to tier ${opts.tier} expired at ${new Date(opts.expiresAt).toISOString()}`,
    )
    this.name = 'ElevationExpiredError'
    this.tier = opts.tier
    this.expiresAt = opts.expiresAt
  }
}

/**
 * Thrown by `vault.elevate(...)` when an elevation is already active
 * on the vault. Adopters must `release()` the existing handle before
 * starting a new elevation.
 */
export class AlreadyElevatedError extends NoydbError {
  readonly activeTier: number

  constructor(activeTier: number) {
    super(
      'ALREADY_ELEVATED',
      `Vault is already elevated to tier ${activeTier}; release the existing handle first`,
    )
    this.name = 'AlreadyElevatedError'
    this.activeTier = activeTier
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
 * #935 — identity-safe ConflictError detection for store-boundary catches.
 *
 * A store may bind a DIFFERENT copy of `@noy-db/hub/to` than the caller
 * (npm failing to dedupe hub within the peer range in production;
 * src-vs-dist inside the workspace), so its ConflictError is a foreign
 * class identity and a bare `instanceof` silently misses it — CAS retry
 * loops rethrow instead of retrying, and the sync engine misfiles the
 * conflict under `errors` with no resolution run. Every site that catches
 * an error a STORE may have thrown must use this predicate; `instanceof`
 * stays correct only for errors that never cross the store seam.
 * The name check is the contract: every copy sets `name = 'ConflictError'`
 * in its constructor, and the structural `version` field rides along.
 */
export function isConflictError(err: unknown): err is ConflictError {
  return err instanceof ConflictError || (err instanceof Error && err.name === 'ConflictError')
}

/**
 * Thrown by the schema-manifest writer (`with-shape/manifest/writer.ts`,
 * #941 AC #1) when a strict-CAS write to the `_manifest/schema` record
 * loses the race — the stored `_v` no longer matches `expectedVersion`.
 *
 * Unlike {@link ConflictError} (which every other reserved-collection
 * writer catches and retries), the manifest writer REFUSES: it does not
 * re-read, re-apply, and retry. Two concurrent direct edits to the
 * manifest must be refused and surfaced to the caller, never silently
 * merged.
 */
export class ManifestConflictError extends NoydbError {
  /** The actual stored `_v` at the time of conflict. */
  readonly foundVersion: number
  /** The `expectedVersion` the caller supplied. */
  readonly expectedVersion: number

  constructor(foundVersion: number, expectedVersion: number, message?: string) {
    super(
      'MANIFEST_CONFLICT',
      message ??
        `Schema manifest write refused: expected _v=${expectedVersion} but found _v=${foundVersion} (concurrent edit — not retried)`,
    )
    this.name = 'ManifestConflictError'
    this.foundVersion = foundVersion
    this.expectedVersion = expectedVersion
  }
}

/**
 * Thrown by `LedgerStore.append()` after exhausting its CAS retry
 * budget under multi-writer contention. Two browser tabs, a
 * web app + an offline mobile peer, or a server worker pool all
 * producing ledger entries against the same vault can race on the
 * "read head, write head+1" cycle; the optimistic-CAS retry loop
 * resolves the race for `casAtomic: true` stores, but pathological
 * contention (or a buggy peer) can still exhaust the budget. When
 * that happens, the chain is intact — the failed writer simply
 * couldn't claim a slot. Caller's choice whether to retry, queue,
 * or surface the failure to the user.
 */
export class LedgerContentionError extends NoydbError {
  readonly attempts: number

  constructor(attempts: number) {
    super(
      'LEDGER_CONTENTION',
      `LedgerStore.append: failed to claim a chain slot after ${attempts} optimistic-CAS retries`,
    )
    this.name = 'LedgerContentionError'
    this.attempts = attempts
  }
}

/**
 * Thrown by `vault.sequence(name).next()` after exhausting its CAS retry
 * budget under contention. The counter is intact; the caller may retry.
 */
export class SequenceContentionError extends NoydbError {
  readonly sequence: string
  readonly attempts: number

  constructor(sequence: string, attempts: number) {
    super(
      'SEQUENCE_CONTENTION',
      `vault.sequence("${sequence}").next(): failed to allocate after ${attempts} optimistic-CAS retries`,
    )
    this.name = 'SequenceContentionError'
    this.sequence = sequence
    this.attempts = attempts
  }
}

/**
 * Thrown by `vault.sequence(name).next()` when the backing store is not
 * CAS-capable (`capabilities.casAtomic !== true`). Gap-free numbering
 * requires single-authority serialization, which an offline / non-CAS
 * store cannot provide — this is a deliberate online-only wall.
 */
export class SequenceOfflineError extends NoydbError {
  constructor() {
    super(
      'SEQUENCE_OFFLINE',
      'vault.sequence().next() requires an online CAS-capable store ' +
        '(capabilities.casAtomic). Gap-free numbering cannot be serialized offline.',
    )
    this.name = 'SequenceOfflineError'
  }
}

/**
 * Thrown by `vault.sequence()` when the atomic-sequence capability was not
 * opted into (the default `NO_SEQUENCE` stub). Sequence is an opt-in,
 * tree-shakeable capability: enable it with `sequenceStrategy: withSequence()`
 * from "@noy-db/hub" in createNoydb(). Deferred-numbering series
 * (`withDeferredNumbering`) are a separate capability and are unaffected.
 */
export class SequenceNotEnabledError extends NoydbError {
  constructor(
    message = 'vault.sequence() requires the sequence capability. Pass ' +
      '`sequenceStrategy: withSequence()` to createNoydb().',
  ) {
    super('SEQUENCE_NOT_ENABLED', message)
    this.name = 'SequenceNotEnabledError'
  }
}

/** Thrown by a deferred-numbering pass when the store clock is unavailable or its uncertainty cannot be resolved. */
export class NumberingUncertaintyError extends NoydbError {
  readonly series: string
  constructor(series: string) {
    super(
      'NUMBERING_UNCERTAINTY',
      `Deferred numbering for series "${series}" cannot run: the store does not expose getStoreTime() ` +
        `(capabilities.serverWriteTime). Use a CAS sequence or a store with serverWriteTime.`,
    )
    this.name = 'NumberingUncertaintyError'
    this.series = series
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
export class PodVersionConflictError extends NoydbError {
  /** The bundle handle of the newer remote version that rejected the push. */
  readonly remoteVersion: string

  constructor(remoteVersion: string, message = 'Bundle version conflict — remote has been updated') {
    super('BUNDLE_VERSION_CONFLICT', message)
    this.name = 'PodVersionConflictError'
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

/** Base for schema-evolution strategy rejections. */
export class SchemaUpdateError extends NoydbError {
  constructor(code: string, message: string) {
    super(code, message)
    this.name = 'SchemaUpdateError'
  }
}

/** A non-additive schema change was rejected by the `additiveOnly()` strategy. */
export class NonAdditiveSchemaChangeError extends SchemaUpdateError {
  constructor(message: string) {
    super('NON_ADDITIVE_SCHEMA_CHANGE', message)
    this.name = 'NonAdditiveSchemaChangeError'
  }
}

/** A schema change was rejected by the `lockSchema()` strategy. */
export class SchemaLockedError extends SchemaUpdateError {
  constructor(message: string) {
    super('SCHEMA_LOCKED', message)
    this.name = 'SchemaLockedError'
  }
}

/** Write attempted while a schema cutover fence is up (draining/migrating, or this collection has a pending cutover). */
export class SchemaFenceError extends SchemaUpdateError {
  constructor(message: string) {
    super('SCHEMA_FENCE', message)
    this.name = 'SchemaFenceError'
  }
}

/** Write attempted by a client whose generation snapshot is behind the live fence — reload required. */
export class MigrationRequiredError extends SchemaUpdateError {
  constructor(message: string) {
    super('MIGRATION_REQUIRED', message)
    this.name = 'MigrationRequiredError'
  }
}

/** A coordinated cutover timed out waiting for active clients to quiesce. */
export class QuiesceTimeoutError extends SchemaUpdateError {
  constructor(message: string) {
    super('QUIESCE_TIMEOUT', message)
    this.name = 'QuiesceTimeoutError'
  }
}

// ─── Query DSL Errors ─────────────────────────────────────────────────

/**
 * Thrown when `.groupBy().aggregate()` produces more than the hard
 * cardinality cap (default 100_000 groups)..
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
 * **Not overridable in.** The 100k cap is a fixed constant so
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
 * Thrown by `Collection.put()` when writing a record would violate a
 * unique-index constraint — the same field value (or composite field
 * tuple) is already held by a *different* record id in the collection.
 *
 * Properties:
 * - `collection` — name of the collection the write was targeting
 * - `recordId` — the id of the record being written (the would-be violator)
 * - `fields` — the constrained field(s), e.g. `['taxId']` or `['workerId','employerEntityId']`
 * - `conflictingId` — the id of the record already holding the value
 *
 * Null-distinct semantics: if any constrained field is `null`/`undefined`,
 * the row is exempt (the constraint does not fire). This matches standard
 * SQL NULL-distinct behavior.
 */
export class UniqueConstraintError extends NoydbError {
  readonly collection: string
  readonly recordId: string
  readonly fields: readonly string[]
  readonly conflictingId: string

  constructor(collection: string, recordId: string, fields: readonly string[], conflictingId: string) {
    super(
      'UNIQUE_CONSTRAINT',
      `Unique constraint on ${collection}.[${fields.join(', ')}] violated: ` +
        `record "${recordId}" duplicates a value already held by "${conflictingId}".`,
    )
    this.name = 'UniqueConstraintError'
    this.collection = collection
    this.recordId = recordId
    this.fields = fields
    this.conflictingId = conflictingId
  }
}

/**
 * Thrown at collection registration when an index option is declared that
 * is incompatible with the collection's operating mode.
 *
 * Currently covers two cases:
 * - `unique: true` on a lazy-mode (`prefetch: false`) collection — lazy mode
 *   does not pre-load all records, so an in-memory uniqueness map cannot be
 *   maintained reliably.
 * - `unique: true` on a CRDT collection (`crdt: 'lww-map' | 'rga' | 'yjs'`) —
 *   CRDT put() short-circuits the unique-constraint check, so enforcement would
 *   silently not fire.
 *
 * Both cases are caught eagerly at `vault.collection()` time so the developer
 * sees the incompatibility immediately rather than shipping silently-ignored
 * constraints.
 *
 * The `option` field names the incompatible option (`'unique'`) so catch blocks
 * can pattern-match without inspecting the error message.
 */
export class UnsupportedIndexOptionError extends NoydbError {
  readonly option: string
  constructor(option: string, message: string) {
    super('UNSUPPORTED_INDEX_OPTION', message)
    this.name = 'UnsupportedIndexOptionError'
    this.option = option
  }
}

/**
 * Thrown (or surfaced via the `index:write-partial` event) when one or more
 * per-indexed-field side-car writes fail after the main record write has
 * already succeeded.
 *
 * Not thrown out of `.put()` / `.delete()` directly — those succeed when the
 * main record succeeds. Instead, `IndexWriteFailureError` instances are collected
 * into the session-scoped reconcile queue and emitted on the Collection
 * emitter as `index:write-partial`.
 *
 * Payload:
 * - `recordId` — the id of the main record whose side-car writes failed
 * - `field` — the indexed field whose side-car write failed
 * - `op` — `'put'` or `'delete'`, indicating which mutation was in flight
 * - `cause` — the underlying error from the store
 */
export class IndexWriteFailureError extends NoydbError {
  readonly recordId: string
  readonly field: string
  readonly op: 'put' | 'delete'
  override readonly cause: unknown

  constructor(args: { recordId: string; field: string; op: 'put' | 'delete'; cause: unknown }) {
    super(
      'INDEX_WRITE_FAILURE',
      `Index side-car ${args.op} failed for field "${args.field}" on record "${args.recordId}"`,
    )
    this.name = 'IndexWriteFailureError'
    this.recordId = args.recordId
    this.field = args.field
    this.op = args.op
    this.cause = args.cause
  }
}

/**
 * Thrown when `PersistedIndexStore`'s compensating `remove()` — the undo of a
 * stale debounced `_ftindex` save that raced a purge (#725) — itself fails.
 * That failure is sticky (`pendingCompensation`) and retried-first by every
 * subsequent store entrypoint (`ensureBuilt`/`rebuildAndPersist`/
 * `removePersisted`) rather than silently dropped, but was previously
 * rethrown as the RAW adapter error indefinitely — indistinguishable from
 * any other adapter failure, so a caller could not catch it deliberately the
 * way `forget()` catches `_purgeSearchIndex` into `indexResidue` (#764).
 *
 * `cause` is the underlying adapter error. Callers that want stuck-
 * compensation resilience instead of an abort (e.g. `elevate()`/`demote()`,
 * #764) catch this type specifically and surface it as residue.
 */
export class PersistedIndexCompensationError extends NoydbError {
  override readonly cause: unknown

  constructor(cause: unknown) {
    super(
      'PERSISTED_INDEX_COMPENSATION_STUCK',
      'Persisted search-index compensation is stuck — a compensating remove() of a stale ' +
        '_ftindex blob failed and is being retried by every subsequent store call.',
    )
    this.name = 'PersistedIndexCompensationError'
    this.cause = cause
  }
}

/**
 * Thrown by `.where()` / `.orderBy()` / `.aggregate()` (via the Via
 * pipeline's `postureFor`/`wrapReducers`) when the field is covered by a Via
 * feature whose declared posture is `queryable: 'none'` — e.g. a `blobFields`
 * slot (blob content is out-of-band; it never reaches the decrypted record,
 * so nothing indexes or compares it). #629 Task 8 — the first posture
 * consumer.
 *
 * Payload:
 * - `field` — the refused field name
 */
export class FieldNotQueryableError extends NoydbError {
  readonly field: string

  constructor(field: string) {
    super(
      'FIELD_NOT_QUERYABLE',
      `Field "${field}" is not queryable — its Via feature declares queryable: 'none'.`,
    )
    this.name = 'FieldNotQueryableError'
    this.field = field
  }
}

// ─── Bundle Format Errors ─────────────────────────────────

/**
 * Thrown by `readPod()` when the body bytes don't match
 * the integrity hash declared in the bundle header — i.e. someone
 * modified the bytes between write and read.
 *
 * Distinct from a generic `Error` (which would be thrown for
 * format violations like a missing magic prefix or malformed
 * header JSON) so consumers can pattern-match the corruption case
 * and handle it differently from a producer bug. A
 * `PodIntegrityError` indicates "the bytes you got are not
 * what was written"; a plain `Error` from `parsePrefixAndHeader`
 * indicates "what was written wasn't a valid bundle in the first
 * place."
 *
 * Also thrown when decompression fails after the integrity hash
 * passed — that's a producer bug (the wrong algorithm byte was
 * written) but it surfaces with the same error class because the
 * end result is "the body cannot be turned back into a dump."
 */
export class PodIntegrityError extends NoydbError {
  constructor(message: string) {
    super('BUNDLE_INTEGRITY', `.noydb bundle integrity check failed: ${message}`)
    this.name = 'PodIntegrityError'
  }
}

/**
 * Thrown by `open()` (`with-pod/open.ts`, #941) when the caller supplied
 * `trustedKeys` and `verifyPodHeader` reports `'untrusted'` or `'tampered'`.
 * Both are treated the same, fail-closed — same posture as
 * `RedirectBadSignatureError`: once a caller opts into signature
 * verification, an unverifiable header is a hard stop, not a soft signal.
 * `'unsigned'` is deliberately NOT included — a legacy/unsigned pod is
 * benign and open() proceeds, surfacing the status via `OpenPodResult.verification`.
 */
export class PodHeaderVerificationError extends NoydbError {
  constructor(status: 'untrusted' | 'tampered', keyId?: string) {
    super(
      'POD_HEADER_VERIFICATION_FAILED',
      `open(): pod header verification failed (status: '${status}'` +
        `${keyId !== undefined ? `, keyId: '${keyId}'` : ''}). Refusing to open — ` +
        `the header is signed but ${status === 'tampered' ? 'the signature does not verify' : 'the signing key is not trusted'}.`,
    )
    this.name = 'PodHeaderVerificationError'
  }
}

/**
 * Thrown by `readPod` when the bundle carries
 * sealed per-user secrets but no supplied `NoydbSealer`
 * has a `.id` (= `pid`) matching the sealed entry's `pid`.
 *
 * Carries the failing pid + the user id so the recipient can
 * surface an actionable prompt:
 *
 * ```
 * PodSealMismatchError: bundle carries sealed secret for user "alice"
 *   under provider "macos-keychain:com.acme.app/alice@acme.example",
 *   but no registered provider matches that pid.
 * ```
 *
 * Three resolution paths the message names (per foundation §11.9.4):
 *
 * 1. Configure a provider matching the pid and retry import.
 * 2. Pass `attemptUnsealAcrossProviders: true` to try each
 *    registered provider regardless of pid.
 * 3. Inspect without unsealing — pass no `sealingProviders` to
 *    receive the sealed entries unmodified for offline analysis.
 */
export class PodSealMismatchError extends NoydbError {
  readonly userId: string
  readonly pid: string
  constructor(userId: string, pid: string) {
    super(
      'BUNDLE_SEAL_MISMATCH',
      `bundle carries sealed secret for user "${userId}" under provider `
      + `"${pid}", but no registered provider matches that pid.\n\n`
      + 'Resolutions:\n'
      + '  1. Configure a provider matching the pid and retry import.\n'
      + '  2. Pass `attemptUnsealAcrossProviders: true` to try each registered\n'
      + '     provider regardless of pid (extra credential prompts may surface).\n'
      + '  3. Inspect the bundle without unsealing — pass no `sealingProviders`\n'
      + '     to receive the sealed entries unmodified for offline analysis.',
    )
    this.name = 'PodSealMismatchError'
    this.userId = userId
    this.pid = pid
  }
}

// ─── Redirect Errors (#944) ────────────────────────────

/**
 * Thrown by `followRedirects` when the number of hops followed exceeds
 * `maxDepth` (default 8) without reaching a terminal (non-redirect) pod.
 */
export class RedirectDepthExceededError extends NoydbError {
  constructor(maxDepth: number) {
    super(
      'REDIRECT_DEPTH_EXCEEDED',
      `followRedirects exceeded maxDepth=${maxDepth} without reaching a terminal pod.`,
    )
    this.name = 'RedirectDepthExceededError'
  }
}

/**
 * Thrown by `followRedirects` when a redirect chain revisits a target it has
 * already followed — an infinite loop rather than progress toward a terminal
 * pod.
 */
export class RedirectLoopError extends NoydbError {
  constructor(target: string) {
    super('REDIRECT_LOOP', `followRedirects detected a loop: target "${target}" was already followed in this chain.`)
    this.name = 'RedirectLoopError'
  }
}

/**
 * Thrown by `followRedirects` when a hop's Redirect record fails
 * verification — either its `issuedBy` is not in the caller's `trustedKeys`
 * or its signature does not match the record contents. Both cases are
 * treated the same, fail-closed: a Redirect is required to be signed by a
 * trusted key, so an untrusted or forged hop is invalid for following, not
 * merely "unverified".
 */
export class RedirectBadSignatureError extends NoydbError {
  constructor(target: string) {
    super(
      'REDIRECT_BAD_SIGNATURE',
      `followRedirects: the Redirect record pointing to "${target}" failed signature verification (untrusted issuedBy or forged sig).`,
    )
    this.name = 'RedirectBadSignatureError'
  }
}

/**
 * Thrown by `followRedirects` when the caller's `fetcher` cannot produce the
 * pod bytes for a hop's target — it returned `null` or threw. `cause` carries
 * the underlying fetcher error, when there was one.
 */
export class RedirectUnreachableError extends NoydbError {
  constructor(target: string, cause?: unknown) {
    super('REDIRECT_UNREACHABLE', `followRedirects: could not fetch pod bytes for redirect target "${target}".`)
    this.name = 'RedirectUnreachableError'
    if (cause !== undefined) this.cause = cause
  }
}

// ─── i18n / Dictionary Errors ──────────────────────────

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
 * Thrown by `VaultLinks.checkLookupRefsRestrict()` (#654) when a `restrict`-mode lookup-ref
 * edge's compare-key cannot be resolved from the backing row — a matrix dimension with a
 * non-default `key` whose row is missing that field or holds a non-string/non-number value
 * (corruption-class rarity). Whether the referencer still points at this row can't be proven
 * either way, so the delete/forget is refused rather than silently allowed through — the
 * fail-closed twin of `DictKeyInUseError` ("cannot prove no references ⇒ do not delete").
 */
export class RestrictRefUnresolvableError extends NoydbError {
  /** The dimension (backing collection/dictionary) whose row's compare-key was unresolvable. */
  readonly dimension: string
  /** The backing row's key (its PUT-id) that was being deleted/forgotten. */
  readonly key: string
  /** The unresolvable restrict edge, formatted `"collection.field"`. */
  readonly referencing: string

  constructor(dimension: string, key: string, referencing: string) {
    super(
      'RESTRICT_REF_UNRESOLVABLE',
      `Cannot delete "${dimension}" key "${key}": the restrict-mode reference from "${referencing}" ` +
        `could not be resolved (its compare-key is unreadable on the backing row). Refusing to ` +
        `delete — cannot prove no references exist.`,
    )
    this.name = 'RestrictRefUnresolvableError'
    this.dimension = dimension
    this.key = key
    this.referencing = referencing
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

/**
 * Thrown at write time when an `i18nText` slot's value contains
 * characters outside the script set allowed for that locale, and the
 * field's `onScriptViolation` policy is `'reject'` (the default).
 *
 * Distinct from {@link MissingTranslationError} (write-shape) and
 * {@link LocaleNotSpecifiedError} (read-hole) so callers can tell a
 * wrong-script value from a missing one.
 */
export class ScriptViolationError extends NoydbError {
  /** The field whose value violated its script constraint. */
  readonly field: string
  /** The locale slot (e.g. `'en'`) that was checked. */
  readonly locale: string
  /** The Unicode scripts allowed for this slot. */
  readonly expected: readonly string[]
  /** A short sample of the offending characters, for diagnostics. */
  readonly sample: string

  constructor(
    field: string,
    locale: string,
    expected: readonly string[],
    sample: string,
    message?: string,
  ) {
    super(
      'SCRIPT_VIOLATION',
      message ??
        `Field "${field}" slot "${locale}" expects script(s) [${expected.join(', ')}] ` +
        `but contains disallowed character(s): "${sample}".`,
    )
    this.name = 'ScriptViolationError'
    this.field = field
    this.locale = locale
    this.expected = expected
    this.sample = sample
  }
}

/**
 * Thrown when a mutation (`put`/`putAll`/`rename`/`delete`) is attempted
 * against a dictionary name that is backed by a `staticDict()` descriptor.
 *
 * A static dict's labels are code constants with no per-vault storage and no
 * mutation surface — a label change is a code deploy, not a runtime write.
 * Distinct from the other dictionary errors so callers can tell a
 * "this dict is read-only by construction" refusal from a missing-key or
 * key-in-use failure.
 */
export class StaticDictReadonlyError extends NoydbError {
  /** The static dictionary name that was the target of the mutation. */
  readonly dictionaryName: string

  constructor(dictionaryName: string) {
    super(
      'STATIC_DICT_READONLY',
      `Dictionary "${dictionaryName}" is a staticDict — its labels are code ` +
        `constants with no mutation surface. put/putAll/rename/delete are not ` +
        `supported; change the label in the staticDict() table and redeploy.`,
    )
    this.name = 'StaticDictReadonlyError'
    this.dictionaryName = dictionaryName
  }
}

/**
 * Thrown at put-time when a record stores a code for a `staticDict()` field
 * that is not in the descriptor's declared `keys` (a typo or a stale code).
 *
 * Codes are closed by construction, so an unknown code is treated as a bug by
 * default. Opt out per descriptor with `{ validateCodes: false }`.
 *
 * Distinct from {@link LocaleNotSpecifiedError} (a read-hole) — this is a
 * write-shape error.
 */
export class UnknownDictCodeError extends NoydbError {
  /** The static dictionary name. */
  readonly dictionaryName: string
  /** The field that carried the unknown code. */
  readonly field: string
  /** The offending code value. */
  readonly code: string

  constructor(dictionaryName: string, field: string, code: string) {
    super(
      'UNKNOWN_DICT_CODE',
      `Field "${field}": code "${code}" is not a known key of staticDict ` +
        `"${dictionaryName}". Use a declared code, or pass ` +
        `{ validateCodes: false } on the descriptor to allow open codes.`,
    )
    this.name = 'UnknownDictCodeError'
    this.dictionaryName = dictionaryName
    this.field = field
    this.code = code
  }
}

/**
 * Thrown at put-time when a `vocabulary: 'closed'` lookup field (#650 Task
 * 3 — `lookup()`/`enumOf()`/`dict()`, the via-lookup binding) carries a key
 * that is not a member of its dimension — the enum tier's declared key set,
 * the dict tier's declared keys / live reserved-collection entries, or the
 * matrix tier's backing collection.
 *
 * Distinct from {@link UnknownDictCodeError} (the `staticDict()` alias's own
 * error, unchanged by this task) — this is the native `lookup`/`dict`/`enum`
 * descriptors' equivalent. `'open'` vocabulary (the default) never throws
 * this; declare `{ vocabulary: 'closed' }` to opt in.
 */
export class UnknownLookupKeyError extends NoydbError {
  /** The dimension (dictionary/target collection) name. */
  readonly dimension: string
  /** The field that carried the unknown key. */
  readonly field: string
  /** The offending key value. */
  readonly key: string

  constructor(dimension: string, field: string, key: string) {
    super(
      'UNKNOWN_LOOKUP_KEY',
      `Field "${field}": key "${key}" is not a known member of the "${dimension}" ` +
        `lookup vocabulary (closed). Use a declared/existing key, or declare ` +
        `{ vocabulary: 'open' } to allow unknown keys.`,
    )
    this.name = 'UnknownLookupKeyError'
    this.dimension = dimension
    this.field = field
    this.key = key
  }
}

// ─── Translator Errors ─────────────────────────────────────

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

// ─── Backup Errors ─────────────────────────────────────────

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

/**
 * Thrown by partition-extraction primitives when the
 * transitive-closure walk fails — e.g. the FK graph is deeper than
 * `maxDepth`, signalling a runaway or unexpectedly cyclic graph.
 */
export class PartitionExtractionError extends NoydbError {
  constructor(message: string) {
    super('PARTITION_EXTRACTION', message)
    this.name = 'PartitionExtractionError'
  }
}

/**
 * Thrown by `adoptPartition` when the transfer seal can't be
 * opened — a wrong/short transfer key (AES-GCM auth-tag failure) or a
 * malformed sealed payload.
 */
export class TransferSealError extends NoydbError {
  constructor(message: string) {
    super('TRANSFER_SEAL', message)
    this.name = 'TransferSealError'
  }
}

/**
 * Thrown when an adoption-lifecycle precondition fails — re-adopting a
 * partition already consumed in this store, or owner-creation on a
 * vault that isn't in the adopted-unowned state.
 */
export class AdoptionStateError extends NoydbError {
  constructor(message: string) {
    super('ADOPTION_STATE', message)
    this.name = 'AdoptionStateError'
  }
}

// ─── Attestation Errors ────────────────────────────────────

/** Document-attestation failures: undeclared field-schema, non-owner issue, missing field, signer failure. */
export class AttestationError extends NoydbError {
  constructor(message: string) {
    super('ATTESTATION', message)
    this.name = 'AttestationError'
  }
}

/**
 * Thrown when an attestation capability method (`issueAttestation`,
 * `getDocumentSigningPublicKey`, `revokeAttestation`, `unrevokeAttestation`,
 * `getRevokedDocIds`, `publishRevocationList`) is called without opting into
 * the attestation capability (the default `NO_ATTESTATION` stub). Attestation
 * is an opt-in, tree-shakeable capability: enable it with
 * `attestationStrategy: withAttestation()` from "@noy-db/hub/attestation" in
 * createNoydb().
 */
export class AttestationNotEnabledError extends NoydbError {
  constructor(
    message = 'Attestation requires the attestation capability. Pass ' +
      '`attestationStrategy: withAttestation()` from "@noy-db/hub/attestation" ' +
      'to createNoydb().',
  ) {
    super('ATTESTATION_NOT_ENABLED', message)
    this.name = 'AttestationNotEnabledError'
  }
}

/**
 * Thrown when `collection.reveal()` is called without opting into the
 * classified capability (the default `NO_CLASSIFIED` stub). Classified reveal
 * is an opt-in, tree-shakeable capability: enable it with
 * `classifiedStrategy: withClassified()` from "@noy-db/hub/classified" in
 * createNoydb().
 */
export class ClassifiedNotEnabledError extends NoydbError {
  constructor(
    message = 'reveal() requires the classified capability. Pass ' +
      '`classifiedStrategy: withClassified()` from "@noy-db/hub/classified" ' +
      'to createNoydb().',
  ) {
    super('CLASSIFIED_NOT_ENABLED', message)
    this.name = 'ClassifiedNotEnabledError'
  }
}

/**
 * Thrown when a hierarchical-tiers capability method (`putAtTier`, `getAtTier`,
 * `listAtTier`, `elevate`, `demote`) is called without opting into the tiers
 * capability (the default `NO_TIERS` stub). Tiers is an opt-in, tree-shakeable
 * capability: enable it with `tiersStrategy: withTiers()` from
 * "@noy-db/hub/tiers" in createNoydb().
 */
export class TiersNotEnabledError extends NoydbError {
  constructor(
    message = 'Hierarchical tiers require the tiers capability. Pass ' +
      '`tiersStrategy: withTiers()` from "@noy-db/hub/tiers" to createNoydb().',
  ) {
    super('TIERS_NOT_ENABLED', message)
    this.name = 'TiersNotEnabledError'
  }
}

/**
 * Thrown when a sealed-record grantor method (`sealRecordToHost`,
 * `revokeSealedRecord`, `rotateRecordCek`) is called without opting into the
 * sealed-record capability (the default `NO_SEALED_RECORD` stub). Sealed-record
 * is an opt-in, tree-shakeable capability: enable it with
 * `sealedRecordStrategy: withSealedRecord()` from "@noy-db/hub/sealed-record" in
 * createNoydb(). (The host-side `openSealedRecord` opener is ungated.)
 */
export class SealedRecordNotEnabledError extends NoydbError {
  constructor(
    message = 'Record-scoped CEK sealing requires the sealed-record capability. Pass ' +
      '`sealedRecordStrategy: withSealedRecord()` from "@noy-db/hub/sealed-record" ' +
      'to createNoydb().',
  ) {
    super('SEALED_RECORD_NOT_ENABLED', message)
    this.name = 'SealedRecordNotEnabledError'
  }
}

/**
 * Thrown when a portability capability method (`exportMyAccessibleData`,
 * `unilateralWithdrawal`, `requestWithdrawal`, `listWithdrawalRequests`,
 * `approveWithdrawal`, `rejectWithdrawal`) is called without opting into the
 * portability capability (the default `NO_PORTABILITY` stub). Portability is an
 * opt-in, tree-shakeable capability: enable it with
 * `portabilityStrategy: withPortability()` from "@noy-db/hub/portability" in
 * createNoydb().
 */
export class PortabilityNotEnabledError extends NoydbError {
  constructor(
    message = 'Data portability (export/withdrawal) requires the portability capability. Pass ' +
      '`portabilityStrategy: withPortability()` from "@noy-db/hub/portability" to createNoydb().',
  ) {
    super('PORTABILITY_NOT_ENABLED', message)
    this.name = 'PortabilityNotEnabledError'
  }
}

/**
 * Thrown when a sovereign-custody (FR-6) operation — `db.grantCustodian`,
 * `db.revokeCustodian`, or `vault.custody.liberate()` (and the `vault.custody.*`
 * facade that composes them) — is called without opting into the custody
 * capability (the default `NO_CUSTODY` stub). Custody is an opt-in,
 * tree-shakeable capability: enable it with `custodyStrategy: withCustody()`
 * from "@noy-db/hub" in createNoydb(). (The lower-level `liberateVault` free
 * function stays ungated.)
 */
export class CustodyNotEnabledError extends NoydbError {
  constructor(
    message = 'Sovereign custody (grant/revoke custodian, liberate) requires the custody ' +
      'capability. Pass `custodyStrategy: withCustody()` to createNoydb().',
  ) {
    super('CUSTODY_NOT_ENABLED', message)
    this.name = 'CustodyNotEnabledError'
  }
}

/**
 * Thrown when a multi-user team operation — `db.grant`, `db.revoke`, or
 * `db.rotate` — is called without opting into the team capability (the
 * default `NO_TEAM` stub). The always-on floor is single-user by design
 * (#267 keyring-grant → team split): enable multi-user grant/revoke/rotate
 * with `teamStrategy: withTeam()` from "@noy-db/hub/team" in createNoydb().
 * Single-user primitives (owner keyring, unlock, `listUsers`, `updateUser`,
 * secret rotate/recover) stay ungated.
 */
export class TeamNotEnabledError extends NoydbError {
  constructor(
    message = 'Multi-user grant/revoke/rotate requires the team capability. ' +
      'Pass `teamStrategy: withTeam()` (from "@noy-db/hub/team") to createNoydb().',
  ) {
    super('TEAM_NOT_ENABLED', message)
    this.name = 'TeamNotEnabledError'
  }
}

/**
 * Thrown when a search / retrieval capability method — `collection.search`,
 * `collection.retrieve`, `collection.similarTo`, `collection.warmIndex`,
 * `collection.flushIndex`, or the put()-time embedding-vector compute for a
 * collection declaring `embeddings` — is called without opting into the search
 * capability (the default `NO_SEARCH` stub). Search is an opt-in,
 * tree-shakeable capability: enable it with `searchStrategy: withSearch()` from
 * "@noy-db/hub" in createNoydb(). Opting in also enables embedding compute (a
 * vector no gated retrieval could read would be dead weight).
 */
export class SearchNotEnabledError extends NoydbError {
  constructor(
    message = 'Search / retrieval (search, retrieve, similarTo, warmIndex, flushIndex, and ' +
      'embedding compute) requires the search capability. Pass ' +
      '`searchStrategy: withSearch()` to createNoydb().',
  ) {
    super('SEARCH_NOT_ENABLED', message)
    this.name = 'SearchNotEnabledError'
  }
}

/**
 * Thrown when the source-side cargo operation — `extractPartition(vault, …)` —
 * is called without opting into the cargo capability (the default `NO_CARGO`
 * stub). Cargo is an opt-in, tree-shakeable capability: enable it with
 * `cargoStrategy: withCargo()` from "@noy-db/hub/cargo" in createNoydb(). The
 * recipient-side `adoptPartition` / `decryptExtractedPartition` free functions —
 * and `diffVault` (shared import/merge infra) — operate without a gated source
 * instance and stay ungated.
 */
export class CargoNotEnabledError extends NoydbError {
  constructor(
    message = 'Partition extraction (extractPartition) requires the ' +
      'cargo capability. Pass `cargoStrategy: withCargo()` from "@noy-db/hub/cargo" to createNoydb().',
  ) {
    super('CARGO_NOT_ENABLED', message)
    this.name = 'CargoNotEnabledError'
  }
}

// ─── Broker Errors (#479 credential broker) ───────────────

/**
 * Thrown when `vault.broker()` is called without opting into the broker
 * capability (the default `NO_BROKER` stub). Opt in with
 * `brokerStrategy: withBroker(config)` from "@noy-db/hub/broker" in
 * createNoydb().
 */
export class BrokerNotEnabledError extends NoydbError {
  constructor(
    message = 'Credential-broker operations require the broker capability. ' +
      'Pass `brokerStrategy: withBroker(config)` (from "@noy-db/hub/broker") to createNoydb().',
  ) {
    super('BROKER_NOT_ENABLED', message)
    this.name = 'BrokerNotEnabledError'
  }
}

/**
 * Thrown when the `_broker` seed cannot be enrolled with the broker host:
 * `enroll()`/`rotate()` called on a DEK-only keyring (KEK required to
 * provision the `_broker` DEK on first use — R-B8/I3), a `/enroll` POST
 * refused for lacking a valid dev-backend attestation (R-B3), or
 * `credentialSource()` called on a seed whose `/enroll` never completed
 * successfully (`registered !== true` — a partial enrol, I9).
 */
export class BrokerEnrolmentError extends NoydbError {
  constructor(message = 'Credential-broker enrolment failed') {
    super('BROKER_ENROLMENT_ERROR', message)
    this.name = 'BrokerEnrolmentError'
  }
}

/**
 * Thrown when the broker host rejects a submitted challenge proof (MAC
 * mismatch, expired `expiresAt`, or a reused/burned challenge — R-B5).
 */
export class BrokerProofError extends NoydbError {
  constructor(message = 'Broker rejected the challenge proof') {
    super('BROKER_PROOF_ERROR', message)
    this.name = 'BrokerProofError'
  }
}

// ─── Session Errors ───────────────────────────────────────

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
 * a targeted prompt ("Please re-enter your secret to export data").
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

// ─── Query / Join Errors ────────────────────────────────────

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
 * The row ceiling exists because joins are bounded in-memory
 * operations over materialized record sets. Consumers whose
 * collections genuinely exceed the ceiling should track 
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
 * Thrown by `.crossJoin()` when the cumulative cartesian product (or lateral
 * filtered count) exceeds the configured ceiling. Check before allocating.
 * Mirrors the pattern of `JoinTooLargeError` and the `.join()` row ceiling.
 *
 * @see CrossJoinClause.maxRows — per-clause override
 * @see DEFAULT_CROSS_JOIN_MAX_ROWS — package default (50_000)
 */
export class CrossJoinTooLargeError extends NoydbError {
  readonly target: string
  readonly expected: number
  readonly limit: number

  constructor(opts: { target: string; expected: number; limit: number }) {
    super(
      'CROSS_JOIN_TOO_LARGE',
      `crossJoin("${opts.target}"): would produce ${opts.expected} rows, ` +
        `exceeding the limit of ${opts.limit}. ` +
        `Narrow the left side with .where() first, or raise the ceiling ` +
        `with crossJoin("${opts.target}", { ..., maxRows: ${opts.expected} }).`,
    )
    this.name = 'CrossJoinTooLargeError'
    this.target = opts.target
    this.expected = opts.expected
    this.limit = opts.limit
  }
}

/**
 * Thrown by `.join()` when the field it is asked to follow carries no `ref()`
 * declaration on the left collection (and is not a `dictKey` join field).
 *
 * A distinct class rather than a bare `Error` because the condition is
 * legitimately TRANSIENT for one caller: a materialized view's `query()`
 * callback is invoked during `openVault()`, before user code has had any
 * opportunity to declare a collection's refs, so the MV registry defers that
 * strategy's planning and retries instead of failing the vault open (#1139).
 * Matching that condition on the message text would be the kind of proxy this
 * codebase keeps getting bitten by; the class is the fact.
 *
 * For every other caller the meaning is unchanged and terminal: declare the
 * ref, then retry. The message is identical to the one this replaced.
 */
export class RefNotDeclaredError extends NoydbError {
  /** Collection the join was issued from. */
  readonly collection: string
  /** Field the join tried to follow. */
  readonly field: string

  constructor(opts: { collection: string; field: string; message: string }) {
    super('REF_NOT_DECLARED', opts.message)
    this.name = 'RefNotDeclaredError'
    this.collection = opts.collection
    this.field = opts.field
  }
}

/**
 * Thrown at cross-join execution time when the target collection is not
 * reachable from the current vault. The left collection is included in the
 * message for context.
 */
export class CrossJoinSourceUnknownError extends NoydbError {
  readonly target: string
  readonly leftCollection: string

  constructor(target: string, leftCollection: string) {
    super(
      'CROSS_JOIN_SOURCE_UNKNOWN',
      `crossJoin("${target}"): collection "${target}" is not known in the vault ` +
        `(cross-joining from "${leftCollection}"). ` +
        `Make sure "${target}" is open in the same vault before executing this query.`,
    )
    this.name = 'CrossJoinSourceUnknownError'
    this.target = target
    this.leftCollection = leftCollection
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

/**
 * Thrown by {@link sanitizeFilename} when an input filename cannot be
 * made safe — NUL byte, empty after normalization, missing
 * `opaqueId` for the opaque profile, `..` segment, or a `maxBytes`
 * cap too small to hold a single code point.
 */
export class FilenameSanitizationError extends NoydbError {
  constructor(message: string) {
    super('FILENAME_SANITIZATION', message)
    this.name = 'FilenameSanitizationError'
  }
}

/**
 * Thrown when a write target resolves OUTSIDE the requested
 * directory after sanitization — the canonical Zip-Slip class. The
 * sanitizer's job is to strip path-traversal segments; this error
 * is the defense-in-depth fallback at the FS write site.
 */
export class PathEscapeError extends NoydbError {
  readonly attempted: string
  readonly targetDir: string

  constructor(opts: { attempted: string; targetDir: string }) {
    super(
      'PATH_ESCAPE',
      `Sanitized filename "${opts.attempted}" resolves outside target dir "${opts.targetDir}"`,
    )
    this.name = 'PathEscapeError'
    this.attempted = opts.attempted
    this.targetDir = opts.targetDir
  }
}

// ─── Derivation Errors ──────────────────────────────

/**
 * Thrown at vault open if the derivation graph contains a cycle.
 * `path` is the offending chain (e.g. `['a', 'b', 'c', 'a']`).
 */
export class DerivationCycleError extends NoydbError {
  readonly path: readonly string[]

  constructor(path: readonly string[]) {
    super(
      'DERIVATION_CYCLE',
      `Derivation graph contains a cycle: ${path.join(' → ')}. ` +
        `Refusing to open vault — break the cycle before retrying.`,
    )
    this.name = 'DerivationCycleError'
    this.path = path
  }
}

/**
 * Thrown when a cascade of source → output → source → … exceeds the
 * configured `maxDepth` (default 5).
 */
export class DerivationDepthError extends NoydbError {
  readonly limit: number
  readonly attempted: number

  constructor(limit: number, attempted: number) {
    super(
      'DERIVATION_DEPTH',
      `Derivation cascade exceeded max depth ${limit} (attempted ${attempted}). ` +
        `Pass lifecycle: { maxDepth: N } to raise the limit if intentional.`,
    )
    this.name = 'DerivationDepthError'
    this.limit = limit
    this.attempted = attempted
  }
}

/**
 * Thrown at registration if a `withDerivation` strategy references an
 * output `collection` that isn't otherwise declared (no schema, no use
 * elsewhere). Surfacing this early catches typos in collection names.
 */
export class DerivationOutputUnknownError extends NoydbError {
  readonly collection: string

  constructor(collection: string) {
    super(
      'DERIVATION_OUTPUT_UNKNOWN',
      `Derivation output collection "${collection}" is not declared on the vault. ` +
        `Register the collection (e.g. via schema) before registering a derivation that writes to it.`,
    )
    this.name = 'DerivationOutputUnknownError'
    this.collection = collection
  }
}

/**
 * Thrown when the user's `derive` function returns a value that doesn't
 * match the declared output spec (e.g. wrong shape, wrong key set).
 */
export class DerivationOutputShapeError extends NoydbError {
  readonly outputKey: string

  constructor(outputKey: string, detail: string) {
    super(
      'DERIVATION_OUTPUT_SHAPE',
      `Derivation output "${outputKey}" has invalid shape: ${detail}.`,
    )
    this.name = 'DerivationOutputShapeError'
    this.outputKey = outputKey
  }
}

/**
 * Thrown by array-shape derivations when the `derive` function
 * returns more rows than the output's `maxFanout` cap. The cap exists
 * to keep dispatch cost bounded — without it a single source-row
 * update could fan out to thousands of derived rows, dominating the
 * write path.
 *
 * Defaults to `maxFanout: 64`. Raise on the output spec for
 * carry-forward expansion cases (e.g. monthly rows across multi-year
 * contracts).
 */
export class DerivationCapExceededError extends NoydbError {
  readonly outputKey: string
  readonly returned: number
  readonly maxFanout: number

  constructor(outputKey: string, returned: number, maxFanout: number) {
    super(
      'DERIVATION_CAP_EXCEEDED',
      `Derivation array output "${outputKey}" returned ${returned} rows, exceeding `
      + `maxFanout=${maxFanout}. Raise \`maxFanout\` on the OutputSpec if this fanout `
      + 'is intended (the cap exists to keep dispatch cost bounded).',
    )
    this.name = 'DerivationCapExceededError'
    this.outputKey = outputKey
    this.returned = returned
    this.maxFanout = maxFanout
  }
}

/**
 * Thrown at vault open if the materialized-view graph contains a
 * cycle. `path` is the offending chain (e.g. `['a-mv', 'b-mv', 'a-mv']`).
 * Detected by the same shared DFS that catches `DerivationCycleError`;
 * surfaces with a distinct error type so consumers can disambiguate.
 */
export class MaterializedViewCycleError extends NoydbError {
  readonly path: readonly string[]

  constructor(path: readonly string[]) {
    super(
      'MATERIALIZED_VIEW_CYCLE',
      `Materialized-view graph contains a cycle: ${path.join(' → ')}. ` +
        `Refusing to open vault — break the cycle before retrying.`,
    )
    this.name = 'MaterializedViewCycleError'
    this.path = path
  }
}

/**
 * Thrown at MV registration if the query references a source
 * collection that isn't declared on the vault. Surfacing this early
 * catches typos in collection names.
 */
export class MaterializedViewSourceUnknownError extends NoydbError {
  readonly mvName: string
  readonly collection: string

  constructor(mvName: string, collection: string) {
    super(
      'MATERIALIZED_VIEW_SOURCE_UNKNOWN',
      `Materialized view "${mvName}" references unknown source collection "${collection}". ` +
        `Declare the collection (e.g. via schema or by writing to it once) before registering the MV.`,
    )
    this.name = 'MaterializedViewSourceUnknownError'
    this.mvName = mvName
    this.collection = collection
  }
}

/**
 * Thrown by the MV executor when a refresh produces more rows than
 * the configured ceiling. Default ceiling is 100k rows; override
 * per-MV via `maxRows`. Mirrors `JoinTooLargeError` /
 * `GroupCardinalityError` from the query DSL — the explosion is
 * detected BEFORE writes hit the store, so the source-write
 * transaction can roll back cleanly via strict-mode.
 */
export class MaterializedViewTooLargeError extends NoydbError {
  readonly mvName: string
  readonly expected: number
  readonly limit: number

  constructor(mvName: string, expected: number, limit: number) {
    super(
      'MATERIALIZED_VIEW_TOO_LARGE',
      `Materialized view "${mvName}" would emit ${expected} rows, exceeding the configured limit of ${limit}. ` +
        `Override via { maxRows: N } on the MV strategy if intentional, or tighten the query's filter/groupBy.`,
    )
    this.name = 'MaterializedViewTooLargeError'
    this.mvName = mvName
    this.expected = expected
    this.limit = limit
  }
}

/**
 * Thrown by `withMaterializedView()` at registration time when the
 * strategy is structurally malformed. Distinct from
 * `MaterializedViewSourceUnknownError` (the source list is well-formed
 * but names a collection the vault doesn't know) and
 * `MaterializedViewCycleError` (the source graph has a cycle): this
 * error fires before either check, at the moment the spec is being
 * normalized.
 *
 * Today the trigger cases are all about the `query` / `unionSources` /
 * `projection` trichotomy:
 *   - more than one of `query` / `unionSources` / `projection` was set
 *     (mutually exclusive),
 *   - none of the three was set,
 *   - `unionSources` has fewer than 2 arms,
 *   - two arms in `unionSources` reference the same `collection`,
 *   - a malformed `projection` leg (dup / empty `as`, neither `field`
 *     nor `collect`, empty leg list) — plus, at first materialization,
 *     a collect leg whose `on` field lacks a `ref()` targeting the
 *     projection source.
 *
 * The error message is prefixed with `[noy-db] withMaterializedView:`
 * so it's grep-friendly in logs and looks consistent with the existing
 * `ValidationError` messages from the same factory.
 */
export class MaterializedViewConfigError extends NoydbError {
  constructor(message: string) {
    super(
      'MATERIALIZED_VIEW_CONFIG',
      `[noy-db] withMaterializedView: ${message}`,
    )
    this.name = 'MaterializedViewConfigError'
  }
}

/**
 * Thrown at vault open when a `withOverlayedView` declaration uses
 * another virtual-overlay name as its `base`. Multi-overlay stacking
 * is a v2 non-goal — the shallow expansion in
 * `QueryDependencyAnalyzer` would truncate at the inner overlay
 * name, leaving downstream MVs silently stale.
 */
export class OverlayBaseIsVirtualError extends NoydbError {
  readonly overlayName: string
  readonly base: string

  constructor(overlayName: string, base: string) {
    super(
      'OVERLAY_BASE_IS_VIRTUAL',
      `withOverlayedView "${overlayName}": base "${base}" is another overlay's virtual name. ` +
        `Multi-overlay stacking is a v3 feature; base must reference a concrete collection (a real source or an MV output).`,
    )
    this.name = 'OverlayBaseIsVirtualError'
    this.overlayName = overlayName
    this.base = base
  }
}

/**
 * Thrown at vault open when a `withOverlayedView`'s `overlay`
 * references an unknown collection or an MV-owned collection. The
 * overlay collection is user-writable; MV-owned collections aren't.
 */
export class OverlayCollectionUnavailableError extends NoydbError {
  readonly overlayName: string
  readonly overlay: string

  constructor(overlayName: string, overlay: string) {
    super(
      'OVERLAY_COLLECTION_UNAVAILABLE',
      `withOverlayedView "${overlayName}": overlay collection "${overlay}" is unavailable. ` +
        `It must be a real vault-known collection that is NOT itself an MV output collection.`,
    )
    this.name = 'OverlayCollectionUnavailableError'
    this.overlayName = overlayName
    this.overlay = overlay
  }
}

/**
 * Thrown at vault open when a `withOverlayedView`'s virtual `name`
 * collides with an MV output or a concrete source collection.
 */
export class OverlayNameCollisionError extends NoydbError {
  readonly overlayName: string

  constructor(overlayName: string) {
    super(
      'OVERLAY_NAME_COLLISION',
      `withOverlayedView "${overlayName}": virtual name collides with an MV output or a concrete source collection. ` +
        `Pick a unique name for the virtual collection.`,
    )
    this.name = 'OverlayNameCollisionError'
    this.overlayName = overlayName
  }
}

/**
 * Thrown by the virtual overlay's `put(id, record)` when the
 * consumer-supplied `id` doesn't match `rowKey(record)`. Catches
 * fat-finger separator typos that would otherwise silently produce
 * orphaned overlay rows. Direct writes to the underlying overlay
 * collection (bypass the virtual layer) skip this validation.
 */
export class OverlayIdMismatchError extends NoydbError {
  readonly actual: string
  readonly expected: string

  constructor(actual: string, expected: string) {
    super(
      'OVERLAY_ID_MISMATCH',
      `Overlay put(id, record): id "${actual}" does not match the base MV's rowKey(record) → "${expected}". ` +
        `Pass the row directly via .put(record) to derive the id, or fix the id to match the base MV's rowKey output.`,
    )
    this.name = 'OverlayIdMismatchError'
    this.actual = actual
    this.expected = expected
  }
}

// ─── Behavior Naming Errors (#947) ─────────────────────────

/**
 * Thrown at registration if a guard or derivation declares a `name` that
 * is already registered by another behavior of the same kind in this
 * vault. `name` is optional on both `GuardSpec` and `DerivationSpec` —
 * unnamed behaviors never trigger this check — but once given, a name is
 * the stable per-vault identifier a behavior manifest references, so it
 * must be unique among behaviors of the same `kind`.
 */
export class DuplicateBehaviorNameError extends NoydbError {
  readonly behaviorName: string
  readonly kind: 'guard' | 'derivation'

  constructor(name: string, kind: 'guard' | 'derivation') {
    super(
      'DUPLICATE_BEHAVIOR_NAME',
      `Duplicate ${kind} name "${name}" — a ${kind} with this name is already registered ` +
        `in this vault. Behavior names must be unique within a vault (per kind).`,
    )
    this.name = 'DuplicateBehaviorNameError'
    this.behaviorName = name
    this.kind = kind
  }
}

// ─── Snapshot Errors ──────────────────────────────────────

/**
 * Thrown when a requested snapshot version does not exist in the
 * snapshot store — either it was never created, was pruned by the
 * retention policy, or was deleted manually.
 *
 * The `version` field carries the key that was looked up so callers
 * can surface an actionable "snapshot X not found" message without
 * parsing the error string.
 */
export class SnapshotNotFoundError extends NoydbError {
  readonly version: string

  constructor(version: string) {
    super(
      'SNAPSHOT_NOT_FOUND',
      `Snapshot not found: "${version}" does not exist in the snapshot store. ` +
      `It may have been pruned by the retention policy or deleted manually.`,
    )
    this.name = 'SnapshotNotFoundError'
    this.version = version
  }
}

// ─── Federation (multi-vault partition) Errors ──────────────────────────

/**
 * Thrown when a write targets a partition key that has no shard and
 * `sharding.autoCreate` is disabled.
 */
export class UnknownShardError extends NoydbError {
  readonly partitionKey: string

  constructor(partitionKey: string, groupName: string) {
    super(
      'SHARD_UNKNOWN',
      `No shard for partition key "${partitionKey}" in vault group "${groupName}" ` +
        `and autoCreate is disabled. Call group.createShard(${JSON.stringify(partitionKey)}) ` +
        `first, or enable sharding.autoCreate.`,
    )
    this.name = 'UnknownShardError'
    this.partitionKey = partitionKey
  }
}

/**
 * Thrown by `createShard` when the registry has a row for a partition
 * but the corresponding vault is not provisioned in the store —
 * a registry/store divergence. Refusing to recreate avoids masking
 * data loss.
 */
export class ShardProvisioningError extends NoydbError {
  readonly vaultId: string

  constructor(vaultId: string, partitionKey: string) {
    super(
      'SHARD_PROVISIONING',
      `Registry has a row for partition "${partitionKey}" (vault "${vaultId}") but that ` +
        `vault is not provisioned in the store. Refusing to recreate it — the registry and ` +
        `store have diverged. Investigate before retrying.`,
    )
    this.name = 'ShardProvisioningError'
    this.vaultId = vaultId
  }
}

/**
 * Thrown by `VaultGroup.createShard` when `sharding.regionOf` resolves a
 * required region that doesn't match the placement backend's
 * `capabilities.region` — the shard would land on a non-compliant backend
 * (a data-residency violation). Raised BEFORE provisioning, so no
 * vault is created.
 */
export class DataResidencyError extends NoydbError {
  readonly vaultId: string
  readonly requiredRegion: string
  readonly backendRegion: string | undefined

  constructor(vaultId: string, requiredRegion: string, backendRegion: string | undefined) {
    super(
      'DATA_RESIDENCY',
      `Shard "${vaultId}" requires region "${requiredRegion}" but its placement backend ` +
        `declares region ${backendRegion === undefined ? '(none)' : `"${backendRegion}"`}. ` +
        `Refusing to provision — route this shard to a region-correct backend via ` +
        `routeStore({ vaultRoutes }) (e.g. a region-encoded partition key) before retrying.`,
    )
    this.name = 'DataResidencyError'
    this.vaultId = vaultId
    this.requiredRegion = requiredRegion
    this.backendRegion = backendRegion
  }
}

/**
 * Thrown by `ShardedQuery.crossShardJoin` / `broadcastJoin` for
 * deterministic, query-shaping errors: an undeclared join ref (which
 * would fail identically on every shard), or calling a deferred
 * reactive/aggregate surface on a query that already carries join legs.
 */
export class CrossShardJoinError extends NoydbError {
  constructor(message: string) {
    super('CROSS_SHARD_JOIN', message)
    this.name = 'CrossShardJoinError'
  }
}

/** Thrown when a VaultGroup references a template name that was never registered. */
export class VaultTemplateNotFoundError extends NoydbError {
  readonly templateName: string

  constructor(templateName: string) {
    super(
      'VAULT_TEMPLATE_NOT_FOUND',
      `No vault template registered under "${templateName}". ` +
        `Register the template before opening the vault group.`,
    )
    this.name = 'VaultTemplateNotFoundError'
    this.templateName = templateName
  }
}

// ─── Erasure Errors ────────────────────────────────────────────────────

/**
 * Thrown when `vault.forget(subjectId)` is called on a vault whose
 * `createNoydb({ forgetStrategy })` declared no subject fields (the
 * default `NO_FORGET`). GDPR crypto-shred needs a declared subject →
 * record index to know which records belong to a data subject; without
 * one there is nothing to erase and a silent no-op would be a dangerous
 * false "erased" signal. Configure with
 * `forgetStrategy: withForget({ subjects: { invoices: 'buyerId' } })`.
 */
export class ForgetStrategyNotConfiguredError extends NoydbError {
  constructor(
    message = 'vault.forget() requires a forget strategy. Pass ' +
      '`forgetStrategy: withForget({ subjects: { <collection>: <subjectField> } })` ' +
      'from "@noy-db/hub/forget" to createNoydb().',
  ) {
    super('FORGET_NOT_CONFIGURED', message)
    this.name = 'ForgetStrategyNotConfiguredError'
  }
}

// ─── Sealed-record (record-scoped CEK sealing) Errors ───────────────────

/**
 * Thrown by `openSealedRecord()` when the sealed CEK's binding has passed its
 * `expiresAt`. Surfaced on two checks: a cheap fast-path check on the delivery
 * envelope's clear-text `expiresAt`, and the AUTHORITATIVE check on the
 * `expiresAt` inside the sealed binding (the latter cannot be forged by editing
 * the delivery envelope). Distinct from {@link KeyringExpiredError} (bundle-slot
 * expiry) so a host can tell "this single-record grant lapsed" from a keyring-
 * level expiry.
 */
export class SealedRecordExpiredError extends NoydbError {
  readonly expiresAt: string
  constructor(expiresAt: string) {
    super(
      'SEALED_RECORD_EXPIRED',
      `Sealed record CEK expired at ${expiresAt}. The grantor must re-seal the ` +
        `record with a later expiresAt.`,
    )
    this.name = 'SealedRecordExpiredError'
    this.expiresAt = expiresAt
  }
}

/**
 * Thrown by `openSealedRecord()` when the sealed binding's
 * `{collection, id}` does not match the record envelope the host is trying to
 * decrypt. This is the host-denial boundary: a CEK sealed for record A cannot
 * be replayed against record B's envelope. (A CEK sealed for a PRE-rotation
 * version of a record, applied to the POST-rotation live envelope, is a
 * different failure — the binding still matches `{collection, id}` so it gets
 * past this check, and the AES-GCM auth-tag failure surfaces as
 * {@link TamperedError} instead.)
 */
export class SealedRecordMismatchError extends NoydbError {
  readonly expected: { collection: string; id: string }
  readonly actual: { collection: string; id: string }
  constructor(
    expected: { collection: string; id: string },
    actual: { collection: string; id: string },
  ) {
    super(
      'SEALED_RECORD_MISMATCH',
      `Sealed CEK binding is for ${actual.collection}/${actual.id} but was ` +
        `presented against ${expected.collection}/${expected.id}. A CEK sealed ` +
        `for one record cannot decrypt another.`,
    )
    this.name = 'SealedRecordMismatchError'
    this.expected = expected
    this.actual = actual
  }
}

/**
 * Thrown by `vault.sealRecordToHost()` / `vault.rotateRecordCek()` when the
 * target record has no live envelope, or its live envelope carries no `_cek`
 * (a legacy / non-`perRecordKeys` collection has nothing record-scoped to
 * seal — its body is keyed off the shared collection DEK, which sealing
 * deliberately never exposes).
 */
export class RecordCekNotFoundError extends NoydbError {
  readonly collection: string
  readonly id: string
  constructor(collection: string, id: string) {
    super(
      'RECORD_CEK_NOT_FOUND',
      `No per-record CEK for ${collection}/${id}. The record is missing, or its ` +
        `collection was not opened with { perRecordKeys: true } — only per-record-key ` +
        `records carry a sealable CEK.`,
    )
    this.name = 'RecordCekNotFoundError'
    this.collection = collection
    this.id = id
  }
}

// ─── Embedding Errors ────────────────────────────────────────────────────

/**
 * Thrown when a stored vector's dimension does not match the dimension declared
 * by the active `EmbeddingDescriptor`. The `field`, `expected`, and `actual`
 * properties are machine-readable for switch blocks and logging.
 */
export class EmbeddingDimMismatchError extends NoydbError {
  readonly field: string
  readonly expected: number
  readonly actual: number

  constructor(field: string, expected: number, actual: number) {
    super(
      'EMBEDDING_DIM_MISMATCH',
      `Embedding for "${field}" has dim ${actual}, expected ${expected}.`,
    )
    this.name = 'EmbeddingDimMismatchError'
    this.field = field
    this.expected = expected
    this.actual = actual
  }
}

/**
 * Thrown when the model tag on a stored vector does not match the `model`
 * declared by the active `EmbeddingDescriptor`. Signals that the encoder was
 * swapped without re-indexing; call `vault.embeddings.reindex()` to rebuild.
 */
export class EmbeddingModelMismatchError extends NoydbError {
  readonly expected: string
  readonly found: string

  constructor(expected: string, found: string) {
    super(
      'EMBEDDING_MODEL_MISMATCH',
      `Embedding model mismatch: collection uses "${expected}" but a stored vector is "${found}". ` +
        `Run vault.embeddings.reindex() after changing the encoder.`,
    )
    this.name = 'EmbeddingModelMismatchError'
    this.expected = expected
    this.found = found
  }
}

// ─── User Envelope Errors ────────────────────────────────────────────────

/**
 * Thrown when a user-envelope payload exceeds {@link USER_ENVELOPE_MAX_BYTES}
 * after JSON-serialization. The error carries the actual size so callers
 * can decide whether to trim or split.
 */
export class UserEnvelopeOversizedError extends NoydbError {
  readonly bytes: number
  readonly limit: number
  constructor(bytes: number, limit: number = USER_ENVELOPE_MAX_BYTES) {
    super(
      'USER_ENVELOPE_OVERSIZED',
      `User envelope payload is ${bytes} bytes; soft cap is ${limit} bytes. ` +
        `Move large data into the vault's regular collections.`,
    )
    this.name = 'UserEnvelopeOversizedError'
    this.bytes = bytes
    this.limit = limit
  }
}

// ─── Policy Gate Errors ──────────────────────────────────────────────────
//
// The engine (`checkGate`/`describeGate`), presets, and storage helpers for
// these errors live at `with-party/policy/`; the error classes themselves
// (like every NOYDB error) live in this always-on spine file.

/**
 * Why a gate denied a request. Stable across hub versions so consumers
 * can switch on the value in error UIs.
 */
export type PolicyDenyReason =
  | 'insufficient-tier'
  | 'missing-factor'
  | 'stale-proof'
  | 'disabled'
  | 'shared-device-blocked'

/**
 * Thrown by {@link checkGate} when the active session does not meet
 * the gate's requirements. Carries the gate name, the reason, and the
 * full required {@link GatePolicy} so error UIs can prompt the user
 * for the missing factor without re-reading the policy document.
 */
export class PolicyDeniedError extends NoydbError {
  readonly gate: GateName
  readonly reason: PolicyDenyReason
  readonly required: GatePolicy
  constructor(gate: GateName, reason: PolicyDenyReason, required: GatePolicy, message?: string) {
    super(
      'POLICY_DENIED',
      message ?? `Gate "${gate}" denied: ${reason}.`,
    )
    this.name = 'PolicyDeniedError'
    this.gate = gate
    this.reason = reason
    this.required = required
  }
}

/**
 * Raised by `createNoydb({ ... })` when the developer omits a recovery
 * profile and `recover-secret` is not explicitly disabled. Vaults
 * MUST have at least one recovery path enrolled before being
 * production-ready (paper, shamir, multi-channel, or admin-mediated).
 *
 * The error message carries a pointer to the recovery design docs.
 */
export class RecoveryNotEnrolledError extends NoydbError {
  constructor(
    message =
      'Recovery profile not enrolled. Pass `recovery: [{ profile: "paper", codes: 10 }]` ' +
      'to `createNoydb()`, or set `policy.gates["recover-secret"].enabled = false` to ' +
      'opt out of recovery (secret loss = data loss). See https://github.com/vLannaAi/noy-db-docs/blob/main/content/docs/services/session-tiers.md.',
  ) {
    super('RECOVERY_NOT_ENROLLED', message)
    this.name = 'RecoveryNotEnrolledError'
  }
}

/**
 * Raised by `openVault` when a managed-secret-mode vault has no
 * STRONG recovery profile enrolled.
 *
 * Managed mode means the user never types a secret — the unlock
 * material lives in a `NoydbSealer` (`at-*` package). If that
 * provider's key is lost AND no strong recovery is enrolled, the
 * vault is irrecoverable. To prevent that footgun, managed-mode vaults
 * require at least one strong recovery profile (Shamir today;
 * multi-channel / admin-mediated when those ship).
 *
 * Paper recovery alone is NOT strong under managed mode: the user has
 * no memorized secret to fall back on, so losing the paper sheet =
 * losing every record permanently.
 *
 * Bootstrap with `db.team.openVaultAndEnrollRecovery(vault, { recovery: [{ profile: "shamir", k, n }] })`
 * to atomically create-and-enroll, or call `db.team.enrollRecovery(vault, { profile: "shamir", ... })`
 * separately before re-attempting `openVault`.
 */
export class ManagedRecoveryNotEnrolledError extends NoydbError {
  readonly vault: string
  constructor(vault: string) {
    super(
      'MANAGED_RECOVERY_NOT_ENROLLED',
      `Managed-mode vault "${vault}" requires at least one strong recovery profile `
      + '(Shamir today; multi-channel / admin-mediated when they ship). Paper alone is '
      + 'NOT strong under managed mode — losing the paper sheet would mean losing every '
      + 'record permanently. '
      + `Bootstrap with \`db.team.openVaultAndEnrollRecovery("${vault}", { recovery: [{ profile: "shamir", k: 2, n: 3 }] })\`, `
      + 'or call `db.team.enrollRecovery(vault, { profile: "shamir", k, n })` separately, '
      + 'then re-attempt `openVault`.',
    )
    this.name = 'ManagedRecoveryNotEnrolledError'
    this.vault = vault
  }
}

/**
 * Raised by `db.recoverSecret` / `db.enrollRecovery` /
 * `db.rotateRecovery` when the developer requests a recovery profile
 * not yet wired in this hub release.
 *
 * Implemented: `paper` and `shamir`.
 * Pending: `multi-channel` and `admin-mediated` (follow-up slices).
 *
 * The carried `profile` and `tracking` fields let consumers steer the
 * UI ("multi-channel recovery is not yet wired up — open issue #N to follow").
 */
export class RecoveryProfileNotImplementedError extends NoydbError {
  readonly profile: string
  readonly tracking: string
  constructor(profile: string, tracking: string) {
    super(
      'RECOVERY_PROFILE_NOT_IMPLEMENTED',
      `Recovery profile "${profile}" is not yet implemented in this hub release. ` +
        `Tracking: ${tracking}. Use the "paper" profile via @noy-db/on-recovery in the meantime.`,
    )
    this.name = 'RecoveryProfileNotImplementedError'
    this.profile = profile
    this.tracking = tracking
  }
}

// ─── Enclave Errors ────────────────────────────────────────────────────

/**
 * Thrown by a `kernel/enclave` fork's **optional groups** — sealing,
 * deterministic, per-record-key lifecycle — when that fork's crypto
 * engine does not implement the requested behavior.
 *
 * The enclave barrel is a frozen fork-swap contract: every symbol must
 * exist, but the optional groups may refuse to work rather than
 * implement the full reference semantics. The unconditional core
 * (crypto ops, `RecordCodec`, tombstone) must never throw this — those
 * groups are load-bearing for every consumer regardless of which
 * enclave is wired in. noy-db's own reference enclave supports every
 * group, so this error is never thrown by `@noy-db/hub` itself; it
 * exists for fork authors to signal "my enclave doesn't do X" with a
 * stable, catchable code instead of an ad hoc throw.
 */
export class EnclaveNotSupportedError extends NoydbError {
  /** The optional group that is not supported by this enclave. */
  readonly group: 'sealing' | 'deterministic' | 'per-record-keys'

  constructor(group: 'sealing' | 'deterministic' | 'per-record-keys', detail?: string) {
    super(
      'ENCLAVE_NOT_SUPPORTED',
      `enclave: ${group} is not supported by this enclave${detail ? ` — ${detail}` : ''}`,
    )
    this.name = 'EnclaveNotSupportedError'
    this.group = group
  }
}

// ─── Classified Errors ─────────────────────────────────────────────────

/**
 * Raised when a collection's `classifiedFields` configuration is invalid
 * (e.g. a claimed field name collides with a rider companion or another
 * classified field). Homed in `kernel/errors.ts` (rather than the classified
 * feature module) so `kernel/enclave/classify/*` can throw it without
 * importing with-*; the classified feature module re-exports it under the
 * same name for backward-compatible import paths.
 */
export class ClassifiedConfigError extends Error {
  constructor(public readonly collection: string, message: string) {
    super(`classifiedFields for collection "${collection}": ${message}`)
    this.name = 'ClassifiedConfigError'
  }
}

/**
 * Raised by `collection.reveal()` when a field cannot be revealed — unknown
 * field, `storage:'never'`, or missing record. See {@link ClassifiedConfigError}
 * for why this lives in `kernel/errors.ts`.
 */
export class ClassifiedRevealError extends Error {
  constructor(public readonly collection: string, public readonly field: string, detail: string) {
    super(`Cannot reveal field "${field}" in collection "${collection}": ${detail}`)
    this.name = 'ClassifiedRevealError'
  }
}

/**
 * Raised by the classified verify path (`storage:'digest-only'`, stage 2)
 * when a field cannot be verified — unknown field, not digest-only, or no
 * digest stored yet.
 */
export class ClassifiedVerifyError extends Error {
  constructor(public readonly collection: string, public readonly field: string, detail: string) {
    super(`Cannot verify field "${field}" in collection "${collection}": ${detail}`)
    this.name = 'ClassifiedVerifyError'
  }
}

/**
 * Raised by the classified rotation path (stage 2) when a new value is
 * refused — e.g. reuse of one of the last N values (`notLastN`).
 */
export class ClassifiedRotationError extends Error {
  constructor(public readonly collection: string, public readonly field: string, detail: string) {
    super(`Rotation refused for field "${field}" in collection "${collection}": ${detail}`)
    this.name = 'ClassifiedRotationError'
  }
}

// ─── Satellite Errors ──────────────────────────────────────────────────

/**
 * A satellite-collection declaration or operation violated the refusal
 * matrix (R-S1…R-S10) of the satellite-collections design. The message
 * always names the R-S id.
 */
export class SatelliteConfigError extends NoydbError {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super('SATELLITE_CONFIG_ERROR', message)
    this.name = 'SatelliteConfigError'
    if (options?.cause !== undefined) this.cause = options.cause
  }
}
