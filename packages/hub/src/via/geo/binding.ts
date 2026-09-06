/**
 * The geo `NoydbVia` (#1355) — wires the geohash engine into the kernel's
 * generic Via port. `geo()` (descriptor.ts) calls {@link linkGeoVia} at
 * declaration time, the same #553 static-link pattern money/lookup/computed
 * use.
 *
 * ⭐ WHERE THE GEOHASH ACTUALLY LIVES, and why in two places:
 *
 *  - `ingest` writes it BESIDE `{ lat, lng }` in the record, so the stored
 *    document is self-describing: an export, a `crdt` merge or a consumer
 *    reading the raw shape sees the cell without re-deriving it.
 *  - `canonicalizeIndexKey` DERIVES it from `lat`/`lng` rather than reading
 *    that stored field. Deriving is what makes MIXED-ERA data land in the
 *    right bucket (money's #672 story, same shape): a record written before
 *    the field was declared `geo()` carries no `geohash` at all, and one
 *    written at a different `precision` carries the wrong-length one. Both
 *    index correctly because the coordinate — not the cached cell — is the
 *    source of truth for the key.
 *
 * The index key is therefore always a geohash STRING, so the field's
 * entries live in one key space and `startsWith` over it is a spatial
 * slice.
 */
import type { NoydbVia } from '../../kernel/via/index.js'
import { installViaBinder } from '../../kernel/via/index.js'
import type { GeoDescriptor } from './descriptor.js'
import { GeoPointError } from './descriptor.js'
import { encodeGeohash, isGeoPoint } from './geohash.js'
import { evaluateGeoClause, geoFieldClause, geoIndexProbe, type GeoWhereOperand } from './where.js'
import type { Operator } from '../../kernel/query/predicate.js'

/** The geo binder's config bag: field name → its descriptor. */
export interface GeoBindingConfig {
  readonly geoFields: Record<string, GeoDescriptor>
}

export function geoVia(geoFields: Record<string, GeoDescriptor>): NoydbVia {
  return {
    brand: 'geo',
    // A coordinate is ordinary envelope-encrypted content; the ORDERED
    // posture is what the geohash key earns — a prefix slice is a range
    // answer, never a plaintext coordinate the store can read.
    posture: { encryptedAtRest: 'envelope', queryable: 'ordered', exportable: true, forgettable: true },
    covers: (field) => field in geoFields,
    coveredFields: Object.keys(geoFields), // #1447
    ingest: (record) => {
      let out = record
      for (const [field, desc] of Object.entries(geoFields)) {
        const value = record[field]
        if (value === null || value === undefined) continue
        if (!isGeoPoint(value)) throw new GeoPointError(field, value)
        const geohash = encodeGeohash(value, desc.precision)
        if (out === record) out = { ...record }
        // Spread FIRST so any sibling key on the point (a label, an altitude)
        // survives, and the derived cell always wins over a stale stored one.
        out[field] = { ...(value as unknown as Record<string, unknown>), geohash }
      }
      return out
    },
    // Claims EVERY operator on a covered field, not just `near` — see the
    // header of `where.ts` for why an unclaimed operator on a field whose
    // index key is rewritten is a soundness hole rather than a gap.
    buildClause: (field, op, value) => {
      const desc = geoFields[field]
      if (!desc) return undefined
      return geoFieldClause(field, op as Operator, value, desc)
    },
    evaluateClause: (actual, op, payload) => evaluateGeoClause(actual, op, payload as GeoWhereOperand),
    indexProbe: (op, payload) => geoIndexProbe(op, payload as GeoWhereOperand),
    canonicalizeIndexKey: (field, rawValue) => {
      const desc = geoFields[field]
      if (!desc || !isGeoPoint(rawValue)) return undefined
      return encodeGeohash(rawValue, desc.precision)
    },
    describeFragment: () => ({
      geo: Object.fromEntries(
        Object.entries(geoFields).map(([field, d]) => [field, { precision: d.precision, maxPrefixes: d.maxPrefixes }]),
      ),
    }),
  }
}

export function linkGeoVia(): void {
  installViaBinder('geo', (cfg) => geoVia((cfg as GeoBindingConfig).geoFields))
}
