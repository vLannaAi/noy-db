/**
 * @klum-db/lobby interchange — Surface bilateral handshake + export/apply (FR-7).
 * Pure helpers: `now` is always passed in; no Date.now() calls inside.
 * @packageDocumentation
 */
import { generateULID } from '@noy-db/hub/kernel'
import type { Vault } from '@noy-db/hub'
import { extractPartition } from '@noy-db/hub/bundle'
import { mergeCompartment, type MergeReport } from './merge-compartment.js'
import type { StateManagementVault } from '../federation/state-vault.js'
import type {
  SurfaceRow,
  SurfaceDirection,
  SurfaceConflictPolicy,
} from '../federation/types.js'

// ─── Public types ─────────────────────────────────────────────────────────────

/**
 * User-facing subset of SurfaceRow: the fields a caller provides when
 * proposing a new surface. `id` is optional (auto-generated via ULID when
 * omitted). `status`, `proposedBy`, `createdAt`, etc. are set by `proposeSurface`.
 */
export interface SurfaceDefinition {
  readonly id?: string
  readonly collections: readonly string[]
  readonly fields?: Record<string, readonly string[]>
  readonly direction: SurfaceDirection
  readonly conflictPolicy: SurfaceConflictPolicy
  readonly cadenceMs?: number
}

// ─── Error classes ────────────────────────────────────────────────────────────

/** Thrown when a surface id cannot be found in the StateManagementVault. */
export class SurfaceNotFoundError extends Error {
  override name = 'SurfaceNotFoundError'
  constructor(surfaceId: string) {
    super(`Surface not found: ${surfaceId}`)
  }
}

/**
 * Thrown when an operation is invalid for the surface's current status
 * (e.g. agreeing on an already-agreed or suspended surface).
 */
export class SurfaceStateError extends Error {
  override name = 'SurfaceStateError'
  constructor(surfaceId: string, currentStatus: string, requiredStatus: string) {
    super(
      `Surface ${surfaceId} has status '${currentStatus}', expected '${requiredStatus}'`,
    )
  }
}

// ─── Handshake helpers ────────────────────────────────────────────────────────

/**
 * Party A: persist a new `status:'proposed'` SurfaceRow in the
 * StateManagementVault. The `id` in `def` is used when provided;
 * otherwise a fresh ULID is generated. `now` is the creation timestamp
 * (caller supplies, no Date.now() inside).
 */
export async function proposeSurface(
  smv: StateManagementVault,
  def: SurfaceDefinition,
  proposedBy: string,
  now: number,
): Promise<SurfaceRow> {
  const row: SurfaceRow = {
    ...def,
    id: def.id ?? generateULID(),
    status: 'proposed',
    proposedBy,
    createdAt: now,
  }
  await smv.createSurface(row)
  return row
}

/**
 * Party B: read the surface, assert it is in `'proposed'` status, then
 * flip it to `'agreed'` (setting `agreedBy`). Returns the updated row.
 *
 * Throws:
 * - `SurfaceNotFoundError` when `surfaceId` is absent.
 * - `SurfaceStateError` when the surface status is not `'proposed'`.
 *
 * `_now` is accepted for API symmetry with `proposeSurface` (Task 5 will
 * use it for `lastSyncAt` stamping); it is not written in this task.
 */
export async function agreeSurface(
  smv: StateManagementVault,
  surfaceId: string,
  agreedBy: string,
  _now: number,
): Promise<SurfaceRow> {
  const existing = await smv.getSurface(surfaceId)
  if (!existing) throw new SurfaceNotFoundError(surfaceId)
  if (existing.status !== 'proposed') {
    throw new SurfaceStateError(surfaceId, existing.status, 'proposed')
  }
  return smv.updateSurface(surfaceId, { status: 'agreed', agreedBy })
}

// ─── Export / Apply ───────────────────────────────────────────────────────────

/**
 * Export a scoped partition from `source` bounded to the surface's collections
 * and field projection. Only surface.collections are included in the bundle
 * (`maxDepth: 0` prevents ref-expansion to non-surface collections; the `seeds`
 * keys are exactly `surface.collections`). Excluded fields are structurally
 * redacted before re-encryption and never travel in the bundle.
 *
 * `exportSurface`/`applySurface` are direction-AGNOSTIC mechanics: export
 * produces a slice from a source vault, apply merges a slice into a receiver
 * vault. Both are needed for EVERY direction (push: proposer exports → agreer
 * applies; pull: agreer exports → proposer applies; bidi: both). `direction` is
 * orchestration metadata honoured by the sync flow (which party exports vs
 * applies), not a gate on the primitives — gating it here would make pull
 * surfaces unusable.
 *
 * Throws:
 * - `SurfaceStateError` when `surface.status !== 'agreed'`.
 */
export async function exportSurface(
  source: Vault,
  surface: SurfaceRow,
): Promise<{ bundleBytes: Uint8Array; transferKey: Uint8Array }> {
  if (surface.status !== 'agreed') {
    throw new SurfaceStateError(surface.id, surface.status, 'agreed')
  }

  // Seeds: include ALL records in each surface collection (no predicate filtering).
  // maxDepth:0 ensures ref-following stops at the seed collections so no
  // non-surface collection can slip into the closure.
  const seeds = Object.fromEntries(surface.collections.map(c => [c, () => true]))

  const { bundleBytes, transferKey } = await extractPartition(source, {
    seeds,
    maxDepth: 0,
    ...(surface.fields ? { fieldProjection: surface.fields } : {}),
    carrySchemas: false,
    carryLedger: false,
  })

  return { bundleBytes, transferKey }
}

/**
 * Apply an exported surface bundle into `receiver`. Decrypts + merges using
 * the surface's conflict policy.
 *
 * Direction-agnostic mechanic (see `exportSurface`): the receiver merges the
 * slice regardless of direction; the sync flow decides which party applies.
 *
 * Throws:
 * - `SurfaceStateError` when `surface.status !== 'agreed'`.
 */
export async function applySurface(
  receiver: Vault,
  surface: SurfaceRow,
  bundleBytes: Uint8Array,
  transferKey: Uint8Array,
): Promise<MergeReport> {
  if (surface.status !== 'agreed') {
    throw new SurfaceStateError(surface.id, surface.status, 'agreed')
  }

  return mergeCompartment(receiver, bundleBytes, {
    transferKey,
    strategy: surface.conflictPolicy.strategy,
    ...(surface.conflictPolicy.fieldAuthority
      ? { fieldAuthority: surface.conflictPolicy.fieldAuthority }
      : {}),
    reason: `sync:surface:${surface.id}`,
  })
}
