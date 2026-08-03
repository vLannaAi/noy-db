/**
 * Classify the difference between two derived JSON Schemas.
 *
 * v1 ruleset — top-level object properties + required-ness:
 *   - additive  ⇔ only new OPTIONAL properties (no removals, no changed
 *                 properties, no new required field, no required-ness flip)
 *   - non-additive ⇔ any removal, any shape/type change, any required-ness
 *                 flip, or a new REQUIRED property
 * Deeper rules (nested objects, union widening, type narrowing) are
 * deferred. Callers only invoke this with two object schemas.
 *
 * #946 — rename detection: a removed name and an added name whose
 * subschemas canonicalize identically, and whose shape is shared by no
 * OTHER removed/added name (an unambiguous 1:1 pairing), is a `renamed`
 * pair rather than an unrelated drop+add — the same field under a new
 * label, never a real removal. Renamed pairs are excluded from
 * `added`/`removed` (so they don't drag the delta to `non-additive`) and
 * carried under `SchemaDelta.renamed` instead — a pure rename is
 * additive-safe, same as `additiveOnly()`/`lockSchema()` already treat any
 * other additive-only change (no cutover transform demanded to admit the
 * name change itself; a real value migration, if the record shape truly
 * changed underneath, is still the caller's job via `coordinatedCutover`).
 * A drop+add pair whose shapes DIFFER (or whose shape collides with more
 * than one candidate) stays classified as a plain removal + addition —
 * still `non-additive` — since there is no reliable structural signal that
 * it is the same field.
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

  const addedAll = bKeys.filter(k => !(k in aProps))
  const removedAll = aKeys.filter(k => !(k in bProps))

  // Group each side's candidates by canonicalized shape; a shape with
  // exactly one removed name and exactly one added name is an unambiguous
  // rename pairing.
  const removedByShape = new Map<string, string[]>()
  for (const k of removedAll) {
    const shape = canonicalize(aProps[k])
    const list = removedByShape.get(shape)
    if (list) list.push(k); else removedByShape.set(shape, [k])
  }
  const addedByShape = new Map<string, string[]>()
  for (const k of addedAll) {
    const shape = canonicalize(bProps[k])
    const list = addedByShape.get(shape)
    if (list) list.push(k); else addedByShape.set(shape, [k])
  }

  const renamed: { from: string; to: string }[] = []
  const renamedFrom = new Set<string>()
  const renamedTo = new Set<string>()
  for (const [shape, removedNames] of removedByShape) {
    const addedNames = addedByShape.get(shape)
    if (removedNames.length === 1 && addedNames?.length === 1) {
      const from = removedNames[0]!
      const to = addedNames[0]!
      renamed.push({ from, to })
      renamedFrom.add(from)
      renamedTo.add(to)
    }
  }

  const added = addedAll.filter(k => !renamedTo.has(k))
  const removed = removedAll.filter(k => !renamedFrom.has(k))

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
  if (added.length === 0 && removed.length === 0 && changed.length === 0 && renamed.length === 0) {
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

  return { collection, kind, added, removed, changed, ...(renamed.length > 0 ? { renamed } : {}) }
}
