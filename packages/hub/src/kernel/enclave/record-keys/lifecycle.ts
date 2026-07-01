/**
 * Per-record CEK lifecycle helpers for the WRITE path (#356 foundation).
 *
 * These are the collection-coupled CEK operations, lifted off `Collection`
 * behind narrow deps so the kernel file delegates instead of carrying the
 * crypto inline:
 *
 *   - {@link resolveStableCek} — the stable-CEK rule: an update or history
 *     snapshot reuses the record's existing CEK so a single CEK delete kills
 *     the whole version chain; a genuine insert (or legacy record being
 *     migrated) mints a fresh one.
 *   - {@link rewrapBodyToDek} — move a record body's wrapping from one DEK to
 *     another (tier elevate/demote, bundle re-key) WITHOUT changing the body
 *     key: unwrap the CEK under the source DEK, re-encrypt the body under the
 *     same CEK, re-wrap the CEK under the destination DEK. History-chain
 *     identity is preserved because the body key never changes.
 *
 * Both are pure functions over their deps — the `cekCache` ownership stays on
 * the collection (its lifetime is tied to `load()`), so callers cache the
 * returned key themselves.
 */
import { encrypt, decrypt, generateDEK, wrapCek, unwrapCek } from '../crypto.js'
import type { EncryptedEnvelope } from '../../../types.js'
import type { Lru } from '../../cache/index.js'

/** Dependencies {@link resolveStableCek} needs from its collection. */
export interface StableCekDeps {
  /** The collection's per-record CEK cache (`null` → no caching). */
  readonly cache: Lru<string, CryptoKey> | null
  /** Read the record's live envelope (to recover an existing `_cek`). */
  getLive(id: string): Promise<EncryptedEnvelope | null>
  /** The DEK the CEK is wrapped under (the collection DEK on the normal path). */
  getDEK(): Promise<CryptoKey>
}

/**
 * Resolve the stable CEK for a record on the write path. Caches the resolved
 * key under `id` so an update + its history snapshot share one CEK.
 */
export async function resolveStableCek(deps: StableCekDeps, id: string): Promise<CryptoKey> {
  const cached = deps.cache?.get(id)
  if (cached) return cached

  const live = await deps.getLive(id)
  if (live?._cek !== undefined) {
    const cek = await unwrapCek(live._cek, await deps.getDEK())
    deps.cache?.set(id, cek, 1)
    return cek
  }

  const fresh = await generateDEK()
  deps.cache?.set(id, fresh, 1)
  return fresh
}

/** Re-wrapped body bytes + the (optional) CEK to cache. */
export interface RewrappedBody {
  readonly _iv: string
  readonly _data: string
  /** Present iff the source envelope carried a CEK (per-record-key record). */
  readonly _cek?: string
  /** The body key when one exists, so the caller can cache it; `null` for a legacy record. */
  readonly cek: CryptoKey | null
}

/**
 * Move a record body from `fromDek` to `toDek`.
 *
 * - Per-record-key record (`_cek` present): unwrap the CEK under `fromDek`,
 *   re-encrypt the body under the SAME CEK, re-wrap the CEK under `toDek`. The
 *   body key is unchanged → history-chain identity preserved.
 * - Legacy record (no `_cek`): decrypt under `fromDek`, re-encrypt under `toDek`
 *   directly — byte-for-byte the pre-CEK behaviour.
 */
export async function rewrapBodyToDek(
  envelope: Pick<EncryptedEnvelope, '_iv' | '_data' | '_cek'>,
  fromDek: CryptoKey,
  toDek: CryptoKey,
): Promise<RewrappedBody> {
  if (envelope._cek !== undefined) {
    const cek = await unwrapCek(envelope._cek, fromDek)
    const plaintext = await decrypt(envelope._iv, envelope._data, cek)
    const { iv, data } = await encrypt(plaintext, cek)
    return { _iv: iv, _data: data, _cek: await wrapCek(cek, toDek), cek }
  }
  const plaintext = await decrypt(envelope._iv, envelope._data, fromDek)
  const { iv, data } = await encrypt(plaintext, toDek)
  return { _iv: iv, _data: data, cek: null }
}
