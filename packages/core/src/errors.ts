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
