/**
 * Classify the difference between two derived JSON Schemas.
 *
 * v1 ruleset — top-level object properties + required-ness:
 *   - additive  ⇔ only new OPTIONAL properties (no removals, no changed
 *                 properties, no new required field, no required-ness flip)
 *   - non-additive ⇔ any removal, any shape/type change, any required-ness
 *                 flip, or a new REQUIRED property
 * Deeper rules (nested objects, union widening, type narrowing) are
 * deferred (spec §8). Callers only invoke this with two object schemas.
 */
import { canonicalize } from '../persisted-schemas/canonicalize.js'
import type { SchemaDelta, FieldChange } from './types.js'

interface ObjectSchema {
  readonly properties?: Record<string, unknown>
  readonly required?: readonly string[]
}

export function computeSchemaDelta(
  stored: object,
  fresh: object,
  collection: string,
): SchemaDelta {
  const a = stored as ObjectSchema
  const b = fresh as ObjectSchema
  const aProps = a.properties ?? {}
  const bProps = b.properties ?? {}
  const aReq = new Set(a.required ?? [])
  const bReq = new Set(b.required ?? [])

  const aKeys = Object.keys(aProps)
  const bKeys = Object.keys(bProps)

  const added = bKeys.filter(k => !(k in aProps))
  const removed = aKeys.filter(k => !(k in bProps))

  const changed: FieldChange[] = []
  for (const k of bKeys) {
    if (!(k in aProps)) continue
    const shapeChanged = canonicalize(aProps[k]) !== canonicalize(bProps[k])
    const requiredChanged = aReq.has(k) !== bReq.has(k)
    if (shapeChanged || requiredChanged) {
      changed.push({ field: k, requiredChanged, shapeChanged })
    }
  }

  let kind: SchemaDelta['kind']
  if (added.length === 0 && removed.length === 0 && changed.length === 0) {
    kind = 'none'
  } else if (
    removed.length === 0 &&
    changed.length === 0 &&
    added.every(k => !bReq.has(k))
  ) {
    kind = 'additive'
  } else {
    kind = 'non-additive'
  }

  return { collection, kind, added, removed, changed }
}
