/**
 * The geospatial primitives (#1355) — geohash encoding, great-circle
 * distance, and the bounding-box → prefix-set cover that lets a `near()`
 * query take the existing sorted index.
 *
 * ⭐ WHY A GEOHASH PREFIX AND NOT A COORDINATE. The store holds ciphertext
 * and never runs a query, but a secondary index key is a value the hub
 * itself keeps in a structure a persisted sidecar can carry (#1359). A raw
 * `lat`/`lng` in that key space is a coordinate at full precision; a
 * geohash PREFIX is a cell — deliberately lossy, and the coarser the query
 * the less it says. That is the whole reason this module exists rather
 * than a pair of numeric range indexes on `lat` and `lng`.
 *
 * ⛔ THE SUPERSET LAW. {@link coverPrefixes} must return a cover whose
 * union CONTAINS every point of the box, and {@link boundingBox} a box
 * that contains every point within the radius. A candidate set that is
 * too big costs a haversine call per extra row; one that is too small is
 * a WRONG ANSWER, and no post-filter can put a dropped record back.
 * `__tests__/geo-superset.test.ts` is the property that pins it.
 *
 * Pure, portable, dependency-free — no Node built-ins, no npm math lib.
 */

/** A WGS-84 point. Latitude in [-90, 90], longitude in [-180, 180]. */
export interface GeoPoint {
  readonly lat: number
  readonly lng: number
}

/** A latitude/longitude rectangle. Never wraps: {@link boundingBox} splits at the antimeridian instead. */
export interface GeoBox {
  readonly minLat: number
  readonly maxLat: number
  readonly minLng: number
  readonly maxLng: number
}

/** Mean Earth radius (IUGG), km — the same constant every reference haversine uses. */
export const EARTH_RADIUS_KM = 6371.0088

/** The geohash alphabet: base-32 with `a`, `i`, `l`, `o` removed. */
const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz'

/** Widest geohash precision this module encodes. 12 chars ≈ 3.7cm — past any GPS fix. */
export const MAX_PRECISION = 12

const DEG = Math.PI / 180

/** True when `p` is a usable point. Rejects NaN, infinities and out-of-range values. */
export function isGeoPoint(p: unknown): p is GeoPoint {
  if (typeof p !== 'object' || p === null) return false
  const { lat, lng } = p as { lat?: unknown; lng?: unknown }
  return (
    typeof lat === 'number' && Number.isFinite(lat) && lat >= -90 && lat <= 90 &&
    typeof lng === 'number' && Number.isFinite(lng) && lng >= -180 && lng <= 180
  )
}

/**
 * Great-circle distance in kilometres.
 *
 * Haversine rather than the law of cosines: the two agree to metres at
 * continental scale, but `acos` loses all its significant digits for
 * nearby points (`cos d → 1`), which is exactly the regime a `near()`
 * query lives in.
 */
export function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const dLat = (b.lat - a.lat) * DEG
  const dLng = (b.lng - a.lng) * DEG
  const lat1 = a.lat * DEG
  const lat2 = b.lat * DEG
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)))
}

/**
 * Encode a point as a geohash of `precision` characters.
 *
 * Bits interleave longitude-first, which is what makes a shared prefix
 * mean "the same cell" and therefore what makes the sorted index's
 * `startsWith` slice a spatial answer.
 */
export function encodeGeohash(point: GeoPoint, precision: number): string {
  if (!isGeoPoint(point)) throw new RangeError(`encodeGeohash: not a point: ${JSON.stringify(point)}`)
  const p = clampPrecision(precision)
  let latMin = -90, latMax = 90, lngMin = -180, lngMax = 180
  let hash = '', bits = 0, ch = 0, evenBit = true
  while (hash.length < p) {
    if (evenBit) {
      const mid = (lngMin + lngMax) / 2
      if (point.lng >= mid) { ch = (ch << 1) + 1; lngMin = mid } else { ch <<= 1; lngMax = mid }
    } else {
      const mid = (latMin + latMax) / 2
      if (point.lat >= mid) { ch = (ch << 1) + 1; latMin = mid } else { ch <<= 1; latMax = mid }
    }
    evenBit = !evenBit
    if (++bits === 5) { hash += BASE32[ch]; bits = 0; ch = 0 }
  }
  return hash
}

/** The cell a geohash names. Throws on a character outside the alphabet. */
export function decodeGeohashBox(hash: string): GeoBox {
  let latMin = -90, latMax = 90, lngMin = -180, lngMax = 180
  let evenBit = true
  for (const c of hash) {
    const idx = BASE32.indexOf(c)
    if (idx < 0) throw new RangeError(`decodeGeohashBox: "${c}" is not a geohash character`)
    for (let n = 4; n >= 0; n--) {
      const bit = (idx >> n) & 1
      if (evenBit) {
        const mid = (lngMin + lngMax) / 2
        if (bit === 1) lngMin = mid; else lngMax = mid
      } else {
        const mid = (latMin + latMax) / 2
        if (bit === 1) latMin = mid; else latMax = mid
      }
      evenBit = !evenBit
    }
  }
  return { minLat: latMin, maxLat: latMax, minLng: lngMin, maxLng: lngMax }
}

/** How many latitude / longitude bits a `precision`-character hash spends. */
export function gridBits(precision: number): { latBits: number; lngBits: number } {
  const total = clampPrecision(precision) * 5
  return { latBits: Math.floor(total / 2), lngBits: Math.ceil(total / 2) }
}

/**
 * The boxes enclosing every point within `radiusKm` of `center`.
 *
 * Returns TWO boxes when the circle crosses the antimeridian, and one
 * spanning the full longitude range when it reaches a pole — a rectangle
 * in lat/lng cannot express either case, and quietly clipping would
 * violate the superset law at exactly the coordinates nobody tests by
 * hand.
 */
export function boundingBox(center: GeoPoint, radiusKm: number): GeoBox[] {
  if (!isGeoPoint(center)) throw new RangeError(`boundingBox: not a point: ${JSON.stringify(center)}`)
  if (!Number.isFinite(radiusKm) || radiusKm < 0) throw new RangeError(`boundingBox: radiusKm must be a non-negative number, got ${radiusKm}`)
  // A hair of slack absorbs the float error between this box's arithmetic
  // and the haversine that post-filters against it. One superset-law
  // violation is a dropped record; one extra candidate is one more
  // haversine call.
  const eps = 1e-9
  const angular = radiusKm / EARTH_RADIUS_KM
  if (angular >= Math.PI) return [{ minLat: -90, maxLat: 90, minLng: -180, maxLng: 180 }]
  const latDelta = angular / DEG + eps
  const minLat = center.lat - latDelta
  const maxLat = center.lat + latDelta
  if (minLat <= -90 || maxLat >= 90) {
    // Pole inside the circle: every longitude is within reach.
    return [{ minLat: Math.max(-90, minLat), maxLat: Math.min(90, maxLat), minLng: -180, maxLng: 180 }]
  }
  // The widest longitude offset is taken at the edge of the band CLOSEST to
  // a pole, not at the centre's own latitude — a circle is fatter in
  // longitude there, and using the centre would clip its top corners.
  const worstLat = Math.max(Math.abs(minLat), Math.abs(maxLat)) * DEG
  const ratio = Math.sin(angular) / Math.cos(worstLat)
  if (!(ratio < 1)) return [{ minLat, maxLat, minLng: -180, maxLng: 180 }]
  const lngDelta = Math.asin(ratio) / DEG + eps
  const minLng = center.lng - lngDelta
  const maxLng = center.lng + lngDelta
  if (maxLng - minLng >= 360) return [{ minLat, maxLat, minLng: -180, maxLng: 180 }]
  if (minLng < -180) return [{ minLat, maxLat, minLng: -180, maxLng }, { minLat, maxLat, minLng: minLng + 360, maxLng: 180 }]
  if (maxLng > 180) return [{ minLat, maxLat, minLng, maxLng: 180 }, { minLat, maxLat, minLng: -180, maxLng: maxLng - 360 }]
  return [{ minLat, maxLat, minLng, maxLng }]
}

/** Number of `precision`-cells the boxes touch — computed from grid indices, never by enumerating. */
export function coverSize(boxes: readonly GeoBox[], precision: number): number {
  const { latBits, lngBits } = gridBits(precision)
  const latCells = 2 ** latBits
  const lngCells = 2 ** lngBits
  let total = 0
  for (const box of boxes) {
    const i0 = cellIndex(box.minLat, -90, 180, latCells)
    const i1 = cellIndex(box.maxLat, -90, 180, latCells)
    const j0 = cellIndex(box.minLng, -180, 360, lngCells)
    const j1 = cellIndex(box.maxLng, -180, 360, lngCells)
    total += (i1 - i0 + 1) * (j1 - j0 + 1)
  }
  return total
}

/**
 * The geohash prefixes whose cells cover `boxes` at `precision`.
 *
 * Every returned prefix is exactly `precision` characters, so the set can
 * be handed to the sorted index one `startsWith` at a time and unioned.
 */
export function coverPrefixes(boxes: readonly GeoBox[], precision: number): string[] {
  const p = clampPrecision(precision)
  const { latBits, lngBits } = gridBits(p)
  const latCells = 2 ** latBits
  const lngCells = 2 ** lngBits
  const latStep = 180 / latCells
  const lngStep = 360 / lngCells
  const out = new Set<string>()
  for (const box of boxes) {
    const i0 = cellIndex(box.minLat, -90, 180, latCells)
    const i1 = cellIndex(box.maxLat, -90, 180, latCells)
    const j0 = cellIndex(box.minLng, -180, 360, lngCells)
    const j1 = cellIndex(box.maxLng, -180, 360, lngCells)
    for (let i = i0; i <= i1; i++) {
      // The cell's CENTRE, so no rounding at a boundary can name a neighbour.
      const lat = -90 + (i + 0.5) * latStep
      for (let j = j0; j <= j1; j++) {
        const lng = -180 + (j + 0.5) * lngStep
        out.add(encodeGeohash({ lat, lng }, p))
      }
    }
  }
  return [...out].sort()
}

/**
 * The finest cover of `center`/`radiusKm` that stays within `maxCells`
 * prefixes, capped at `maxPrecision`.
 *
 * Finer is better: the prefixes ARE the candidate set, so a coarser cover
 * hands more rows to the haversine post-filter. The search always
 * terminates — precision 1 is a 4×8 grid, so 32 cells cover the planet.
 */
export function prefixesForRadius(
  center: GeoPoint,
  radiusKm: number,
  maxPrecision: number,
  maxCells: number,
): { prefixes: string[]; precision: number } {
  const boxes = boundingBox(center, radiusKm)
  const ceiling = Math.max(1, maxCells)
  for (let p = clampPrecision(maxPrecision); p > 1; p--) {
    if (coverSize(boxes, p) <= ceiling) return { prefixes: coverPrefixes(boxes, p), precision: p }
  }
  return { prefixes: coverPrefixes(boxes, 1), precision: 1 }
}

function cellIndex(value: number, origin: number, span: number, cells: number): number {
  const raw = Math.floor(((value - origin) / span) * cells)
  return Math.min(cells - 1, Math.max(0, raw))
}

function clampPrecision(precision: number): number {
  if (!Number.isInteger(precision) || precision < 1 || precision > MAX_PRECISION) {
    throw new RangeError(`geo: precision must be an integer in 1..${MAX_PRECISION}, got ${precision}`)
  }
  return precision
}
