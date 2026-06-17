/**
 * @klum-db/lobby interchange — field-authority conflict resolution (FR-4).
 *
 * Pure functions: given an app-supplied per-field policy and both sides'
 * RECORD-level provenance (FR-5 `_source`/`_sourceTs`), decide field-by-field
 * whether the incoming value wins. No vault I/O — unit-testable in isolation.
 * @module
 */

/** How a single field's authority is decided on merge. */
export type FieldAuthorityRule =
  | { readonly authority: 'source-newest' }
  | { readonly authority: 'owner'; readonly ownerSource: string }
  | { readonly authority: 'fixed-source'; readonly source: string }

/** Per-collection field → rule map. Fields not listed default to keep-local. */
export type FieldAuthorityPolicy = Record<string, FieldAuthorityRule>

/** Record-level provenance for both sides (shared across all fields — Q3 defer). */
export interface FieldAuthorityInputs {
  readonly incomingSource?: string
  readonly incomingSourceTs?: string
  readonly localSource?: string
  readonly localSourceTs?: string
}

/** Thrown when a collection resolves to `field-authority` but no policy is supplied for it. */
export class FieldAuthorityPolicyMissingError extends Error {
  constructor(collection: string) {
    super(
      `mergeCompartment: the 'field-authority' strategy for "${collection}" requires a ` +
        `fieldAuthority policy entry for that collection, but none was supplied.`,
    )
    this.name = 'FieldAuthorityPolicyMissingError'
  }
}

/** Decide whether the INCOMING value of one field wins. Pure. Defaults never clobber on ambiguity. */
export function resolveFieldAuthority(
  rule: FieldAuthorityRule,
  io: FieldAuthorityInputs,
): 'incoming' | 'local' {
  switch (rule.authority) {
    case 'source-newest': {
      const inc = io.incomingSourceTs
      const loc = io.localSourceTs
      if (inc === undefined) return 'local'        // no incoming provenance → don't clobber
      if (loc === undefined) return 'incoming'     // local has none, incoming does
      return inc > loc ? 'incoming' : 'local'      // ISO-8601 lexicographic; tie → local
    }
    case 'owner':
      return io.incomingSource === rule.ownerSource ? 'incoming' : 'local'
    case 'fixed-source':
      return io.incomingSource === rule.source ? 'incoming' : 'local'
  }
}

/**
 * Build the merged record per policy, starting from the local (`before`) copy
 * and overlaying only the changed fields whose rule resolves to `incoming`.
 * Returns the merged record plus a per-field decision map (for the audit report).
 * Pure — no I/O.
 */
export function resolveRecordByFieldAuthority(
  policy: FieldAuthorityPolicy,
  before: Record<string, unknown>,
  incoming: Record<string, unknown>,
  changedFields: readonly string[],
  io: FieldAuthorityInputs,
): { merged: Record<string, unknown>; decisions: Record<string, 'incoming' | 'local'> } {
  const merged: Record<string, unknown> = { ...before }
  const decisions: Record<string, 'incoming' | 'local'> = {}
  for (const f of changedFields) {
    const rule = policy[f]
    if (rule === undefined) { decisions[f] = 'local'; continue }   // unlisted → keep local
    const who = resolveFieldAuthority(rule, io)
    decisions[f] = who
    if (who === 'incoming') merged[f] = incoming[f]
  }
  return { merged, decisions }
}
