/**
 * Verify-digest primitive for classified `digest-only` fields (stage 2).
 * PBKDF2-SHA256 → fixed 32-byte digest. The digest NEVER leaves the enclave
 * in recoverable form — it is sealed into the `_vdig` envelope slot (vdig.ts)
 * or compared in-enclave (verify.ts). @module
 */
const subtle = globalThis.crypto.subtle

/** Family KDF constant — matches crypto.ts PBKDF2_ITERATIONS (600K). */
export const VDIG_ITERATIONS = 600_000

/**
 * Digest a (pre-normalized) candidate/value to exactly 32 bytes.
 * PBKDF2-SHA256 with a per-record per-write random salt (§2): verify
 * digests are non-equatable by construction.
 */
export async function pbkdf2VerifyDigest(
  value: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const keyMaterial = await subtle.importKey(
    'raw',
    new TextEncoder().encode(value),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  const bits = await subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    keyMaterial,
    256,
  )
  return new Uint8Array(bits)
}
