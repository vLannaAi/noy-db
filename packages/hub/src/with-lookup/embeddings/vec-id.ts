/**
 * Collection-namespaced `_vec` side-car ids (#726).
 *
 * `_vec` embedding side-cars used to be keyed by the bare record id,
 * vault-wide — two collections sharing a record id shared one `_vec` row,
 * which let collection A's `similarTo()` surface collection B's (possibly
 * ELEVATED) embedding. The store-collection bucket stays the literal
 * `'_vec'`; the id becomes composite: `${collection}/${recordId}`. Mirrors
 * `encodeIdxId` (`../indexing/persisted-indexes.js`).
 *
 * Decode is deliberately NOT split-on-`/`: the collection is always known
 * at the decode site (`ctx.name`), so `decodeVecId` strips that known
 * prefix — correct even when `recordId` itself contains `/`.
 */

/**
 * Encode the `_vec` side-car id for a (collection, recordId) pair.
 * Format: `<collection>/<recordId>` — no escaping; `recordId` may contain `/`.
 */
export function encodeVecId(collection: string, recordId: string): string {
  return `${collection}/${recordId}`
}

/**
 * Decode a `_vec` id back to the bare record id, given the KNOWN owning
 * collection — strips the `<collection>/` prefix rather than splitting on
 * `/`, so a `recordId` containing `/` round-trips correctly. Returns `null`
 * if `vecId` does not belong to `collection`.
 */
export function decodeVecId(collection: string, vecId: string): string | null {
  const prefix = `${collection}/`
  if (!vecId.startsWith(prefix)) return null
  return vecId.slice(prefix.length)
}

/** Predicate form of {@link decodeVecId} — used to filter `list()` results. */
export function isVecIdFor(collection: string, vecId: string): boolean {
  return vecId.startsWith(`${collection}/`)
}
