/**
 * Per-record CEK lifecycle helpers for the WRITE path.
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
import { encrypt, decrypt, generateDEK, wrapCek, unwrapCek, type EnclaveKey } from '../crypto.js'
import type { EncryptedEnvelope } from '../../types.js'
import type { Lru } from '../../cache/index.js'

/** Dependencies {@link resolveStableCek} needs from its collection. */
export interface StableCekDeps {
  /** The collection's per-record CEK cache (`null` → no caching). */
  readonly cache: Lru<string, EnclaveKey> | null
  /** Read the record's live envelope (to recover an existing `_cek`). */
  getLive(id: string): Promise<EncryptedEnvelope | null>
  /** The DEK the CEK is wrapped under (the collection DEK on the normal path). */
  getDEK(): Promise<EnclaveKey>
}

/**
 * Resolve the stable CEK for a record on the write path. Caches the resolved
 * key under `id` so an update + its history snapshot share one CEK.
 */
export async function resolveStableCek(deps: StableCekDeps, id: string): Promise<EnclaveKey> {
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
  readonly cek: EnclaveKey | null
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
  fromDek: EnclaveKey,
  toDek: EnclaveKey,
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

/**
 * Move a FULL stored envelope from `fromDek` to `toDek`, preserving every
 * field other than the re-keyed body (`_iv`/`_data`/`_cek`) unchanged.
 *
 * Body-field access (`_iv`/`_data`/`_cek`) is sanctioned inside the enclave;
 * this lets callers outside it (e.g. `with-commit/history`'s history
 * re-keying) get back a ready-to-store envelope without reading those fields
 * themselves. Mirrors the spread-merge idiom `with-audit/tiers/index.ts`'s
 * `elevate()`/`demote()` use to apply `rewrapBodyToDek`'s result to the live
 * envelope, generalized to any envelope shape (history callers don't bump
 * `_v`/`_ts`/`_tier` the way a tier move does).
 */
export async function rewrapEnvelope(
  envelope: EncryptedEnvelope,
  fromDek: EnclaveKey,
  toDek: EnclaveKey,
): Promise<EncryptedEnvelope> {
  const body = await rewrapBodyToDek(envelope, fromDek, toDek)
  const next: EncryptedEnvelope = {
    ...envelope,
    _iv: body._iv,
    _data: body._data,
    ...(body._cek !== undefined ? { _cek: body._cek } : {}),
  }
  if (body._cek === undefined && envelope._cek !== undefined) {
    delete (next as { _cek?: string })._cek
  }
  return next
}
