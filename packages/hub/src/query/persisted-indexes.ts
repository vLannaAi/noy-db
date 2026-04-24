/**
 * Persistent, encrypted secondary indexes for lazy-mode collections (v0.22).
 *
 * Parallel to the in-memory `CollectionIndexes` used by eager mode (see
 * `packages/hub/src/query/indexes.ts`): same logical surface, but entries
 * are materialised as encrypted side-car records (`_idx/<field>/<recordId>`)
 * and bulk-loaded into an in-memory mirror on first query.
 *
 * This module only owns the id-namespace convention, the in-memory mirror,
 * and the typed errors. Write-path integration (PR 2 / #266), query-planner
 * dispatch (PR 3 / #267, PR 4 / #268), and the rebuild/reconcile utilities
 * (PR 5 / #269) live in other files.
 *
 * See the v0.22 design spec for the full architecture + threat model.
 */

/**
 * Reserved id prefix for encrypted index side-car records.
 * Matches the existing `_keyring`, `_ledger_deltas/…`, `_meta/handle`
 * conventions inside a collection's id namespace.
 */
export const IDX_PREFIX = '_idx/' as const

/**
 * Encode the side-car record id for a (field, recordId) pair.
 *
 * Format: `_idx/<field>/<recordId>` — no escaping. Field names may contain
 * dots (for dotted-path access consistent with eager-mode `readPath`);
 * record ids may contain slashes. The first two slash-separated segments
 * are `_idx` and the field; everything after the *second* slash is the
 * record id verbatim.
 */
export function encodeIdxId(field: string, recordId: string): string {
  return `${IDX_PREFIX}${field}/${recordId}`
}

/**
 * Decode a side-car id back into `{ field, recordId }`, or `null` if the
 * input is not a well-formed idx id. A well-formed id is:
 *   - prefixed with `_idx/`
 *   - contains a field segment (non-empty, no slashes)
 *   - contains a record-id segment (non-empty, may contain slashes)
 */
export function decodeIdxId(id: string): { field: string; recordId: string } | null {
  if (!id.startsWith(IDX_PREFIX)) return null
  const rest = id.slice(IDX_PREFIX.length)
  const firstSlash = rest.indexOf('/')
  if (firstSlash <= 0) return null
  const field = rest.slice(0, firstSlash)
  const recordId = rest.slice(firstSlash + 1)
  if (recordId.length === 0) return null
  return { field, recordId }
}

/**
 * Fast-path predicate for discriminating side-car ids from regular record
 * ids and other reserved namespaces. Used by the hub to filter `list()`
 * results during bulk-load of the in-memory mirror.
 */
export function isIdxId(id: string): boolean {
  return decodeIdxId(id) !== null
}
