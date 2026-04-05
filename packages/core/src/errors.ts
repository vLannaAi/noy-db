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
