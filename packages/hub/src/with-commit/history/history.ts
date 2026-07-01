import type { NoydbStore, EncryptedEnvelope, HistoryOptions, PruneOptions } from '../../kernel/types.js'
import { NOYDB_FORMAT_VERSION } from '../../kernel/types.js'

/**
 * History storage convention:
 * Collection: `_history`
 * ID format: `{collection}:{recordId}:{paddedVersion}`
 * Version is zero-padded to 10 digits for lexicographic sorting.
 */

const HISTORY_COLLECTION = '_history'
const VERSION_PAD = 10

function historyId(collection: string, recordId: string, version: number): string {
  return `${collection}:${recordId}:${String(version).padStart(VERSION_PAD, '0')}`
}

// Unused today, kept for future history-id parsing utilities.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function parseHistoryId(id: string): { collection: string; recordId: string; version: number } | null {
  const lastColon = id.lastIndexOf(':')
  if (lastColon < 0) return null
  const versionStr = id.slice(lastColon + 1)
  const rest = id.slice(0, lastColon)
  const firstColon = rest.indexOf(':')
  if (firstColon < 0) return null
  return {
    collection: rest.slice(0, firstColon),
    recordId: rest.slice(firstColon + 1),
    version: parseInt(versionStr, 10),
  }
}

function matchesPrefix(id: string, collection: string, recordId?: string): boolean {
  if (recordId) {
    return id.startsWith(`${collection}:${recordId}:`)
  }
  return id.startsWith(`${collection}:`)
}

/** Save a history entry (a complete encrypted envelope snapshot). */
export async function saveHistory(
  adapter: NoydbStore,
  vault: string,
  collection: string,
  recordId: string,
  envelope: EncryptedEnvelope,
): Promise<void> {
  const id = historyId(collection, recordId, envelope._v)
  await adapter.put(vault, HISTORY_COLLECTION, id, envelope)
}

/** Get history entries for a record, sorted newest-first. */
export async function getHistory(
  adapter: NoydbStore,
  vault: string,
  collection: string,
  recordId: string,
  options?: HistoryOptions,
): Promise<EncryptedEnvelope[]> {
  const allIds = await adapter.list(vault, HISTORY_COLLECTION)
  const matchingIds = allIds
    .filter(id => matchesPrefix(id, collection, recordId))
    .sort()
    .reverse() // newest first

  const entries: EncryptedEnvelope[] = []

  for (const id of matchingIds) {
    const envelope = await adapter.get(vault, HISTORY_COLLECTION, id)
    if (!envelope) continue

    // Apply time filters
    if (options?.from && envelope._ts < options.from) continue
    if (options?.to && envelope._ts > options.to) continue

    entries.push(envelope)

    if (options?.limit && entries.length >= options.limit) break
  }

  return entries
}

/** Get a specific version's envelope from history. */
export async function getVersionEnvelope(
  adapter: NoydbStore,
  vault: string,
  collection: string,
  recordId: string,
  version: number,
): Promise<EncryptedEnvelope | null> {
  const id = historyId(collection, recordId, version)
  return adapter.get(vault, HISTORY_COLLECTION, id)
}

/** Prune history entries. Returns the number of entries deleted. */
export async function pruneHistory(
  adapter: NoydbStore,
  vault: string,
  collection: string,
  recordId: string | undefined,
  options: PruneOptions,
): Promise<number> {
  const allIds = await adapter.list(vault, HISTORY_COLLECTION)
  const matchingIds = allIds
    .filter(id => recordId ? matchesPrefix(id, collection, recordId) : matchesPrefix(id, collection))
    .sort()

  let toDelete: string[] = []

  if (options.keepVersions !== undefined) {
    // Keep only the N most recent, delete the rest
    const keep = options.keepVersions
    if (matchingIds.length > keep) {
      toDelete = matchingIds.slice(0, matchingIds.length - keep)
    }
  }

  if (options.beforeDate) {
    // Delete entries older than the specified date
    for (const id of matchingIds) {
      if (toDelete.includes(id)) continue
      const envelope = await adapter.get(vault, HISTORY_COLLECTION, id)
      if (envelope && envelope._ts < options.beforeDate) {
        toDelete.push(id)
      }
    }
  }

  // Deduplicate
  const uniqueDeletes = [...new Set(toDelete)]

  for (const id of uniqueDeletes) {
    await adapter.delete(vault, HISTORY_COLLECTION, id)
  }

  return uniqueDeletes.length
}

/** Clear all history for a vault, optionally scoped to a collection or record. */
export async function clearHistory(
  adapter: NoydbStore,
  vault: string,
  collection?: string,
  recordId?: string,
): Promise<number> {
  const allIds = await adapter.list(vault, HISTORY_COLLECTION)
  let toDelete: string[]

  if (collection && recordId) {
    toDelete = allIds.filter(id => matchesPrefix(id, collection, recordId))
  } else if (collection) {
    toDelete = allIds.filter(id => matchesPrefix(id, collection))
  } else {
    toDelete = allIds
  }

  for (const id of toDelete) {
    await adapter.delete(vault, HISTORY_COLLECTION, id)
  }

  return toDelete.length
}

/**
 * Crypto-shred every `_history` version of a record (#304). Each non-tombstone
 * history envelope is OVERWRITTEN in place with a tombstone
 * `{ _noydb, _v, _ts: now, _by: actor, _iv: '', _data: '' }` — dropping
 * `_iv`/`_data`/`_cek`/`_det`, so the prior ciphertext (and the wrapped CEK
 * that could decrypt it) is gone everywhere this store reaches. The version
 * counter (`_v`) is preserved so the audit trail still shows "N versions
 * existed and were erased."
 *
 * Overwrite — NOT delete — so the history key itself survives as proof the
 * version existed. Already-tombstoned versions (re-run / idempotent forget)
 * are left untouched and not counted.
 *
 * Returns the number of history versions newly tombstoned.
 */
export async function tombstoneHistory(
  adapter: NoydbStore,
  vault: string,
  collection: string,
  recordId: string,
  actor: string,
): Promise<number> {
  const allIds = await adapter.list(vault, HISTORY_COLLECTION)
  const matchingIds = allIds.filter(id => matchesPrefix(id, collection, recordId))

  const now = new Date().toISOString()
  let count = 0
  for (const id of matchingIds) {
    const env = await adapter.get(vault, HISTORY_COLLECTION, id)
    if (!env) continue
    // Already a tombstone (no body and no wrapped CEK)? Skip — idempotent.
    if (!env._data && env._cek === undefined) continue
    const tombstone: EncryptedEnvelope = {
      _noydb: NOYDB_FORMAT_VERSION,
      _v: env._v,
      _ts: now,
      _iv: '',
      _data: '',
      ...(actor ? { _by: actor } : {}),
    }
    await adapter.put(vault, HISTORY_COLLECTION, id, tombstone)
    count++
  }
  return count
}
