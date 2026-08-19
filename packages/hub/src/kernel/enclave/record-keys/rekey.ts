/**
 * Re-key one envelope from an old collection DEK to a new one (#1074).
 *
 * Lives in the enclave because it is envelope surgery: it reads and writes the
 * protected body slots (`_iv`/`_data`/`_cek`), which `enclave-body-only`
 * reserves to `kernel/enclave/**`. `rotateKeys` previously did this inline in
 * `with-party/team/keyring.ts` and got it wrong in two ways that the guard
 * would have caught had the code lived here.
 *
 * @packageDocumentation
 */
import { encrypt, decrypt, wrapCek, unwrapCek, type EnclaveKey } from '../crypto.js'
import { recordAadFor } from '../record-aad.js'
import type { EncryptedEnvelope } from '../../types.js'

/**
 * Produce the envelope `envelope` becomes once its collection's DEK rotates
 * from `oldDek` to `newDek`.
 *
 * **Every slot is carried forward except `_bidx`.** The previous inline version
 * built a fresh literal holding only `_noydb/_v/_ts/_iv/_data`, silently
 * discarding `_by`, `_tier`, `_cek`, `_sealed`, `_vdig` and `_source`. Losing
 * `_tier` was the worst of those: tier-0 reads treat elevated as missing, so an
 * elevated record did not error after a rotation — it simply disappeared.
 *
 * `_bidx` is dropped deliberately. It is a DEK-rooted equality tag, so a tag
 * carried across a DEK rotation can never be re-derived to match a query again
 * while still leaking the old equality partition. Index coverage regrows
 * per-record on the next `put()` under the new DEK.
 *
 * Two shapes, and picking the wrong one is why this needed a helper:
 *
 * - **per-record CEK** (`_cek` present) — the body is sealed under the CEK and
 *   the CEK is wrapped under the collection DEK, so rotation re-wraps the CEK
 *   and leaves the body **untouched**. The old inline code instead ran
 *   `decrypt(body, oldDek)` on these, which throws: rotation could not complete
 *   on a collection containing any CEK record.
 * - **bare** — body sealed directly under the DEK, so decrypt and re-encrypt.
 *
 * Idempotence is the caller's problem, not this function's: it assumes
 * `envelope` is still under `oldDek`. A resumable rotation must know which side
 * of the migration each record is on before calling.
 */
export async function rekeyEnvelopeToDek(
  ref: { readonly collection: string; readonly id: string },
  envelope: EncryptedEnvelope,
  oldDek: EnclaveKey,
  newDek: EnclaveKey,
): Promise<EncryptedEnvelope> {
  // A DEK rotation moves the WRAPPING key only — the record keeps its address
  // and its tags — so the same AAD opens and re-seals it (#1041).
  const aad = recordAadFor(ref, envelope)
  const { _bidx, ...carried } = envelope
  void _bidx // dropped deliberately — see above

  if (envelope._cek !== undefined) {
    const cek = await unwrapCek(envelope._cek, oldDek)
    return { ...carried, _cek: await wrapCek(cek, newDek) }
  }

  const plaintext = await decrypt(envelope._iv, envelope._data, oldDek, aad)
  const { iv, data } = await encrypt(plaintext, newDek, aad)
  return { ...carried, _ts: new Date().toISOString(), _iv: iv, _data: data }
}

/**
 * Resumable variant: returns the re-keyed envelope, or `null` when `envelope`
 * is **already** under `newDek` and needs no work (#1074 part 2).
 *
 * A rotation interrupted mid-collection leaves records on both sides of the
 * migration. Resuming means re-running the rotation with the *same* new DEK,
 * which requires distinguishing "not yet moved" from "already moved" without
 * the caller touching protected slots.
 *
 * Detection is by trial decryption under `oldDek`. There is no metadata that
 * says which DEK sealed a record — deliberately, since such a marker would be
 * store-writable and therefore a downgrade lever (the same reasoning that
 * keeps the reader from branching on `_noydb`).
 *
 * A record that opens under *neither* key is genuinely damaged and rethrows,
 * rather than being silently skipped: a rotation that quietly walked past
 * unreadable records would convert a loud failure into permanent silent loss,
 * which is the defect this whole issue is about.
 */
export async function rekeyEnvelopeIfNeeded(
  ref: { readonly collection: string; readonly id: string },
  envelope: EncryptedEnvelope,
  oldDek: EnclaveKey,
  newDek: EnclaveKey,
): Promise<EncryptedEnvelope | null> {
  try {
    return await rekeyEnvelopeToDek(ref, envelope, oldDek, newDek)
  } catch (errUnderOld) {
    // Already migrated? Then it opens under the new DEK and there is nothing
    // to do. Verified rather than assumed.
    try {
      if (envelope._cek !== undefined) await unwrapCek(envelope._cek, newDek)
      else await decrypt(envelope._iv, envelope._data, newDek, recordAadFor(ref, envelope))
      return null
    } catch {
      throw errUnderOld
    }
  }
}

/**
 * Does this envelope open under ANY of `keys`? A read-only probe — decrypts
 * nothing into a caller-visible value and writes nothing.
 *
 * Exists so a rotation can tell *"this envelope belongs to a DIFFERENT DEK slot
 * the caller also holds"* from *"this envelope is damaged"* (#1125). Those two
 * look identical from a failed `rekeyEnvelopeIfNeeded`, and collapsing them
 * either aborts a legitimate rotation or walks past unreadable data.
 *
 * **The question is deliberately asked of the KEY, not of the envelope's claimed
 * `_tier`.** `_tier` is unencrypted — the store writes it — so routing a
 * rotation on it would let a store mark a tier-0 record `_tier: 5` and have the
 * rotation skip it, leaving a revoked member's DEK live on real data. That is
 * #1115's defect wearing a different hat. A key either opens the body or it does
 * not, and a store cannot forge that.
 *
 * Mirrors `rekeyBlobSet`'s `otherDeks` treatment, which asks the same question
 * about the same kind of ambiguity.
 */
export async function envelopeOpensUnderAny(
  ref: { readonly collection: string; readonly id: string },
  envelope: EncryptedEnvelope,
  keys: readonly EnclaveKey[],
): Promise<boolean> {
  for (const key of keys) {
    try {
      if (envelope._cek !== undefined) await unwrapCek(envelope._cek, key)
      else await decrypt(envelope._iv, envelope._data, key, recordAadFor(ref, envelope))
      return true
    } catch { /* not this key */ }
  }
  return false
}
