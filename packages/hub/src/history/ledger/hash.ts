/**
 * Envelope payload hash — pinned in its own leaf module so consumers
 * (DictionaryHandle, the active history strategy) can import it
 * without dragging in the `LedgerStore` class.
 *
 * #291 — see `constants.ts` for the broader rationale.
 *
 * @internal
 */

import type { EncryptedEnvelope } from '../../types.js'
import { sha256Hex } from './entry.js'

/**
 * Compute the `payloadHash` value for an encrypted envelope. Used by
 * `LedgerStore.append` for both put (hash the new envelope) and
 * delete (hash the previous envelope) paths, and by
 * `DictionaryHandle` so its ledger entries match the same contract.
 *
 * Returns the empty string when there is no envelope (delete of a
 * never-existed record). The empty string tolerated by the ledger
 * entry's `payloadHash` field as the canonical "nothing here" value.
 */
export async function envelopePayloadHash(
  envelope: EncryptedEnvelope | null,
): Promise<string> {
  if (!envelope) return ''
  // `_data` is a base64 string for encrypted envelopes and the raw
  // JSON for plaintext ones. Both are strings, so a single sha256Hex
  // call works for both modes — the hash value differs between
  // encrypted/plaintext compartments because the bytes on disk
  // differ.
  return sha256Hex(envelope._data)
}
