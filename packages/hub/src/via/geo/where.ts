/**
 * `where(field, 'near', { lat, lng, radiusKm })` — the geo binding's query
 * participation (#1355).
 *
 * Two halves, and the split is the whole design:
 *
 *  - {@link geoFieldClause} turns a `near` operand into a PREFIX COVER at build
 *    time, once. `geoIndexProbe` hands that cover to the sorted index as a
 *    union of `startsWith` slices — a candidate SUPERSET.
 *  - {@link evaluateGeoClause} is the exact answer: one haversine per
 *    candidate. It runs on every record the executor offers it, index or
 *    scan, so the query returns the same rows either way.
 *
 * ⛔ The `near` clause is NEVER consumed by the index — `candidateRecords()`
 * (`kernel/query/builder.ts`) keeps a prefix-probed clause in
 * `remainingClauses` precisely because a cell cover is round and a circle
 * is not. Dropping it would return the bounding cells' corners as matches.
 *
 * ⭐⭐ AND THE BINDING CLAIMS EVERY OTHER OPERATOR TOO, delegating them
 * straight back to the kernel's generic comparison. That looks like
 * ceremony and is not: a geo field's INDEX KEY is a geohash string
 * (`canonicalizeIndexKey`), while its STORED value is an object. Leaving,
 * say, `startsWith` unclaimed would leave `clause.via` unset, which is
 * exactly the signal `candidateRecords()` reads as "the sorted index may
 * serve this" — and the index would answer over geohash strings while the
 * scan compares an object, so the two would disagree about the same query.
 * Claiming the operator sets `clause.via` with NO index probe, which sends
 * it to the scan and keeps one answer.
 */
import { ValidationError } from '../../kernel/errors.js'
import { evaluateOperator, type Operator } from '../../kernel/query/predicate.js'
import type { ViaPrefixProbe } from '../../kernel/via/index.js'
import type { GeoDescriptor } from './descriptor.js'
import { haversineKm, isGeoPoint, prefixesForRadius, type GeoPoint } from './geohash.js'

/** The `near` operand: a centre and a radius in kilometres. */
export interface NearOperand extends GeoPoint {
  readonly radiusKm: number
}

/** A `near` clause: the centre, the radius, and the cover the index probes. */
export interface GeoNearOperand {
  readonly kind: 'near'
  readonly center: GeoPoint
  readonly radiusKm: number
  readonly prefixes: readonly string[]
  /** Cover precision actually chosen — reported by `describeFragment()`, not used to match. */
  readonly precision: number
}

/** Any other operator over a geo field: claimed, un-probed, generically compared. */
export interface GeoPassthroughOperand {
  readonly kind: 'passthrough'
  readonly value: unknown
}

/** The opaque payload `buildClause` produces and `evaluateClause` consumes. */
export type GeoWhereOperand = GeoNearOperand | GeoPassthroughOperand

/**
 * Build the payload for a clause over a geo field. A `near` operand is
 * validated and covered here; every other operator is captured verbatim.
 *
 * A malformed `near` operand throws at the `where()` CALL SITE (money's
 * precedent) — a silently-empty result set is the worst possible answer to
 * a typo'd coordinate.
 */
export function geoFieldClause(field: string, op: Operator, value: unknown, desc: GeoDescriptor): GeoWhereOperand {
  if (op !== 'near') return { kind: 'passthrough', value }
  if (typeof value !== 'object' || value === null) {
    throw new ValidationError(`where("${field}", 'near', …): operand must be { lat, lng, radiusKm }, got ${JSON.stringify(value)}`)
  }
  const { lat, lng, radiusKm } = value as { lat?: unknown; lng?: unknown; radiusKm?: unknown }
  const center = { lat, lng } as GeoPoint
  if (!isGeoPoint(center)) {
    throw new ValidationError(`where("${field}", 'near', …): lat must be in [-90, 90] and lng in [-180, 180], got ${JSON.stringify({ lat, lng })}`)
  }
  if (typeof radiusKm !== 'number' || !Number.isFinite(radiusKm) || radiusKm < 0) {
    throw new ValidationError(`where("${field}", 'near', …): radiusKm must be a non-negative number, got ${JSON.stringify(radiusKm)}`)
  }
  const { prefixes, precision } = prefixesForRadius(center, radiusKm, desc.precision, desc.maxPrefixes)
  return { kind: 'near', center, radiusKm, prefixes, precision }
}

/**
 * Exact membership: the stored point is within `radiusKm` of the centre.
 *
 * A value that is not a point — absent, nullish, or written before the
 * field was declared `geo()` — matches nothing. That is the same posture
 * every other operator takes on a type mismatch, and it is what keeps the
 * index sound: such a record has no geohash key either, so it is absent
 * from the candidate set AND from the answer.
 */
export function evaluateGeoClause(actual: unknown, op: string, payload: GeoWhereOperand): boolean {
  if (payload.kind === 'passthrough') return evaluateOperator(actual, op as Operator, payload.value)
  if (op !== 'near') return false
  if (!isGeoPoint(actual)) return false
  return haversineKm(actual, payload.center) <= payload.radiusKm
}

/**
 * The index operand: a prefix cover the sorted index can slice.
 *
 * `undefined` for any other operator, which sends the clause to the scan
 * — the geo binding claims no fast path it cannot make sound.
 */
export function geoIndexProbe(op: string, payload: GeoWhereOperand): ViaPrefixProbe | undefined {
  if (op !== 'near' || payload.kind !== 'near') return undefined
  if (payload.prefixes.length === 0) return undefined
  return { kind: 'via-prefixes', prefixes: payload.prefixes }
}
