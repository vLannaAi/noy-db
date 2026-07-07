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
