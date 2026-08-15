import { buildRecordEnvelope } from '../../kernel/enclave/index.js'
import type { RecordIdentity } from '../../kernel/enclave/index.js'
import type { NoydbStore, EncryptedEnvelope, HistoryOptions, PruneOptions } from '../../kernel/types.js'
import { isTombstone, isTombstoneShape, rewrapEnvelope, isRewrappedUnder, type EnclaveKey } from '../../kernel/enclave/index.js'

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

/**
 * The identity a history snapshot is **sealed against** — its STORAGE location,
 * not the live record it is a copy of (#1041).
 *
 * ## Why storage, and why this is a decision rather than a detail
 *
 * A snapshot is a copy, so two identities are available: the live record
 * (`collection`/`recordId`) or where the bytes actually land
 * (`_history`/`historyId(...)`). They are not equivalent under attack.
 *
 * Binding the LIVE identity makes a snapshot's AAD **indistinguishable from the
 * live record's at the same version** — so an untrusted store could serve a
 * history entry *as the current record* and the client would accept it. It also
 * leaves entries relocatable within `_history`.
 *
 * Binding STORAGE identity closes both. The cost is that the id must be known
 * *before* the envelope is sealed, where `saveHistory` previously derived it
 * *after* (from `envelope._v`) — which is precisely the restructure this
 * function exists to make possible.
 *
 * `saveHistory` uses this too, so the sealed identity and the put location have
 * **one definition** and cannot drift apart. Changing the layout here changes
 * both at once, by construction.
 */
export function historyIdentity(collection: string, recordId: string, version: number): RecordIdentity {
  return { collection: HISTORY_COLLECTION, id: historyId(collection, recordId, version) }
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
  // Same derivation the caller sealed against — one definition, so the sealed
  // identity and the put location cannot drift (#1041).
  const { id } = historyIdentity(collection, recordId, envelope._v)
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
 * Crypto-shred every `_history` version of a record. Each non-tombstone
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
  encrypted: boolean,
): Promise<number> {
  const allIds = await adapter.list(vault, HISTORY_COLLECTION)
  const matchingIds = allIds.filter(id => matchesPrefix(id, collection, recordId))

  const now = new Date().toISOString()
  let count = 0
  for (const id of matchingIds) {
    const env = await adapter.get(vault, HISTORY_COLLECTION, id)
    if (!env) continue
    // Already a tombstone (no body and no wrapped CEK)? Skip — idempotent.
    if (isTombstone(env, encrypted)) continue
    // `by` rides on the IDENTITY — passing it in the body went through a
    // conditional spread, which TypeScript does not excess-property-check, so
    // it was silently dropped once `_by` moved to the identity (#1041).
    const tombstone: EncryptedEnvelope = buildRecordEnvelope(
      { collection: HISTORY_COLLECTION, id, ...(actor ? { by: actor } : {}) },
      { version: env._v, ts: now, iv: '', data: '' },
    )
    await adapter.put(vault, HISTORY_COLLECTION, id, tombstone)
    count++
  }
  return count
}

/**
 * Re-key every `_history` snapshot of a record from `fromDek` to `toDek`.
 * Mirrors what `rewrapBodyToDek` already does for a record's LIVE body on a
 * tier move (elevate/demote/putAtTier) — each `_history` envelope also
 * carries its own `_cek`, wrapped under the collection's tier-0 DEK at write
 * time (`record-codec.ts`), so a tier move that rewraps only the live
 * envelope leaves prior versions decryptable at rest under the tier the
 * record left. This is defense-in-depth *beneath* the read-gate
 * (`history()`/`getVersion()` already return empty for an elevated record;
 * this protects the ciphertext even if that gate is bypassed).
 *
 * Rewraps content in place — unlike `tombstoneHistory`, it does NOT blank
 * `_iv`/`_data`/`_cek` — so a subsequent `demote()` restores tier-0
 * readability. Tombstone-shaped entries (a forgotten/shredded version —
 * blanked `_data`, no `_cek`) are skipped: there is no key material left to
 * rewrap.
 *
 * **Legacy fallback.** A snapshot written before this fix stays wrapped
 * under the tier-0 DEK even after its live record has since moved tiers, so
 * a rewrap attempted with a tier-N `fromDek` fails to unwrap/decrypt. When
 * the caller supplies `tier0Dek`, a failed rewrap is retried once with
 * `tier0Dek` as `fromDek` (the only other key a pre-fix snapshot can be
 * wrapped under — history is written only by tier-0 `put()`). The output is
 * always wrapped under `toDek` regardless of which `fromDek` succeeded. A
 * rewrap that fails under BOTH keys re-throws — that is real corruption, not
 * a tier mismatch, and must not be swallowed.
 *
 * **Crash-atomicity / idempotency (#712 whole-branch-fix-3).** This loop has
 * no transaction around it: a crash after some entries have been rewritten
 * under `toDek` but before the loop finishes leaves the record's history
 * split across two keys. A retry of the SAME call must not re-fail on the
 * entries that already made it — so each entry is probed with
 * `isRewrappedUnder(env, toDek)` FIRST; a match means it's already at the
 * target key and is skipped (put nothing). This makes same-target retries
 * and demote-after-crash fully self-healing. It does NOT close every crash
 * window: a crash that lands SOME entries under `toDek` while the record's
 * NEXT move target differs from this call's `toDek` (an intermediate-tier
 * crash — e.g. elevate 0→1 crashes mid-loop, then the record is moved 1→2)
 * still finds those entries unreadable under either `fromDek` or the
 * tier-0 fallback, since `toDek` is a third key the next call never probes
 * for. That residual window is an accepted, fail-closed limitation (see
 * `.changeset/history-at-rest.md` and the design doc) — availability is
 * lost, never confidentiality.
 */
export async function rewrapHistory(
  adapter: NoydbStore,
  vault: string,
  collection: string,
  recordId: string,
  fromDek: EnclaveKey,
  toDek: EnclaveKey,
  tier0Dek?: EnclaveKey,
): Promise<void> {
  const allIds = await adapter.list(vault, HISTORY_COLLECTION)
  const matchingIds = allIds.filter(id => matchesPrefix(id, collection, recordId))

  for (const id of matchingIds) {
    const env = await adapter.get(vault, HISTORY_COLLECTION, id)
    if (!env) continue
    // Already a tombstone (forgotten/shredded version)? Nothing to rewrap.
    if (isTombstoneShape(env)) continue
    // #712/whole-branch-fix-3: toDek-first idempotency skip — already at the
    // target key (a same-target retry, or demote-after-crash landing back on
    // a key it already reached)? Nothing to do; put nothing.
    // In-place re-key of a `_history` entry: the address does not move, so the
    // same identity opens and re-seals it (#1041). Built from the entry itself,
    // exactly as a reader would via `recordAadFor`.
    const identity = {
      collection: HISTORY_COLLECTION, id,
      ...(env._tier !== undefined ? { tier: env._tier } : {}),
      ...(env._by !== undefined ? { by: env._by } : {}),
    }
    if (await isRewrappedUnder(identity, env, toDek)) continue

    let next: EncryptedEnvelope
    try {
      next = await rewrapEnvelope(identity, env, fromDek, toDek)
    } catch (err) {
      if (!tier0Dek) throw err
      // Legacy fallback: retry once under the tier-0 DEK. A failure here is
      // real corruption, not a tier mismatch — let it propagate.
      next = await rewrapEnvelope(identity, env, tier0Dek, toDek)
    }

    await adapter.put(vault, HISTORY_COLLECTION, id, next)
  }
}
