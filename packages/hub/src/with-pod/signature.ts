/**
 * The ONE signing convention for the noy-db family — pod header, the
 * Redirect record (#944), and manifest writes (#941) all sign through
 * this module rather than inventing their own scheme.
 *
 * Convention: `canonicalJson(payload minus sig)` → `utf8` → Ed25519, over
 * the published `@noy-db/attestation` primitives. The caller is
 * responsible for excluding the `sig` field from `payload` before
 * signing/verifying — this module never strips it for you, so a payload
 * that still carries a stray field (or `undefined`) fails loudly via
 * `canonicalJson` rather than silently signing the wrong bytes.
 *
 * No pod/vault imports here — this is a family-wide primitive.
 */
import { canonicalJson, ed25519Sign, ed25519Verify, utf8 } from '@noy-db/attestation'

export const POD_SIG_ALG = 'ed25519' as const

/** The exact bytes a signature covers: utf8(canonicalJson(payload)). Exported for cross-checking. */
export function signedBytes(payload: Record<string, unknown>): Uint8Array {
  return utf8(canonicalJson(payload))
}

/**
 * Sign an arbitrary canonical record. `payload` MUST already exclude any
 * `sig` field.
 */
export async function signRecord(privateKeyPkcs8B64: string, payload: Record<string, unknown>): Promise<string> {
  return ed25519Sign(privateKeyPkcs8B64, signedBytes(payload))
}

/**
 * Verify. `payload` is the record WITHOUT `sig`. Fails closed (false) on
 * any malformed input.
 */
export async function verifyRecord(publicKeyB64: string, sig: string, payload: Record<string, unknown>): Promise<boolean> {
  return ed25519Verify(publicKeyB64, sig, signedBytes(payload))
}
