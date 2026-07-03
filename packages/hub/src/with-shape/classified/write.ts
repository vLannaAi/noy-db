/** Write-path enforcement: storage:'never' rejection + preset validators.
 *  Runs BEFORE riders/computed and BEFORE schema validation. Pure. @module */

import type { ClassifiedFieldSpec } from './descriptor.js'
import { ClassifiedNeverStoredError, ClassifiedValidationError } from './errors.js'

export function enforceClassifiedWrite(
  record: Record<string, unknown>,
  byField: Record<string, ClassifiedFieldSpec>,
  collection: string,
): void {
  for (const [field, spec] of Object.entries(byField)) {
    const value = record[field]
    if (value === undefined) continue
    if (spec.storage === 'never') throw new ClassifiedNeverStoredError(collection, field)
    const problem = spec.validate?.(value) ?? null
    if (problem !== null) throw new ClassifiedValidationError(collection, field, problem)
  }
}
