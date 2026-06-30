/**
 * Sealed-slot (`iv:data`) parsing + the #306 dual-read, factored out so the
 * three callers that decrypt a `_sealed[field]` slot share ONE implementation
 * with no coupling between them:
 *
 *   - {@link RecordCodec.unsealField} / `classifySealedShred` (read + classify),
 *   - `record-keys/sealing.ts:rotateRecordCek` (re-seal under a new CEK).
 *
 * These are pure helpers over an explicit `(cek, dek)` pair — NOT a context
 * object — so `sealing.ts` (which holds only the DEK) can import them without
 * pulling in the whole codec, avoiding a codec↔sealing dependency cycle.
 */
import { decrypt, deriveSealedFieldKey, deriveSealedFieldKeyFromCek } from '../crypto.js'

/** Parse an `iv:data` sealed slot (split on the FIRST `:`). */
export function parseSealedSlot(blob: string): { iv: string; data: string } {
  const sep = blob.indexOf(':')
  return { iv: blob.slice(0, sep), data: blob.slice(sep + 1) }
}

/**
 * #306 dual-read: decrypt a sealed slot trying the CEK-derived field key first,
 * falling back to the collection-DEK field key. Records sealed BEFORE #306
 * (even ones whose body is CEK-encrypted) are sealed under the collection-DEK
 * key; current writes seal under the per-record CEK. Try the CEK key first; on
 * its AES-GCM auth failure, fall back to the DEK key. Throws only if BOTH fail.
 * Returns the plaintext string (callers `JSON.parse` as needed).
 */
export async function dualReadSealedSlot(
  blob: string,
  field: string,
  collection: string,
  cek: CryptoKey | undefined,
  dek: CryptoKey,
): Promise<string> {
  const { iv, data } = parseSealedSlot(blob)
  if (cek !== undefined) {
    try {
      const fieldKey = await deriveSealedFieldKeyFromCek(cek, collection, field)
      return await decrypt(iv, data, fieldKey)
    } catch {
      // fall through to the legacy collection-DEK derivation
    }
  }
  const fieldKey = await deriveSealedFieldKey(dek, collection, field)
  return decrypt(iv, data, fieldKey)
}
