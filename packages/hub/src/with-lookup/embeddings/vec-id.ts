/**
 * Collection-namespaced `_vec` side-car ids (#726).
 *
 * `_vec` embedding side-cars used to be keyed by the bare record id,
 * vault-wide — two collections sharing a record id shared one `_vec` row.
 * This was verified to be a clobber/crash bug, NOT a confidentiality leak:
 * every collection has its own DEK, and AES-GCM auth-tag verification means
 * decrypting a foreign collection's `_vec` row under the wrong DEK throws
 * `TamperedError` rather than returning wrong plaintext — no disclosure
 * mechanism exists. The real bug was id collision: a same-id write/forget in
 * one collection could clobber or delete the other collection's row, and a
 * collection whose `similarTo()` / cold semantic `retrieve()` encountered a
 * foreign same-id row crashed with an uncaught `TamperedError` (a DoS). The
 * store-collection bucket stays the literal `'_vec'`; the id becomes
 * composite: `${collection}/${recordId}`. Mirrors `encodeIdxId`
 * (`../indexing/persisted-indexes.js`).
 *
 * Decode is deliberately NOT split-on-`/`: the collection is always known
 * at the decode site (`ctx.name`), so `decodeVecId` strips that known
 * prefix — correct even when `recordId` itself contains `/`.
 *
 * Precondition: `collection` itself must not contain `/` — otherwise
 * `${collection}/${recordId}` is ambiguous (e.g. collection `'a'` would
 * misattribute collection `'a/b'`'s rows via prefix match in `isVecIdFor`).
 * Collection names are NOT currently restricted to a `/`-free charset by
 * `vault.collection()`, so `encodeVecId` enforces the precondition itself,
 * failing loud at the write boundary rather than silently misencoding.
 */

/**
 * Encode the `_vec` side-car id for a (collection, recordId) pair.
 * Format: `<collection>/<recordId>` — no escaping; `recordId` may contain `/`.
 *
 * Throws if `collection` contains `/`: that would make the composite id
 * ambiguous against `isVecIdFor`'s prefix match (collection `'a'` would
 * appear to own collection `'a/b'`'s rows), reintroducing the clobber/crash
 * risk the namespacing fix exists to close.
 */
export function encodeVecId(collection: string, recordId: string): string {
  if (collection.includes('/')) {
    throw new Error(
      `encodeVecId: collection name "${collection}" must not contain "/" — ` +
        `it would make the "${collection}/${recordId}" _vec id ambiguous against another collection's rows.`,
    )
  }
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
