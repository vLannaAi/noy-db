/**
 * CRDT state types, merge logic, and build helpers.
 * v0.9 #132 — per-collection CRDT mode: 'lww-map' | 'rga' | 'yjs'
 *
 * The encrypted envelope wraps the CRDT state (not the resolved snapshot).
 * Adapters only ever see ciphertext. `collection.get(id)` returns the
 * resolved snapshot; `collection.getRaw(id)` returns the full CRDT state.
 */

// ─── Mode ─────────────────────────────────────────────────────────────

/** Per-collection CRDT mode (v0.9 #132). */
export type CrdtMode = 'lww-map' | 'rga' | 'yjs'

// ─── State shapes ─────────────────────────────────────────────────────

/**
 * Per-field last-write-wins registers.
 * Each field carries its latest value and the ISO timestamp of the last write.
 * Merge: for each field, keep the entry with the lexicographically higher `ts`.
 */
export interface LwwMapState {
  readonly _crdt: 'lww-map'
  readonly fields: Record<string, { readonly v: unknown; readonly ts: string }>
}

/**
 * Simplified Replicated Growable Array.
 * Items are assigned stable NID (noy-db id) strings on first insertion.
 * Deleted items are tracked as tombstones so concurrent removals commute.
 *
 * The resolved snapshot is the ordered list of non-tombstoned `v` values.
 */
export interface RgaState {
  readonly _crdt: 'rga'
  readonly items: ReadonlyArray<{ readonly nid: string; readonly v: unknown }>
  readonly tombstones: readonly string[]
}

/**
 * Yjs binary state marker. `update` is base64(Y.encodeStateAsUpdate()).
 * Core stores and retrieves the blob opaquely. `@noy-db/yjs` is responsible
 * for encoding, decoding, and merging via `Y.mergeUpdates`.
 * Core falls back to last-write-wins (higher `_v`) for conflict resolution.
 */
export interface YjsState {
  readonly _crdt: 'yjs'
  /** base64-encoded Y.encodeStateAsUpdate() bytes. */
  readonly update: string
}

export type CrdtState = LwwMapState | RgaState | YjsState

// ─── Snapshot resolution ──────────────────────────────────────────────

/**
 * Resolve a CRDT state into the end-user record snapshot.
 *
 * - `lww-map` → `Record<string, unknown>` (field values extracted from registers)
 * - `rga`     → `unknown[]` (non-tombstoned items in insertion order)
 * - `yjs`     → `string` (base64 update blob; use @noy-db/yjs for a Y.Doc)
 */
export function resolveCrdtSnapshot(state: CrdtState): unknown {
  switch (state._crdt) {
    case 'lww-map': {
      const result: Record<string, unknown> = {}
      for (const [field, reg] of Object.entries(state.fields)) {
        result[field] = reg.v
      }
      return result
    }
    case 'rga': {
      const dead = new Set(state.tombstones)
      return state.items.filter(i => !dead.has(i.nid)).map(i => i.v)
    }
    case 'yjs':
      return state.update
  }
}

// ─── CRDT merge ───────────────────────────────────────────────────────

/**
 * Merge two CRDT states produced by concurrent writes.
 * Called by the collection-level conflict resolver registered with SyncEngine.
 *
 * For `yjs`: core cannot merge Yjs without importing the `yjs` package.
 * The caller must handle that case by falling back to the higher-`_v` envelope.
 */
export function mergeCrdtStates(a: CrdtState, b: CrdtState): CrdtState {
  // Mismatched modes shouldn't happen in practice — same collection, same schema.
  if (a._crdt !== b._crdt) return a

  switch (a._crdt) {
    case 'lww-map':
      return mergeLwwMap(a, b as LwwMapState)
    case 'rga':
      return mergeRga(a, b as RgaState)
    case 'yjs':
      // Signal to caller that Yjs merge is needed externally
      return a
  }
}

function mergeLwwMap(a: LwwMapState, b: LwwMapState): LwwMapState {
  const merged: Record<string, { v: unknown; ts: string }> = {}
  const allFields = new Set([...Object.keys(a.fields), ...Object.keys(b.fields)])
  for (const field of allFields) {
    const fa = a.fields[field]
    const fb = b.fields[field]
    if (!fa) { merged[field] = fb! }
    else if (!fb) { merged[field] = fa }
    else { merged[field] = fa.ts >= fb.ts ? fa : fb }
  }
  return { _crdt: 'lww-map', fields: merged }
}

function mergeRga(a: RgaState, b: RgaState): RgaState {
  // Union tombstones from both sides
  const allTombstones = new Set([...a.tombstones, ...b.tombstones])
  // Union items by nid: start with a's ordering, append b-only items
  const seenNids = new Set(a.items.map(i => i.nid))
  const merged: Array<{ nid: string; v: unknown }> = [
    ...a.items,
    ...b.items.filter(i => !seenNids.has(i.nid)),
  ]
  return { _crdt: 'rga', items: merged, tombstones: [...allTombstones] }
}

// ─── Build helpers ────────────────────────────────────────────────────

/**
 * Build (or update) an lww-map state from a new record.
 *
 * All fields in the new record win at timestamp `now`.
 * Fields present in the existing state but absent from the new record
 * are preserved (they were written by another device).
 */
export function buildLwwMapState(
  record: Record<string, unknown>,
  existing: LwwMapState | undefined,
  now: string,
): LwwMapState {
  const fields: Record<string, { v: unknown; ts: string }> = {}

  // New record fields all get the current timestamp — this device wins for these
  for (const [field, value] of Object.entries(record)) {
    fields[field] = { v: value, ts: now }
  }

  // Preserve fields from the existing state that aren't in the new record
  if (existing) {
    for (const [field, reg] of Object.entries(existing.fields)) {
      if (!(field in fields)) {
        fields[field] = reg
      }
    }
  }

  return { _crdt: 'lww-map', fields }
}

/**
 * Build (or update) an RGA state from a new array.
 *
 * Existing items are matched to new elements by deep-equality of their `v`.
 * Unmatched existing items are tombstoned. New elements that have no existing
 * match get a fresh NID via `generateNid()`.
 */
export function buildRgaState(
  arr: unknown[],
  existing: RgaState | undefined,
  generateNid: () => string,
): RgaState {
  // Build an index from JSON(v) → existing item so we can match by value
  const existingByValue = new Map<string, { nid: string; v: unknown }>()
  if (existing) {
    for (const item of existing.items) {
      // Only add first occurrence per value to avoid double-matching
      const key = JSON.stringify(item.v)
      if (!existingByValue.has(key)) existingByValue.set(key, item)
    }
  }

  const usedNids = new Set<string>()
  const newItems: Array<{ nid: string; v: unknown }> = []

  for (const el of arr) {
    const key = JSON.stringify(el)
    const match = existingByValue.get(key)
    if (match && !usedNids.has(match.nid)) {
      // Reuse existing NID to preserve cross-device identity
      newItems.push(match)
      usedNids.add(match.nid)
    } else {
      // New element — assign a fresh NID
      const nid = generateNid()
      newItems.push({ nid, v: el })
      usedNids.add(nid)
    }
  }

  // Elements in the existing state that aren't in the new array → tombstone.
  // Tombstoned items are kept in the items array to preserve ordering for
  // cross-device merge — the resolved snapshot filters them out.
  const tombstones: string[] = existing ? [...existing.tombstones] : []
  const extraItems: Array<{ nid: string; v: unknown }> = []
  if (existing) {
    for (const item of existing.items) {
      if (!usedNids.has(item.nid)) {
        if (!tombstones.includes(item.nid)) tombstones.push(item.nid)
        extraItems.push(item) // retain in items for ordering
      }
    }
  }

  // Final items: live items in new order, then tombstoned extras at the end
  const items = [...newItems, ...extraItems]

  return { _crdt: 'rga', items, tombstones }
}
