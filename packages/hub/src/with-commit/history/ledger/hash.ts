/**
 * Envelope payload hash — pinned in its own leaf module so consumers
 * (DictionaryHandle, the active history strategy) can import it
 * without dragging in the `LedgerStore` class.
 *
 * see `constants.ts` for the broader rationale.
 *
 * @internal
 */

import type { EncryptedEnvelope } from '../../../types.js'
import { sha256Hex, canonicalJson } from './entry.js'

/**
 * Compute the `payloadHash` value for an encrypted envelope. Used by
 * `LedgerStore.append` for both put (hash the new envelope) and
 * delete (hash the previous envelope) paths, and by
 * `DictionaryHandle` so its ledger entries match the same contract.
 *
 * Hashes the open `_data` ciphertext, plus the sealed-field ciphertext
 * map (`_sealed`) when a record carries one — so the ledger attests to
 * both the open body AND every sealed value.
 *
 * Returns the empty string when there is no envelope (delete of a
 * never-existed record). The empty string tolerated by the ledger
 * entry's `payloadHash` field as the canonical "nothing here" value.
 */
export async function envelopePayloadHash(
  envelope: EncryptedEnvelope | null,
): Promise<string> {
  if (!envelope) return ''
  // Back-compat (#306 Slice C): a record with NO sealed fields hashes exactly
  // as before — sha256 of `_data` alone — so every pre-existing ledger entry
  // and every non-sealed backup verifies byte-identically. A record WITH
  // `_sealed` widens the hash to also bind the sealed-field ciphertext, so the
  // ledger attests to sealed-value tamper/erasure (a dropped or swapped
  // `_sealed[field]` now diverges `verifyBackupIntegrity`'s data cross-check).
  //
  // `_cek` is deliberately NOT bound: a tampered wrapped-CEK already self-
  // detects (it fails to unwrap), and `rotateRecordCek` rewrites `_cek` with no
  // ledger entry — binding it would make every legitimate rotation fail verify.
  //
  // `canonicalJson` sorts keys, so the hash is independent of `_sealed`'s
  // field-insertion / store-serialization order.
  //
  // RESIDUAL: a backup containing sealed records created BEFORE this change
  // stored `payloadHash` over `_data` only, so it will fail the data cross-check
  // and must be re-anchored (re-`put`/re-baseline). Sealed fields are new, so
  // this is expected to affect ~no real vault.
  //
  // The two branches are NOT domain-separated — D1 pins the no-`_sealed` branch
  // to exactly `sha256(_data)`, so it cannot carry a discriminator tag. An actor
  // with raw-store write access could therefore set a non-sealed record's `_data`
  // equal to the canonical-JSON string below and collide a sealed record's hash —
  // but doing so overwrites `_data` itself, which then no longer GCM-decrypts, so
  // it only suppresses the verify signal on an already-destroyed record; it cannot
  // silently erase one sealed field while leaving the record readable.
  if (envelope._sealed === undefined) return sha256Hex(envelope._data)
  return sha256Hex(canonicalJson({ _data: envelope._data, _sealed: envelope._sealed }))
}
