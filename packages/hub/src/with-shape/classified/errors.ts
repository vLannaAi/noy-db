/**
 * Configuration/write errors for classified fields. @module
 *
 * `ClassifiedConfigError` / `ClassifiedRevealError` moved to `kernel/errors.ts`
 * (stage 2) so `kernel/enclave/classify/*` can throw them without importing
 * with-*. Re-exported here under the same names so existing import paths
 * keep working.
 */
export { ClassifiedConfigError, ClassifiedRevealError, ClassifiedVerifyError, ClassifiedRotationError } from '../../kernel/errors.js'

export class ClassifiedNeverStoredError extends Error {
  constructor(public readonly collection: string, public readonly field: string) {
    super(`Field "${field}" in collection "${collection}" is classified storage:'never' `
      + `(e.g. a CVC) and must not be persisted. Validate it at capture and drop it before put().`)
    this.name = 'ClassifiedNeverStoredError'
  }
}

export class ClassifiedValidationError extends Error {
  constructor(public readonly collection: string, public readonly field: string, detail: string) {
    super(`Classified field "${field}" in collection "${collection}" failed validation: ${detail}`)
    this.name = 'ClassifiedValidationError'
  }
}
