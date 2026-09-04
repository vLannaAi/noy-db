/**
 * `@noy-db/hub` geospatial field descriptor (#1355) — `geo()` plus the
 * pure primitives a consumer may want directly (`haversineKm` for a
 * distance column, `encodeGeohash` for a cell label).
 *
 * @see ./descriptor for the public `geo()` factory.
 * @see ./geohash for the superset law the prefix cover obeys.
 */
export { geo, isGeoDescriptor, GeoPointError } from './descriptor.js'
export type { GeoDescriptor, GeoOptions } from './descriptor.js'
export {
  haversineKm,
  encodeGeohash,
  decodeGeohashBox,
  boundingBox,
  coverPrefixes,
  coverSize,
  prefixesForRadius,
  isGeoPoint,
  gridBits,
  EARTH_RADIUS_KM,
  MAX_PRECISION,
} from './geohash.js'
export type { GeoPoint, GeoBox } from './geohash.js'
export type { NearOperand, GeoWhereOperand, GeoNearOperand, GeoPassthroughOperand } from './where.js'
