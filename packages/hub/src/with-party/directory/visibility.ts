/**
 * Persistence helpers for the per-user visibility flag
 * (`_meta/visibility/<keyringId>`). Mirrors the bypass-AES pattern used
 * by `_meta/policy` — the visibility document is plain JSON, the
 * envelope's `_iv` field is left empty.
 *
 * Stored alongside the keyring file rather than inside the encrypted
 * user envelope (`_users/<keyringId>`) because:
 *
 *  - `UserEnvelope<T>.data` is opaque-to-hub by contract — hub does not
 *    introspect or reserve any keys inside it. Adding `hidden` there
 *    would violate that contract.
 *  - `listUsersWithEnvelopes` filters by the flag, and the filter must
 *    work even when decryption fails (legacy keyrings predating the
 *    envelope feature, or a corrupted envelope).
 *
 * @see docs/subsystems/user-envelope.md → Directory visibility
 * @see docs/subsystems/plaintext-bypass.md — every `_iv: ''` write site
 *
 * @module
 */
import type { NoydbStore, EncryptedEnvelope } from '../../types.js'
import { NOYDB_FORMAT_VERSION } from '../../types.js'
import type { UserVisibility } from './types.js'
import { META_COLLECTION } from './storage.js'

/** Prefix for per-user visibility records inside `_meta`. */
export const VISIBILITY_RECORD_PREFIX = 'visibility/'

/** Compose the `_meta` record id for a keyring's visibility doc. */
export function visibilityRecordId(keyringId: string): string {
  return VISIBILITY_RECORD_PREFIX + keyringId
}

/**
 * Read the visibility flag for `keyringId`. Returns `undefined` when no
 * document has been persisted — callers treat that as the default-visible
 * case (`{ hidden: false }`).
 */
export async function readUserVisibility(
  store: NoydbStore,
  vault: string,
  keyringId: string,
): Promise<UserVisibility | undefined> {
  const envelope = await store.get(vault, META_COLLECTION, visibilityRecordId(keyringId))
  if (!envelope) return undefined
  try {
    const parsed = JSON.parse(envelope._data) as unknown
    if (!isUserVisibility(parsed)) return undefined
    return parsed
  } catch {
    return undefined
  }
}

/**
 * Persist the visibility flag for `keyringId` at
 * `_meta/visibility/<keyringId>`. Idempotent — call on every
 * `vault.user.setMyVisibility()` invocation. Own-only at the caller
 * site; this primitive does not enforce keyring ownership.
 */
export async function persistUserVisibility(
  store: NoydbStore,
  vault: string,
  keyringId: string,
  visibility: UserVisibility,
): Promise<void> {
  const envelope: EncryptedEnvelope = {
    _noydb: NOYDB_FORMAT_VERSION,
    _v: 1,
    _ts: new Date().toISOString(),
    _iv: '',
    _data: JSON.stringify({ hidden: visibility.hidden }),
  }
  await store.put(vault, META_COLLECTION, visibilityRecordId(keyringId), envelope)
}

/**
 * Delete the visibility flag for `keyringId`. Called from `revoke()`
 * alongside `deleteUserEnvelope` so the sidecar does not leak to a
 * re-granted principal with the same `userId`. Idempotent — the store's
 * `delete()` is already a no-op when the record is absent.
 */
export async function deleteUserVisibility(
  store: NoydbStore,
  vault: string,
  keyringId: string,
): Promise<void> {
  await store.delete(vault, META_COLLECTION, visibilityRecordId(keyringId))
}

function isUserVisibility(x: unknown): x is UserVisibility {
  if (x === null || typeof x !== 'object') return false
  if (!('hidden' in x)) return false
  return typeof (x as { hidden: unknown }).hidden === 'boolean'
}
