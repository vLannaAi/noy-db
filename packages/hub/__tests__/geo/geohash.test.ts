import { describe, it, expect } from 'vitest'
import {
  boundingBox,
  coverPrefixes,
  coverSize,
  decodeGeohashBox,
  encodeGeohash,
  gridBits,
  haversineKm,
  isGeoPoint,
  prefixesForRadius,
  type GeoBox,
  type GeoPoint,
} from '../../src/via/geo/geohash.js'

const LONDON: GeoPoint = { lat: 51.5007, lng: -0.1246 }        // Big Ben
const PARIS: GeoPoint = { lat: 48.8584, lng: 2.2945 }          // Eiffel Tower
const NEW_YORK: GeoPoint = { lat: 40.6892, lng: -74.0445 }     // Statue of Liberty
const SYDNEY: GeoPoint = { lat: -33.8568, lng: 151.2153 }      // Opera House

/**
 * An INDEPENDENT great-circle formula — the spherical law of cosines.
 * Algebraically equivalent to the haversine on the same sphere but
 * numerically quite different (and famously bad for short distances), so
 * agreement between the two is evidence about the implementation rather
 * than a restatement of it.
 */
function lawOfCosinesKm(a: GeoPoint, b: GeoPoint): number {
  const R = 6371.0088
  const [la1, lo1, la2, lo2] = [a.lat, a.lng, b.lat, b.lng].map(d => (d * Math.PI) / 180) as [number, number, number, number]
  return R * Math.acos(Math.min(1, Math.sin(la1) * Math.sin(la2) + Math.cos(la1) * Math.cos(la2) * Math.cos(lo2 - lo1)))
}

describe('haversineKm — against known distances', () => {
  // Ground truth on the R = 6371.0088km sphere, each value cross-checked
  // against `lawOfCosinesKm` above (a different formula) and consistent with
  // published city-pair figures. Deliberately NOT round numbers pulled from
  // memory: at this scale the sphere-vs-WGS-84 difference is already tens of
  // km, so a "known distance" is only meaningful once its sphere is named.
  const cases: ReadonlyArray<[string, GeoPoint, GeoPoint, number]> = [
    ['London → Paris', LONDON, PARIS, 340.539],
    ['London → New York', LONDON, NEW_YORK, 5574.848],
    ['London → Sydney', LONDON, SYDNEY, 16993.481],
    ['Paris → Sydney', PARIS, SYDNEY, 16963.883],
  ]
  for (const [name, a, b, expected] of cases) {
    it(`${name} ≈ ${expected}km`, () => {
      expect(haversineKm(a, b)).toBeCloseTo(expected, 2)
    })
  }

  it('agrees with the spherical law of cosines wherever that formula is well-conditioned', () => {
    let checked = 0
    for (let i = 0; i < 200; i++) {
      const a: GeoPoint = { lat: ((i * 37) % 179) - 89.5, lng: ((i * 71) % 359) - 179.5 }
      const b: GeoPoint = { lat: ((i * 53) % 179) - 89.5, lng: ((i * 97) % 359) - 179.5 }
      const h = haversineKm(a, b)
      if (h < 10) continue // acos loses its digits here — that is why haversine is used
      expect(h).toBeCloseTo(lawOfCosinesKm(a, b), 3)
      checked++
    }
    expect(checked).toBeGreaterThan(150)
  })

  it('matches the closed-form identities the sphere fixes exactly', () => {
    const R = 6371.0088
    expect(haversineKm({ lat: 0, lng: 0 }, { lat: 0, lng: 90 })).toBeCloseTo((R * Math.PI) / 2, 6)
    expect(haversineKm({ lat: 0, lng: 0 }, { lat: 90, lng: 0 })).toBeCloseTo((R * Math.PI) / 2, 6)
    expect(haversineKm({ lat: 90, lng: 0 }, { lat: -90, lng: 0 })).toBeCloseTo(R * Math.PI, 6)
    expect(haversineKm({ lat: 0, lng: 0 }, { lat: 0, lng: 1 })).toBeCloseTo((R * Math.PI) / 180, 6)
  })

  it('is zero for a point against itself, and symmetric', () => {
    expect(haversineKm(LONDON, LONDON)).toBe(0)
    expect(haversineKm(LONDON, PARIS)).toBeCloseTo(haversineKm(PARIS, LONDON), 9)
  })

  it('one degree of latitude is ~111.2km anywhere', () => {
    for (const lat of [0, 30, 60, 89]) {
      expect(haversineKm({ lat, lng: 0 }, { lat: lat + 1, lng: 0 })).toBeCloseTo(111.19, 1)
    }
  })

  it('a degree of longitude shrinks with latitude, and vanishes at the pole', () => {
    const atEquator = haversineKm({ lat: 0, lng: 0 }, { lat: 0, lng: 1 })
    const at60 = haversineKm({ lat: 60, lng: 0 }, { lat: 60, lng: 1 })
    expect(atEquator).toBeCloseTo(111.19, 1)
    expect(at60).toBeCloseTo(atEquator / 2, 0)
    expect(haversineKm({ lat: 90, lng: 0 }, { lat: 90, lng: 179 })).toBeLessThan(1e-6)
  })

  it('measures ACROSS the antimeridian, not the long way round', () => {
    // 1° apart, straddling ±180 — a naive `lngB - lngA` reads 359°.
    expect(haversineKm({ lat: 0, lng: 179.5 }, { lat: 0, lng: -179.5 })).toBeCloseTo(111.19, 1)
  })

  it('the antipode is half the circumference', () => {
    expect(haversineKm({ lat: 10, lng: 20 }, { lat: -10, lng: -160 })).toBeCloseTo(20015, -1)
  })

  it('stays exact for very short distances (where law-of-cosines loses digits)', () => {
    // 1e-5° of latitude ≈ 1.11m.
    expect(haversineKm({ lat: 51, lng: 0 }, { lat: 51.00001, lng: 0 })).toBeCloseTo(0.001112, 6)
  })
})

describe('encodeGeohash / decodeGeohashBox', () => {
  it('reproduces the canonical reference hashes', () => {
    expect(encodeGeohash({ lat: 57.64911, lng: 10.40744 }, 11)).toBe('u4pruydqqvj')
    expect(encodeGeohash({ lat: 42.6, lng: -5.6 }, 5)).toBe('ezs42')
    expect(encodeGeohash({ lat: 0, lng: 0 }, 5)).toBe('s0000')
  })

  it('a shorter hash is a prefix of a longer one for the same point', () => {
    const full = encodeGeohash(LONDON, 12)
    for (let p = 1; p <= 12; p++) expect(full.startsWith(encodeGeohash(LONDON, p))).toBe(true)
  })

  it('decodes to a box that contains the point it encoded', () => {
    for (const point of [LONDON, PARIS, NEW_YORK, SYDNEY, { lat: 0, lng: 0 }, { lat: -90, lng: -180 }, { lat: 90, lng: 180 }]) {
      for (const p of [1, 5, 9]) {
        const box = decodeGeohashBox(encodeGeohash(point, p))
        expect(point.lat).toBeGreaterThanOrEqual(box.minLat)
        expect(point.lat).toBeLessThanOrEqual(box.maxLat)
        expect(point.lng).toBeGreaterThanOrEqual(box.minLng)
        expect(point.lng).toBeLessThanOrEqual(box.maxLng)
      }
    }
  })

  it('cell size matches the declared grid bits', () => {
    for (const p of [1, 2, 6, 9]) {
      const { latBits, lngBits } = gridBits(p)
      const box = decodeGeohashBox(encodeGeohash(LONDON, p))
      expect(box.maxLat - box.minLat).toBeCloseTo(180 / 2 ** latBits, 9)
      expect(box.maxLng - box.minLng).toBeCloseTo(360 / 2 ** lngBits, 9)
    }
  })

  it('refuses a non-point and an out-of-range precision', () => {
    expect(() => encodeGeohash({ lat: 91, lng: 0 }, 5)).toThrow(RangeError)
    expect(() => encodeGeohash({ lat: 0, lng: 181 }, 5)).toThrow(RangeError)
    expect(() => encodeGeohash({ lat: NaN, lng: 0 }, 5)).toThrow(RangeError)
    expect(() => encodeGeohash(LONDON, 0)).toThrow(RangeError)
    expect(() => encodeGeohash(LONDON, 13)).toThrow(RangeError)
    expect(() => decodeGeohashBox('a')).toThrow(RangeError)
  })
})

describe('isGeoPoint', () => {
  it('accepts a point and rejects everything else', () => {
    expect(isGeoPoint({ lat: 0, lng: 0 })).toBe(true)
    expect(isGeoPoint({ lat: 90, lng: 180 })).toBe(true)
    expect(isGeoPoint({ lat: -90, lng: -180 })).toBe(true)
    for (const bad of [null, undefined, 'x', 42, [], {}, { lat: 0 }, { lat: '0', lng: 0 }, { lat: NaN, lng: 0 }, { lat: Infinity, lng: 0 }, { lat: 90.1, lng: 0 }, { lat: 0, lng: -180.1 }]) {
      expect(isGeoPoint(bad)).toBe(false)
    }
  })
})

const inBoxes = (p: GeoPoint, boxes: readonly GeoBox[]): boolean =>
  boxes.some(b => p.lat >= b.minLat && p.lat <= b.maxLat && p.lng >= b.minLng && p.lng <= b.maxLng)

describe('boundingBox — the edge cases a rectangle cannot express', () => {
  it('a small circle is one box around the centre', () => {
    const boxes = boundingBox(LONDON, 10)
    expect(boxes).toHaveLength(1)
    expect(inBoxes(LONDON, boxes)).toBe(true)
  })

  it('SPLITS at the antimeridian instead of clipping', () => {
    const boxes = boundingBox({ lat: 0, lng: 179.9 }, 100)
    expect(boxes).toHaveLength(2)
    // A point 0.5° the OTHER side of ±180 is ~55km away — inside the radius,
    // and it must be inside the cover.
    expect(inBoxes({ lat: 0, lng: -179.6 }, boxes)).toBe(true)
    for (const b of boxes) {
      expect(b.minLng).toBeGreaterThanOrEqual(-180)
      expect(b.maxLng).toBeLessThanOrEqual(180)
      expect(b.minLng).toBeLessThanOrEqual(b.maxLng)
    }
  })

  it('splits the other way too (west of -180)', () => {
    const boxes = boundingBox({ lat: 0, lng: -179.9 }, 100)
    expect(boxes).toHaveLength(2)
    expect(inBoxes({ lat: 0, lng: 179.6 }, boxes)).toBe(true)
  })

  it('opens to EVERY longitude once a pole is inside the circle', () => {
    for (const centre of [{ lat: 89.5, lng: 12 }, { lat: -89.5, lng: -100 }]) {
      const boxes = boundingBox(centre, 200)
      expect(boxes).toHaveLength(1)
      expect(boxes[0]!.minLng).toBe(-180)
      expect(boxes[0]!.maxLng).toBe(180)
    }
  })

  it('a hemisphere-scale radius covers the planet rather than a clipped strip', () => {
    const boxes = boundingBox(LONDON, 25000)
    expect(boxes).toEqual([{ minLat: -90, maxLat: 90, minLng: -180, maxLng: 180 }])
  })

  it('a zero radius still contains its own centre', () => {
    expect(inBoxes(LONDON, boundingBox(LONDON, 0))).toBe(true)
  })

  it('refuses a negative radius and a non-point centre', () => {
    expect(() => boundingBox(LONDON, -1)).toThrow(RangeError)
    expect(() => boundingBox({ lat: 100, lng: 0 }, 1)).toThrow(RangeError)
  })
})

describe('coverPrefixes / prefixesForRadius', () => {
  it('every prefix is exactly `precision` characters', () => {
    for (const p of [1, 3, 6]) {
      for (const prefix of coverPrefixes(boundingBox(LONDON, 25), p)) expect(prefix).toHaveLength(p)
    }
  })

  it('coverSize agrees with the cover it predicts', () => {
    for (const centre of [LONDON, SYDNEY, { lat: 0, lng: 179.9 }, { lat: 89, lng: 0 }]) {
      for (const radius of [1, 50, 500]) {
        const boxes = boundingBox(centre, radius)
        for (const p of [2, 4, 6]) {
          // Only where the cover is small enough to enumerate — `coverSize`
          // exists precisely so the planner never has to build a cover it
          // would then throw away, and neither does this test.
          const size = coverSize(boxes, p)
          if (size > 4096) continue
          // coverSize may double-count a cell two boxes share; the cover
          // de-duplicates, so it is an upper bound, never an underestimate.
          expect(coverPrefixes(boxes, p).length).toBeLessThanOrEqual(size)
        }
      }
    }
  })

  it('picks the FINEST precision within the cell budget', () => {
    const { precision, prefixes } = prefixesForRadius(LONDON, 5, 9, 32)
    expect(prefixes.length).toBeLessThanOrEqual(32)
    expect(coverSize(boundingBox(LONDON, 5), precision + 1)).toBeGreaterThan(32)
  })

  it('a tighter radius earns a finer precision than a loose one', () => {
    const tight = prefixesForRadius(LONDON, 1, 9, 32).precision
    const loose = prefixesForRadius(LONDON, 500, 9, 32).precision
    expect(tight).toBeGreaterThan(loose)
  })

  it('never exceeds the declared precision ceiling', () => {
    expect(prefixesForRadius(LONDON, 0.001, 5, 32).precision).toBeLessThanOrEqual(5)
  })

  it('always terminates — a planet-sized radius falls back to precision 1', () => {
    const { precision, prefixes } = prefixesForRadius(LONDON, 25000, 9, 4)
    expect(precision).toBe(1)
    expect(prefixes.length).toBeLessThanOrEqual(32)
  })
})

// ─── THE SUPERSET LAW ─────────────────────────────────────────────────
//
// A prefix scheme that ever drops a true match is a CORRECTNESS bug, not a
// performance one: the haversine post-filter can only remove candidates. So
// this is the property that has to hold everywhere, not a spot check.

describe('the prefix cover is a SUPERSET of the true matches', () => {
  /** A deterministic LCG — a fixed seed makes a failure reproducible. */
  function rng(seed: number): () => number {
    let s = seed >>> 0
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0
      return s / 0x100000000
    }
  }

  const centres: ReadonlyArray<[string, GeoPoint]> = [
    ['equator', { lat: 0, lng: 0 }],
    ['london', LONDON],
    ['sydney', SYDNEY],
    ['antimeridian east', { lat: 12, lng: 179.97 }],
    ['antimeridian west', { lat: -12, lng: -179.97 }],
    ['north pole', { lat: 89.98, lng: 33 }],
    ['south pole', { lat: -89.98, lng: -140 }],
    ['prime meridian seam', { lat: 44, lng: 0.0001 }],
    ['equator seam', { lat: 0.0001, lng: 77 }],
  ]

  for (const [name, centre] of centres) {
    for (const radiusKm of [0.5, 5, 120, 2000]) {
      it(`${name} @ ${radiusKm}km — every true match is inside the cover`, () => {
        const precision = 9
        const { prefixes } = prefixesForRadius(centre, radiusKm, precision, 32)
        const next = rng(0x5eed + Math.round(radiusKm * 100) + name.length)
        let matched = 0
        for (let i = 0; i < 4000; i++) {
          // Sample AROUND the centre at up to ~3× the radius, so the ring
          // just inside the boundary — where a cover fails first — is dense.
          const bearing = next() * 2 * Math.PI
          const dist = next() * radiusKm * 3
          const point = offset(centre, dist, bearing)
          if (haversineKm(point, centre) > radiusKm) continue
          matched++
          const hash = encodeGeohash(point, precision)
          expect(
            prefixes.some(p => hash.startsWith(p)),
            `${name}: ${JSON.stringify(point)} is ${haversineKm(point, centre)}km away (radius ${radiusKm}) but no prefix of ${JSON.stringify(prefixes)} covers ${hash}`,
          ).toBe(true)
        }
        // A vacuous pass is the failure mode this guards against.
        expect(matched).toBeGreaterThan(50)
      })
    }
  }

  it('the cover of a tiny radius is genuinely SMALLER than the planet', () => {
    // The superset law is trivially satisfiable by returning [''] — so pin
    // that the cover is actually selective as well as complete.
    const { prefixes } = prefixesForRadius(LONDON, 1, 9, 32)
    expect(prefixes[0]!.length).toBeGreaterThanOrEqual(5)
    const far = encodeGeohash(SYDNEY, 9)
    expect(prefixes.some(p => far.startsWith(p))).toBe(false)
  })
})

/** Move `from` by `distKm` along `bearing` (radians) on the sphere. */
function offset(from: GeoPoint, distKm: number, bearing: number): GeoPoint {
  const R = 6371.0088
  const d = distKm / R
  const lat1 = (from.lat * Math.PI) / 180
  const lng1 = (from.lng * Math.PI) / 180
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(bearing))
  const lng2 = lng1 + Math.atan2(Math.sin(bearing) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2))
  let lng = ((lng2 * 180) / Math.PI + 540) % 360 - 180
  if (lng === -180) lng = 180
  return { lat: (lat2 * 180) / Math.PI, lng }
}
