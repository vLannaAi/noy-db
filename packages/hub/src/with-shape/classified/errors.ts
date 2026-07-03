/** Configuration/write errors for classified fields. @module */

export class ClassifiedConfigError extends Error {
  constructor(public readonly collection: string, message: string) {
    super(`classifiedFields for collection "${collection}": ${message}`)
    this.name = 'ClassifiedConfigError'
  }
}

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
