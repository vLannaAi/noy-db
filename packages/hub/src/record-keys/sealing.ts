/**
 * Record-scoped CEK sealing — grantor side (#306 slices 2-3).
 *
 * The **grantor** holds the collection DEK and seals ONE record's CEK to an
 * `at-*` host so that host — and only that host — can decrypt exactly that
 * record, with no access to the vault DEK and no ability to read any other
 * record. This is the counterpart to the host-side `openSealedRecord`
 * (`@noy-db/hub/sealed-record`), which holds no DEK.
 *
 * These functions are the orchestration behind `vault.sealRecordToHost` /
 * `vault.revokeSealedRecord` / `vault.rotateRecordCek`, lifted off `Vault`
 * behind a narrow {@link SealingContext} so the kernel file delegates. They
 * live in `record-keys/` (the vault-side CEK policy layer), NOT in
 * `sealed-record/`, so the host-side subpath stays DEK-free — they import only
 * the wire *types* from there.
 */
import { encrypt, decrypt, generateDEK, wrapCek, unwrapCek, bufferToBase64, deriveSealedFieldKeyFromCek } from '../crypto.js'
import { NOYDB_FORMAT_VERSION, type EncryptedEnvelope, type NoydbStore } from '../types.js'
import { dualReadSealedSlot } from './sealed-slot.js'
import { RecordCekNotFoundError, ValidationError } from '../errors.js'
import type { RecipientSealer } from '../with-party/team/managed-passphrase.js'
import type { SealedCekBinding, SealedCekDeliveryEnvelope } from '../with-audit/sealed-record/types.js'

const subtle = globalThis.crypto.subtle

/** The `_sealed_cek` delivery namespace (one envelope per `collection/id/pid`). */
export const SEALED_CEK_NS = '_sealed_cek'

/** What the grantor functions need from their `Vault`. */
export interface SealingContext {
  readonly adapter: NoydbStore
  /** Vault id (the adapter's first coordinate). */
  readonly vault: string
  /** Resolve the DEK a record's CEK is wrapped under. */
  getDEK(collection: string): Promise<CryptoKey>
  /** Actor id stamped on `_by` (empty string → omit). */
  readonly actor: string
  /** Evict the per-record CEK cache + decrypted-record cache after a rotation. */
  invalidateRecordCaches(collection: string, id: string): Promise<void>
}

/**
 * Seal a record's CEK to a host. See `vault.sealRecordToHost` for the contract.
 * Returns `{ pid, envelopeKey }`.
 */
export async function sealRecordToHost(
  ctx: SealingContext,
  collection: string,
  id: string,
  hostSealer: RecipientSealer,
  opts: { expiresAt: string },
): Promise<{ pid: string; envelopeKey: string }> {
  // Guard separators: the `_sealed_cek` id is `collection/id/pid`, so a `/` in
  // any component would make the prefix-delete in rotateRecordCek() (which
  // matches `${collection}/${id}/`) ambiguous and could over- or under-match.
  if (collection.includes('/')) throw new ValidationError(`sealRecordToHost: collection "${collection}" must not contain "/"`)
  if (id.includes('/')) throw new ValidationError(`sealRecordToHost: id "${id}" must not contain "/"`)
  // M-4: reject a malformed/empty expiry at seal time. `Date.parse('')` (and any
  // non-ISO string) is NaN, and the open-time check `NaN <= now` is `false` — so
  // a malformed expiry would silently mint an ETERNAL grant. A *past* (but valid)
  // timestamp is still allowed: it seals, then fails closed at open time.
  if (Number.isNaN(Date.parse(opts.expiresAt))) {
    throw new ValidationError(`sealRecordToHost: expiresAt "${opts.expiresAt}" is not a valid ISO 8601 timestamp`)
  }

  const live = await ctx.adapter.get(ctx.vault, collection, id)
  if (!live || live._cek === undefined) {
    throw new RecordCekNotFoundError(collection, id)
  }

  const dek = await ctx.getDEK(collection)
  const cek = await unwrapCek(live._cek, dek)
  const rawCek = await subtle.exportKey('raw', cek)
  const cekB64 = bufferToBase64(rawCek)

  const hint = await hostSealer.publishRecipientHint()
  if (hint.pid.includes('/')) throw new ValidationError(`sealRecordToHost: recipient pid "${hint.pid}" must not contain "/"`)

  const binding: SealedCekBinding = {
    collection,
    id,
    cek: cekB64,
    expiresAt: opts.expiresAt,
  }
  const sealed = await hostSealer.sealForRecipient(
    new TextEncoder().encode(JSON.stringify(binding)),
    hint,
  )

  const delivery: SealedCekDeliveryEnvelope = {
    v: 1,
    _noydb_sealed_cek: 1,
    pid: hint.pid,
    payload: bufferToBase64(sealed),
    expiresAt: opts.expiresAt,
  }

  const envelopeKey = `${collection}/${id}/${hint.pid}`
  const prior = await ctx.adapter.get(ctx.vault, SEALED_CEK_NS, envelopeKey)
  const env: EncryptedEnvelope = {
    _noydb: NOYDB_FORMAT_VERSION,
    _v: (prior?._v ?? 0) + 1,
    _ts: new Date().toISOString(),
    // AES-GCM bypassed — the sealing layer is the security boundary, exactly
    // like the managed-passphrase `_meta/sealed-passphrase` envelope.
    _iv: '',
    _data: JSON.stringify(delivery),
    ...(ctx.actor ? { _by: ctx.actor } : {}),
  }
  await ctx.adapter.put(ctx.vault, SEALED_CEK_NS, envelopeKey, env)

  return { pid: hint.pid, envelopeKey }
}

/**
 * Revoke one sealed-CEK grant.
 *
 * **Default (`{ hard: false }`) is SOFT** — it only deletes the delivery
 * envelope from the store. A host that already fetched (or cached the unsealed
 * CEK from) that envelope KEEPS decrypt capability for the record; soft revoke
 * is a "stop new fetches" control, not a cryptographic cutoff.
 *
 * **`{ hard: true }`** additionally rotates the record's CEK (via
 * {@link rotateRecordCek}): the live body is re-encrypted under a fresh CEK and
 * EVERY sealed-CEK delivery envelope for the record (all pids) is deleted, so
 * any previously-sealed CEK fails the AES-GCM auth tag on the rotated body —
 * future opens are cryptographically denied. (PRE-rotation history versions,
 * which keep their old `_cek`, remain openable — same semantics as
 * `rotateRecordCek`.)
 */
export async function revokeSealedRecord(
  ctx: SealingContext,
  collection: string,
  id: string,
  pid: string,
  opts?: { hard?: boolean },
): Promise<void> {
  if (opts?.hard === true) {
    // Hard revocation supersedes the single-pid soft delete: rotateRecordCek
    // re-keys the record and drops every delivery envelope for it.
    await rotateRecordCek(ctx, collection, id)
    return
  }
  await ctx.adapter.delete(ctx.vault, SEALED_CEK_NS, `${collection}/${id}/${pid}`)
}

/**
 * HARD-rotate a record's CEK: re-encrypt the live body under a fresh CEK, evict
 * caches, and delete EVERY sealed-CEK delivery envelope for the record. See
 * `vault.rotateRecordCek` for why this bypasses `Collection.put` (no guards, no
 * history bump — a key rotation must not re-encrypt prior history under the new
 * CEK).
 */
export async function rotateRecordCek(
  ctx: SealingContext,
  collection: string,
  id: string,
): Promise<void> {
  const live = await ctx.adapter.get(ctx.vault, collection, id)
  if (!live || live._cek === undefined) {
    throw new RecordCekNotFoundError(collection, id)
  }

  const dek = await ctx.getDEK(collection)
  const oldCek = await unwrapCek(live._cek, dek)
  const json = await decrypt(live._iv, live._data, oldCek)

  const newCek = await generateDEK()
  const { iv, data } = await encrypt(json, newCek)

  // #306: sealed fields are now keyed off the per-record CEK, so a rotation
  // must RE-ENCRYPT each `_sealed[field]` under the new CEK (Slice A's
  // carry-forward would orphan them — the old CEK is gone after this rotate).
  // Dual-read the old slot: try the old-CEK-derived key (#306 records), fall
  // back to the collection-DEK key (legacy / pre-#306), then re-seal under newCek.
  let sealedOut: Record<string, string> | undefined
  if (live._sealed !== undefined) {
    const out: Record<string, string> = {}
    for (const [field, slot] of Object.entries(live._sealed)) {
      const plaintext = await dualReadSealedSlot(slot, field, collection, oldCek, dek)
      const resealed = await encrypt(plaintext, await deriveSealedFieldKeyFromCek(newCek, collection, field))
      out[field] = `${resealed.iv}:${resealed.data}`
    }
    sealedOut = out
  }

  const env: EncryptedEnvelope = {
    _noydb: NOYDB_FORMAT_VERSION,
    _v: live._v + 1,
    _ts: new Date().toISOString(),
    _iv: iv,
    _data: data,
    _cek: await wrapCek(newCek, dek),
    ...(ctx.actor ? { _by: ctx.actor } : {}),
    ...(live._tier !== undefined ? { _tier: live._tier } : {}),
    ...(live._det !== undefined ? { _det: live._det } : {}),
    // Re-encrypt sealed (`sensitive`) fields under the new CEK (#306). Sealed
    // keys now derive off the per-record CEK, so the rotated record's old CEK is
    // destroyed here — carrying the old `_sealed` slots forward verbatim would
    // orphan them (unreadable under the new CEK). `sealedOut` holds the slots
    // dual-read from the old CEK (or the legacy DEK) and re-sealed under newCek.
    ...(sealedOut !== undefined ? { _sealed: sealedOut } : {}),
  }
  await ctx.adapter.put(ctx.vault, collection, id, env)

  // Evict BOTH caches synchronously so no read returns the stale old-CEK record.
  await ctx.invalidateRecordCaches(collection, id)

  // Delete every sealed-CEK delivery envelope for this record — all pids.
  const prefix = `${collection}/${id}/`
  const keys = await ctx.adapter.list(ctx.vault, SEALED_CEK_NS)
  for (const key of keys) {
    if (key.startsWith(prefix)) {
      await ctx.adapter.delete(ctx.vault, SEALED_CEK_NS, key)
    }
  }
}
