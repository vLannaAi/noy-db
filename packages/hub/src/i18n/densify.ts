/**
 * #435 v1.x densifyOnWrite — eager-fill empty i18n slots from each field's
 * substitute chain at write time, recording provenance in the internal
 * `_i18nFilled` marker (decision A: dense map + prior-read).
 *
 * Pure functions over plain records; all DB wiring lives in collection.ts.
 * Only single-leaf i18n fields are supported (array-wildcard paths are
 * skipped, mirroring auto-translate).
 */
import { getAtPath, resolveI18nText } from './core.js'
import type { I18nTextDescriptor } from './core.js'

const MARKER = '_i18nFilled'

type Leaf = Record<string, string>

/** Locales recorded as densify-filled on the prior record for `field`. */
function priorFilled(prior: Record<string, unknown> | undefined, field: string): Set<string> {
  if (!prior) return new Set()
  const marker = prior[MARKER] as Record<string, string[]> | undefined
  return new Set(marker?.[field] ?? [])
}

/** The single leaf map for `field`, or undefined for absent / array-wildcard / non-object. */
function singleLeaf(record: Record<string, unknown>, field: string): Leaf | undefined {
  const leaves = getAtPath(record, field)
  if (leaves.length !== 1) return undefined
  const leaf = leaves[0]
  if (!leaf || typeof leaf !== 'object' || Array.isArray(leaf)) return undefined
  return leaf as Leaf
}

/**
 * Per field, the locales that are UNCHANGED round-tripped densify fills — i.e.
 * marked filled on the prior record AND identical in the incoming record.
 * These are exempt from write-time script enforcement (they are derived copies,
 * not authored text). Slots the user changed are NOT exempt (validated as authored).
 */
export function computeExemptFills(
  prior: Record<string, unknown> | undefined,
  incoming: Record<string, unknown>,
  fields: Record<string, I18nTextDescriptor>,
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  if (!prior) return out
  for (const field of Object.keys(fields)) {
    const filled = priorFilled(prior, field)
    if (filled.size === 0) continue
    const priorLeaf = singleLeaf(prior, field)
    const incLeaf = singleLeaf(incoming, field)
    if (!priorLeaf || !incLeaf) continue
    const exempt = new Set<string>()
    for (const loc of filled) {
      if (incLeaf[loc] !== undefined && incLeaf[loc] !== '' && incLeaf[loc] === priorLeaf[loc]) {
        exempt.add(loc)
      }
    }
    if (exempt.size > 0) out.set(field, exempt)
  }
  return out
}

/**
 * Mutate `record` in place: fill empty declared-language slots for each
 * densify-enabled field from the field's substitute chain, recompute unchanged
 * prior fills, clear marks for slots that became authored, and write the
 * resulting `_i18nFilled` marker (removed when empty).
 *
 * `prior` is read-only — it is never mutated.
 *
 * Provenance uses value-equality (decision A): a slot counts as an unchanged
 * fill when it was prior-marked AND its value still equals the prior value. A
 * consequence is that re-authoring a value byte-identical to the existing fill
 * keeps it classified as a fill (the visible value is unchanged either way; the
 * slot stays script-exempt and will auto-refresh if its source later changes).
 * This is inherent to value-equality provenance, not a bug.
 */
export function densify(
  record: Record<string, unknown>,
  prior: Record<string, unknown> | undefined,
  fields: Record<string, I18nTextDescriptor>,
): void {
  let marker = record[MARKER] as Record<string, string[]> | undefined

  for (const [field, descriptor] of Object.entries(fields)) {
    const leaf = singleLeaf(record, field)
    if (!leaf) continue
    const { languages, substitute, smartSubstitute } = descriptor.options
    const filledSet = priorFilled(prior, field)
    const priorLeaf = singleLeaf(prior ?? {}, field)
    const isUnchangedFill = (loc: string): boolean =>
      filledSet.has(loc) && priorLeaf?.[loc] !== undefined && leaf[loc] === priorLeaf[loc]

    // Authored source = present, non-empty, NOT an unchanged prior fill.
    const authored: Leaf = {}
    for (const [loc, val] of Object.entries(leaf)) {
      if (typeof val === 'string' && val !== '' && !isUnchangedFill(loc)) authored[loc] = val
    }

    const filled: string[] = []
    for (const loc of languages) {
      if (authored[loc] !== undefined) continue // real value present → not a fill
      const sub = resolveI18nText(authored, loc, undefined, field, {
        policy: 'substitute',
        substitute: substitute ?? ['any'],
        ...(smartSubstitute ? { smartSubstitute } : {}),
      })
      if (typeof sub === 'string' && sub !== '') {
        leaf[loc] = sub
        filled.push(loc)
      } else if (isUnchangedFill(loc)) {
        delete leaf[loc] // stale fill with no source left → drop it
      }
    }

    if (filled.length > 0) {
      marker ??= {}
      marker[field] = filled
    } else if (marker) {
      delete marker[field]
    }
  }

  if (marker && Object.keys(marker).length > 0) {
    record[MARKER] = marker
  } else {
    delete record[MARKER]
  }
}
