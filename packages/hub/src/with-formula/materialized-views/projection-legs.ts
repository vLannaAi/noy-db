/**
 * Projection-leg topology (#810, extended by #1140).
 *
 * A projection MV's legs originally all attached to the PRIMARY row: a forward
 * leg named an FK field on `projection.source`, and a reverse `collect` leg's
 * `on` field had to `ref()` the source itself. Anything two FKs away was
 * therefore inexpressible — `bill → entity → client` has no leg shape, because
 * the bill has no `clientId` and `clients.entityId` refs `entities`, not
 * `bills`.
 *
 * `from` closes that: a leg may attach to a previously-declared ALIAS instead of
 * to the primary row. This module owns the two questions that follow from it —
 * *is this leg graph well-formed?* and *which collection does a leg's rows come
 * from?* — so neither the registry nor the executor has to re-derive them.
 *
 * **Why cycles are impossible by construction, and there is no depth cap.**
 * `from` may only name an alias declared EARLIER in `joins`. A leg can therefore
 * never reach forward, the graph is a forest rooted at the primary row, and its
 * depth is bounded by the number of legs. Validation refuses an unknown or
 * not-yet-declared alias, which is the same check.
 */

import { MaterializedViewConfigError } from '../../kernel/errors.js'
import type { ProjectionJoinLeg, ProjectionSpec } from './types.js'

/** Reverse (one-to-many) leg — discriminated on `collect`, as the type is. */
export function isCollectLeg(
  leg: ProjectionJoinLeg,
): leg is Extract<ProjectionJoinLeg, { collect: string }> {
  return 'collect' in leg
}

/**
 * Refuse a malformed leg graph where `withMaterializedView()` checks the rest of
 * the leg shape — at spec CONSTRUCTION, not at vault open and not at first
 * materialization. Alias wiring is pure configuration: it needs no refs, no
 * records and no store, so the earliest failure is the best one.
 * (Ref EXISTENCE still resolves at first materialization, unchanged — refs
 * cannot exist until after `openVault()` returns.)
 */
export function validateProjectionLegs<T extends Record<string, unknown>>(
  mvName: string,
  projection: ProjectionSpec<T>,
): void {
  // Non-empty and unique `as` are already refused by `withMaterializedView()`
  // itself, earlier and with its own message — not re-checked here. This
  // function owns the `from` wiring and nothing else.
  const seen = new Map<string, ProjectionJoinLeg>()
  for (const leg of projection.joins) {
    if (leg.from !== undefined) {
      const parent = seen.get(leg.from)
      if (!parent) {
        throw new MaterializedViewConfigError(
          `"${mvName}": projection leg "${leg.as}" declares from: "${leg.from}", which is not an ` +
            `alias declared EARLIER in \`joins\`. A leg may only attach to the primary row or to a ` +
            `preceding leg — that ordering rule is what makes a cycle impossible. Known so far: ` +
            `${[...seen.keys()].map(a => `"${a}"`).join(', ') || '(none)'}`,
        )
      }
      if (isCollectLeg(parent)) {
        throw new MaterializedViewConfigError(
          `"${mvName}": projection leg "${leg.as}" declares from: "${leg.from}", but "${leg.from}" ` +
            `is a collect leg and holds an ARRAY of rows, not one record. A leg can only hang off a ` +
            `forward leg (record | null). Attach it to the primary row instead, or collect the ` +
            `far side directly if its ref() reaches "${projection.source}".`,
        )
      }
    }
    seen.set(leg.as, leg)
  }
}

/**
 * The collection a leg's rows come from — the primary source for a root leg, the
 * `from` leg's own target otherwise.
 *
 * Returns `null` when a forward `ref()` somewhere along the chain is not
 * declared yet, which at registration time is the normal case rather than an
 * error: refs are declared after `openVault()` returns, so the registry retries
 * this on every dispatch until it resolves (`_pendingForwardDeps`).
 *
 * `resolveRef` is passed in rather than imported so this module stays free of
 * vault wiring — the registry hands it the ref registry's `getOutbound`, the
 * executor hands it a join context lookup. Both answer the same question.
 */
export type RefLookup = (collection: string, field: string) => { target: string } | null

export function resolveLegOwner(
  leg: ProjectionJoinLeg,
  joins: ReadonlyArray<ProjectionJoinLeg>,
  source: string,
  resolveRef: RefLookup,
): string | null {
  if (leg.from === undefined) return source
  const parent = joins.find(l => l.as === leg.from)
  if (!parent) return null // refused by validateProjectionLegs; defensive here
  if (isCollectLeg(parent)) return parent.collect // refused too, same reason
  const parentOwner = resolveLegOwner(parent, joins, source, resolveRef)
  if (parentOwner === null) return null
  return resolveRef(parentOwner, parent.field)?.target ?? null
}

/**
 * The collection a FORWARD leg resolves INTO — i.e. its dependency. `null` while
 * any ref in the chain (including this leg's own) is still undeclared.
 */
export function resolveForwardLegTarget(
  leg: Extract<ProjectionJoinLeg, { field: string }>,
  joins: ReadonlyArray<ProjectionJoinLeg>,
  source: string,
  resolveRef: RefLookup,
): string | null {
  const owner = resolveLegOwner(leg, joins, source, resolveRef)
  if (owner === null) return null
  return resolveRef(owner, leg.field)?.target ?? null
}
