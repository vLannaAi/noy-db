/**
 * Minimal ULID generator — zero dependencies, Web Crypto API only.
 *
 * v0.6 #100. Used by the bundle writer to generate stable opaque
 * handles for `.noydb` containers.
 *
 * **What's a ULID?** A 128-bit identifier encoded as 26 Crockford
 * base32 characters. Layout:
 *
 * ```
 *   01HYABCDEFGHJKMNPQRSTVWXYZ
 *   |--------||---------------|
 *    48-bit     80-bit
 *    timestamp  randomness
 * ```
 *
 * The first 10 chars encode a millisecond Unix timestamp (so ULIDs
 * sort lexicographically by creation time), and the remaining 16
 * chars are random. Crockford base32 omits I/L/O/U to avoid
 * ambiguity in handwriting and URLs.
 *
 * **Why hand-roll instead of pulling in `ulid`?** The package adds
 * a dep, the implementation is ~30 lines, and the bundle module
 * is the only consumer. Adding `ulid` would also drag in its own
 * crypto polyfill that we don't need on Node 18+ or modern
 * browsers.
 *
 * **Privacy consideration:** the timestamp prefix is observable in
 * the bundle header. This is a deliberate trade-off:
 *   - Pro: lexicographic sortability lets bundle adapters list
 *     newest-first without an extra index.
 *   - Con: a casual observer can read the bundle's creation time
 *     from the handle. They cannot read it from any OTHER field
 *     (the header explicitly forbids `_exported_at`), and a
 *     creation timestamp is the same kind of metadata that
 *     filesystem mtime would already expose for a downloaded
 *     bundle. The leak is therefore equivalent to what's already
 *     visible from the file's mtime — not a new exposure.
 *
 * If a future use case needs timestamp-free handles, a v2 of the
 * format could specify "use the random portion only" without a
 * format break — `validateBundleHeader` only checks the regex
 * shape, not the encoded timestamp.
 */

/**
 * Crockford base32 alphabet — omits I, L, O, U to avoid handwriting
 * and URL-encoding ambiguity. 32 characters covering 5 bits each.
 */
const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/**
 * Encode a non-negative integer as a fixed-width Crockford base32
 * string. The width is fixed (not the natural log32 length) so
 * leading zeros are preserved — that's required for the timestamp
 * prefix to remain lexicographically sortable.
 *
 * Used twice: once for the 48-bit timestamp portion (10 chars) and
 * once for each 40-bit half of the randomness (8 chars × 2).
 */
function encodeBase32(value: number, length: number): string {
  let out = ''
  let v = value
  for (let i = 0; i < length; i++) {
    out = CROCKFORD_ALPHABET[v % 32]! + out
    v = Math.floor(v / 32)
  }
  return out
}

/**
 * Generate a fresh ULID. Uses `crypto.getRandomValues` for the
 * randomness portion — same Web Crypto API the rest of the
 * codebase uses for IVs and salt.
 *
 * Returns a 26-character string. Calling twice in the same
 * millisecond produces two distinct ULIDs (the random portion
 * differs); ULIDs from the same millisecond are NOT guaranteed
 * to be monotonically ordered relative to each other, only
 * relative to ULIDs from a different millisecond. The bundle
 * format never relies on intra-millisecond ordering.
 */
export function generateULID(): string {
  const now = Date.now()

  // 48-bit timestamp → 10 Crockford base32 characters.
  // JavaScript's max safe integer is 2^53 - 1; Date.now() is well
  // within that range until the year ~285,000 AD. Splitting into
  // high and low 24-bit halves keeps every intermediate value
  // inside the safe-integer range and avoids any ambiguity in the
  // base32 encoder above.
  const timestampHigh = Math.floor(now / 0x1000000) // top 24 bits
  const timestampLow = now & 0xffffff               // bottom 24 bits
  const tsPart =
    encodeBase32(timestampHigh, 5) + encodeBase32(timestampLow, 5)

  // 80-bit randomness → 16 Crockford base32 characters. Split into
  // two 40-bit halves so each fits in JavaScript's safe-integer
  // range (53 bits) and the base32 encoder doesn't have to deal
  // with bigints.
  const randBytes = new Uint8Array(10)
  crypto.getRandomValues(randBytes)

  // First 5 bytes (40 bits) → 8 Crockford base32 characters.
  // Reconstruct the 40-bit integer from bytes in big-endian order.
  // Multiplication by 2^32 (instead of bit-shift) avoids JavaScript's
  // 32-bit integer cast on the high byte.
  const rand1 =
    randBytes[0]! * 2 ** 32 +
    (randBytes[1]! << 24 >>> 0) +
    (randBytes[2]! << 16) +
    (randBytes[3]! << 8) +
    randBytes[4]!
  // Same for the second 5 bytes.
  const rand2 =
    randBytes[5]! * 2 ** 32 +
    (randBytes[6]! << 24 >>> 0) +
    (randBytes[7]! << 16) +
    (randBytes[8]! << 8) +
    randBytes[9]!
  const randPart = encodeBase32(rand1, 8) + encodeBase32(rand2, 8)

  return tsPart + randPart
}

/**
 * Validate that a string is a syntactically well-formed ULID. Used
 * by the bundle header validator. Does NOT verify that the
 * timestamp portion decodes to a sensible date — the format only
 * cares about the encoding shape.
 */
export function isULID(value: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(value)
}
