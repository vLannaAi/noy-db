/**
 * C2 — fixed-length-tag constant-time comparison (hub-portable; no
 * Node timingSafeEqual). Two mandatory rules (spec §3):
 *  1. Only fixed 32-byte tags are ever compared — ctEqualTags throws on
 *     anything else (tag length is structural, never secret-dependent).
 *  2. Every comparand is reduced to a 32-byte tag under a FRESH ephemeral
 *     HMAC-SHA256 key before comparison — keyed blinding makes compare
 *     timing uncorrelated with underlying values; rule 1 (not blinding)
 *     is what removes input-length timing. Length inequality folds into
 *     unequal tags — never an early return.
 * @module
 */
const subtle = globalThis.crypto.subtle

/** Compare exactly-32-byte tags. XOR-accumulate over all 32 bytes, no early exit. */
export function ctEqualTags(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== 32 || b.length !== 32) {
    throw new Error(
      `ctEqualTags: tags must be exactly 32 bytes (got ${a.length}/${b.length}) — caller bug; ` +
      `reduce comparands with blindedEqual first`,
    )
  }
  let diff = 0
  for (let i = 0; i < 32; i++) diff |= (a[i]! ^ b[i]!)
  return diff === 0
}

/**
 * Blinded equality of arbitrary-length byte strings: fresh K_e per
 * comparison (never stored, never reused), HMAC both sides to 32-byte
 * tags, then ctEqualTags. On the digest path the inputs are already
 * 32-byte PBKDF2 outputs but still route through this reduction so
 * there is exactly ONE comparison construction (spec §3 rule 2).
 */
export async function blindedEqual(a: Uint8Array, b: Uint8Array): Promise<boolean> {
  const ke = await subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const tagA = new Uint8Array(await subtle.sign('HMAC', ke, a as BufferSource))
  const tagB = new Uint8Array(await subtle.sign('HMAC', ke, b as BufferSource))
  return ctEqualTags(tagA, tagB)
}
