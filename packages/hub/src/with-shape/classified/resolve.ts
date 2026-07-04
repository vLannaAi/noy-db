/** Flatten a classifiedFields config into a per-field map + rider computed entries. @module */

import { isClassifiedGroup, type ClassifiedEntry, type ClassifiedFieldSpec } from './descriptor.js'
import { ClassifiedConfigError } from './errors.js'

export type { ClassifiedEntry, ClassifiedFieldSpec, ClassifiedGroup, ClassifiedList } from './descriptor.js'
export { ClassifiedConfigError } from './errors.js'

export interface ResolvedClassified {
  readonly byField: Record<string, ClassifiedFieldSpec>
  readonly riderComputed: Record<string, (record: Record<string, unknown>) => unknown>
}

export function resolveClassifiedFields(
  collection: string,
  config: Record<string, ClassifiedEntry>,
): ResolvedClassified {
  const byField: Record<string, ClassifiedFieldSpec> = {}
  const claim = (field: string, spec: ClassifiedFieldSpec): void => {
    if (byField[field] !== undefined) {
      throw new ClassifiedConfigError(collection,
        `field "${field}" is claimed twice — storage forms are mutually exclusive per field (R5): ` +
        `a field is digest-only OR recoverable OR never, exactly one`)
    }
    byField[field] = spec
  }
  for (const [key, entry] of Object.entries(config)) {
    if (isClassifiedGroup(entry)) {
      for (const [field, spec] of Object.entries(entry.members)) claim(field, spec)
    } else {
      claim(key, entry)
    }
  }
  const riderComputed: Record<string, (record: Record<string, unknown>) => unknown> = {}
  for (const [field, spec] of Object.entries(byField)) {
    for (const [name, rider] of Object.entries(spec.riders ?? {})) {
      const companion = `${field}_${name}`
      if (byField[companion] !== undefined || riderComputed[companion] !== undefined) {
        throw new ClassifiedConfigError(collection, `rider companion "${companion}" collides with a declared field`)
      }
      riderComputed[companion] = (record) =>
        record[field] === undefined ? undefined : rider(record[field])
    }
  }
  return { byField, riderComputed }
}
