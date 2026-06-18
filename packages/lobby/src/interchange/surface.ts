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
 * and field projection. Only surface.collections are included in the bundle:
 * `seeds` keys are exactly `surface.collections` and `maxDepth: 0` bounds the
 * walk so no non-surface collection can enter the closure. NOTE: if a surface
 * collection holds a `ref()` to an OUT-OF-SURFACE collection, the export
 * hard-fails with `PartitionExtractionError` (the safe outcome — it never
 * silently pulls in or leaks the referenced collection); surfaces over
 * collections that cross-reference outside the surface are not supported.
 * Excluded fields are structurally redacted before re-encryption and never
 * travel in the bundle.
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
 * NOTE: a field-projected slice applied with a `take-incoming` conflict policy
 * is DESTRUCTIVE to non-surface fields on a record the receiver already holds
 * (the narrowed `{id, ...surface.fields}` overwrites the full row, dropping its
 * other fields). Use `keep-local` or `field-authority` when the receiver's
 * out-of-surface fields must be preserved across a projected push.
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

// ─── Cadence helpers ──────────────────────────────────────────────────────────

/**
 * Pure due-check — deterministic, no Date.now() inside.
 *
 * A surface is due iff:
 *  - it has a `cadenceMs` (manually-only surfaces are never due via this check)
 *  - its `status` is `'agreed'` (proposed/suspended do not fire)
 *  - it has never been synced (`lastSyncAt === undefined`), OR
 *    `now` has reached or passed `nextSyncDueAt`
 *
 * The caller always passes `now` explicitly so the function is testable without
 * any timer mocking.
 */
export function isSurfaceDue(surface: SurfaceRow, now: number): boolean {
  if (surface.cadenceMs === undefined) return false
  if (surface.status !== 'agreed') return false
  if (surface.lastSyncAt === undefined) return true
  return now >= (surface.nextSyncDueAt ?? 0)
}

/**
 * Filter a list of surfaces to those that are currently due.
 * Delegates to `isSurfaceDue` for each entry.
 */
export function listDueSurfaces(surfaces: readonly SurfaceRow[], now: number): SurfaceRow[] {
  return surfaces.filter(s => isSurfaceDue(s, now))
}

/**
 * Stamp `lastSyncAt = now` and `nextSyncDueAt = now + surface.cadenceMs` in
 * the StateManagementVault after a successful sync run. The surface must exist
 * (reads it to get `cadenceMs`). If `cadenceMs` is undefined the stamps are
 * written with `nextSyncDueAt = now` (no-op for future due-checks).
 *
 * Does NOT call Date.now() internally — the caller supplies `now`.
 */
export async function markSynced(
  smv: StateManagementVault,
  id: string,
  now: number,
): Promise<SurfaceRow> {
  const existing = await smv.getSurface(id)
  if (!existing) throw new Error(`markSynced: surface not found: ${id}`)
  const cadenceMs = existing.cadenceMs ?? 0
  return smv.updateSurface(id, {
    lastSyncAt: now,
    nextSyncDueAt: now + cadenceMs,
  })
}

/**
 * Thin interval driver for surface cadence.
 *
 * Wraps a `Map<surfaceId, timer>` so each surface can be independently
 * started / stopped. `start` calls `setInterval(fn, intervalMs)` and
 * replaces any existing timer for the same id. `stopAll` clears all.
 *
 * Accepts an injectable `nowFn` (default `Date.now`) for use-sites that
 * need to capture the current time inside the callback — the pure due-check
 * (`isSurfaceDue`) takes `now` explicitly and should not call this.
 */
export class SurfaceCadenceScheduler {
  readonly #timers = new Map<string, ReturnType<typeof setInterval>>()
  readonly #nowFn: () => number

  constructor(nowFn: () => number = Date.now) {
    this.#nowFn = nowFn
  }

  /** Expose nowFn for callback use-sites. */
  get now(): number {
    return this.#nowFn()
  }

  /**
   * Schedule `fn` to fire every `intervalMs` milliseconds for the given
   * `surfaceId`. If the id is already running, the previous interval is
   * cancelled first (replace semantics).
   */
  start(surfaceId: string, intervalMs: number, fn: () => void): void {
    this.stop(surfaceId)
    const timer = setInterval(fn, intervalMs)
    this.#timers.set(surfaceId, timer)
  }

  /** Cancel the interval for `surfaceId` (no-op if not running). */
  stop(surfaceId: string): void {
    const timer = this.#timers.get(surfaceId)
    if (timer !== undefined) {
      clearInterval(timer)
      this.#timers.delete(surfaceId)
    }
  }

  /** Cancel all running intervals. */
  stopAll(): void {
    for (const [id] of this.#timers) {
      this.stop(id)
    }
  }
}
