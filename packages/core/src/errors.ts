export class NoydbError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'NoydbError'
    this.code = code
  }
}

// ─── Crypto Errors ─────────────────────────────────────────────────────

export class DecryptionError extends NoydbError {
  constructor(message = 'Decryption failed') {
    super('DECRYPTION_FAILED', message)
    this.name = 'DecryptionError'
  }
}

export class TamperedError extends NoydbError {
  constructor(message = 'Data integrity check failed — record may have been tampered with') {
    super('TAMPERED', message)
    this.name = 'TamperedError'
  }
}

export class InvalidKeyError extends NoydbError {
  constructor(message = 'Invalid key — wrong passphrase or corrupted keyring') {
    super('INVALID_KEY', message)
    this.name = 'InvalidKeyError'
  }
}

// ─── Access Errors ─────────────────────────────────────────────────────

export class NoAccessError extends NoydbError {
  constructor(message = 'No access — user does not have a key for this collection') {
    super('NO_ACCESS', message)
    this.name = 'NoAccessError'
  }
}

export class ReadOnlyError extends NoydbError {
  constructor(message = 'Read-only — user has ro permission on this collection') {
    super('READ_ONLY', message)
    this.name = 'ReadOnlyError'
  }
}

export class PermissionDeniedError extends NoydbError {
  constructor(message = 'Permission denied — insufficient role for this operation') {
    super('PERMISSION_DENIED', message)
    this.name = 'PermissionDeniedError'
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
 * adapter capability the active adapter does not implement (v0.5
 * #63).
 *
 * Today the only call site is `Noydb.listAccessibleCompartments()`,
 * which depends on the optional `NoydbAdapter.listCompartments()`
 * method. The error message names the missing method and the calling
 * API so consumers know exactly which combination is unsupported,
 * and the `capability` field is machine-readable so library code can
 * pattern-match in catch blocks (e.g. fall back to a candidate-list
 * shape).
 *
 * The class lives in `errors.ts` rather than as a generic
 * `ValidationError` because the diagnostic shape is different: a
 * `ValidationError` says "the inputs you passed are wrong"; this
 * error says "the inputs are fine, but the adapter you wired up
 * doesn't support what you're asking for." Different fix, different
 * documentation.
 */
export class AdapterCapabilityError extends NoydbError {
  /** The adapter method/capability that was missing. */
  readonly capability: string

  constructor(capability: string, callerApi: string, adapterName?: string) {
    super(
      'ADAPTER_CAPABILITY',
      `${callerApi} requires the optional adapter capability "${capability}" ` +
        `but the active adapter${adapterName ? ` (${adapterName})` : ''} does not implement it. ` +
        `Use an adapter that supports "${capability}" (memory, file) or pass an explicit ` +
        `compartment list to bypass enumeration.`,
    )
    this.name = 'AdapterCapabilityError'
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

// ─── Sync Errors ───────────────────────────────────────────────────────

export class ConflictError extends NoydbError {
  readonly version: number

  constructor(version: number, message = 'Version conflict') {
    super('CONFLICT', message)
    this.name = 'ConflictError'
    this.version = version
  }
}

export class NetworkError extends NoydbError {
  constructor(message = 'Network error') {
    super('NETWORK_ERROR', message)
    this.name = 'NetworkError'
  }
}

// ─── Data Errors ───────────────────────────────────────────────────────

export class NotFoundError extends NoydbError {
  constructor(message = 'Record not found') {
    super('NOT_FOUND', message)
    this.name = 'NotFoundError'
  }
}

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

// ─── Backup Errors (v0.4 #46) ─────────────────────────────────────────

/**
 * Thrown when `Compartment.load()` finds that a backup's hash chain
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
 * Thrown when `Compartment.load()` finds that the backup's data
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
 * means stored data has drifted and `compartment.checkIntegrity()`
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
