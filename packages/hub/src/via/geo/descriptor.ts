/**
 * `geo()` — the field descriptor for a `{ lat, lng }` point (#1355).
 *
 * A branded schema-layer descriptor, a sibling of `money()` / `lookup()`.
 * It owns one decision: at what geohash PRECISION this field is indexed
 * and stored. The math lives in {@link ./geohash}; the query participation
 * in {@link ./where}.
 *
 * Declared through the `via()` composer:
 *
 * ```ts
 * vault.collection('places', {
 *   viaFields: { at: via(geo()) },
 *   indexes: [{ fields: ['at'], kind: 'sorted' }],
 * })
 * ```
 *
 * The sorted index is what makes `near()` cheaper than a scan; without it
 * the query still returns the RIGHT answer, just by walking every record.
 */
import { NoydbError } from '../../kernel/errors.js'
import type { ViaDescriptor } from '../../kernel/via/index.js'
import { MAX_PRECISION } from './geohash.js'
import { linkGeoVia } from './binding.js'

export interface GeoOptions {
  /**
   * Geohash characters stored and indexed per record. Default 9
   * (≈ 4.8m × 4.8m) — finer than any consumer GPS fix and still short
   * enough that a prefix cover of a city-scale radius is a handful of
   * cells.
   */
  readonly precision?: number
  /**
   * Ceiling on how many geohash prefixes one `near()` query may probe.
   * Default 32. Raising it buys a tighter candidate set at the cost of
   * more index slices per query; lowering it does the reverse. It never
   * affects CORRECTNESS — the cover is a superset at every precision and
   * the haversine post-filter is the exact answer either way.
   */
  readonly maxPrefixes?: number
}

export interface GeoDescriptor extends ViaDescriptor {
  readonly _viaBrand: 'geo'
  readonly precision: number
  readonly maxPrefixes: number
}

/** Raised when a written value is not a usable `{ lat, lng }` point. */
export class GeoPointError extends NoydbError {
  constructor(
    public readonly field: string,
    public readonly value: unknown,
  ) {
    super(
      'GEO_POINT',
      `geo: field "${field}" expects { lat, lng } with lat in [-90, 90] and lng in [-180, 180], ` +
        `got ${JSON.stringify(value)}`,
    )
    this.name = 'GeoPointError'
  }
}

/** Create a {@link GeoDescriptor}. */
export function geo(options: GeoOptions = {}): GeoDescriptor {
  // Same #553 static-link discipline as `money()` / `computed()`: constructing
  // the descriptor is the binding's opt-in unit, so whichever module instance
  // produced this descriptor also holds the binder the pipeline will resolve.
  linkGeoVia()
  const precision = options.precision ?? 9
  if (!Number.isInteger(precision) || precision < 1 || precision > MAX_PRECISION) {
    throw new TypeError(`geo: precision must be an integer in 1..${MAX_PRECISION}, got ${String(precision)}`)
  }
  const maxPrefixes = options.maxPrefixes ?? 32
  if (!Number.isInteger(maxPrefixes) || maxPrefixes < 1) {
    throw new TypeError(`geo: maxPrefixes must be a positive integer, got ${String(maxPrefixes)}`)
  }
  return { _viaBrand: 'geo', precision, maxPrefixes }
}

/** Runtime predicate for detecting a {@link GeoDescriptor}. */
export function isGeoDescriptor(x: unknown): x is GeoDescriptor {
  return typeof x === 'object' && x !== null && (x as { _viaBrand?: unknown })._viaBrand === 'geo'
}
