import type { CollectionDescription } from '../introspection/describe.js'

/** One base↔satellite pair. v1: exactly one satellite per base. */
export interface SatelliteSpec {
  readonly base: string
  readonly satellite: string
  readonly fields: readonly string[]
  readonly joined?: string | undefined
}

/** Persisted into `_schemas/<satellite>` under `x-satellite` (R-S9 drift guard). */
export interface PairingMarker {
  readonly base: string
  readonly fieldsHash: string
  readonly joined?: string | undefined
  /**
   * Lifetime epoch (#597) — an opaque, stable-per-collection-lifetime stamp
   * minted the first time this marker is persisted and carried forward
   * unchanged by every later re-declare of the SAME collection. Optional:
   * markers persisted before this field existed have none. Deliberately
   * excluded from `satelliteMarkersEqual` — see that function's comment.
   * ADDITIVE ONLY today: there is no delete-collection API, so a stale
   * marker on a reused name is unreachable; the epoch-MISMATCH rejection
   * this would enable is a deferred follow-up once name reuse is possible.
   */
  readonly epoch?: string
}

/**
 * The full-record handle — deliberately NARROW (spec § The model): never a
 * `Collection<T>` cast. `describe()` works (the @noy-db/ui contract);
 * reactive APIs are absent from the type entirely.
 */
export interface JoinedHandle<T extends Record<string, unknown> = Record<string, unknown>> {
  get(id: string): Promise<T | null>
  put(id: string, record: T): Promise<void>
  delete(id: string): Promise<void>
  list(): Promise<T[]>
  describe(): Promise<CollectionDescription>
}
