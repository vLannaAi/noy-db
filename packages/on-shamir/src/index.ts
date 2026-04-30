/**
 * **@noy-db/on-shamir** — k-of-n Shamir Secret Sharing of the vault KEK.
 *
 * Any K of N enrolled shares recombines the original KEK; fewer than
 * K leaks zero bits. Unlike naive multi-passphrase schemes, each
 * share can be protected by ANY other `@noy-db/on-*` method — share
 * 1 under a WebAuthn passkey, share 2 under an OIDC login, share 3
 * on paper in a safe. This composability is the defining feature.
 *
 * Part of the `@noy-db/on-*` authentication family.
 *
 * ## Math
 *
 * Shamir Secret Sharing over GF(2^8), byte-wise. For each byte of the
 * secret, construct a random polynomial of degree k-1 with the byte
 * as the constant term. Each share is a value of that polynomial at
 * a distinct x-coordinate. Lagrange interpolation at x=0 recovers
 * the byte. Zero cryptographic dependencies — pure math in
 * `gf256.ts` and `shamir.ts`.
 *
 * ## Threat model
 *
 * Protects against:
 *   - Up to K-1 colluding share holders (mathematically — fewer than K shares reveals zero bits)
 *   - Loss of up to N-K shares
 *
 * Does NOT protect against:
 *   - K colluding share holders (by design — that's the threshold contract)
 *   - Device compromise of the combining machine during reconstruction
 *
 * ## Usage
 *
 * ```ts
 * import {
 *   splitKEK,
 *   combineKEK,
 *   encodeShareBase32,
 *   decodeShareBase32,
 * } from '@noy-db/on-shamir'
 *
 * // ENROLL — user has unlocked the vault with passphrase; now create a 2-of-3 split
 * const shares = await splitKEK(currentKEK, { k: 2, n: 3 })
 * const shareStrings = shares.map(encodeShareBase32)
 * // Distribute each shareString to a different holder via any on-* method
 *
 * // UNLOCK — collect 2 of the 3 shares and combine
 * const collected = [decodeShareBase32(shareA), decodeShareBase32(shareB)]
 * const kek = await combineKEK(collected)
 * // kek is now a non-extractable CryptoKey usable as the vault's KEK
 * ```
 *
 * @packageDocumentation
 */

export {
  gfAdd,
  gfMul,
  gfDiv,
  gfInv,
  gfPolyEval,
  lagrangeInterpolateAtZero,
} from './gf256.js'

export {
  splitSecret,
  combineSecret,
  type RawShare,
} from './shamir.js'

export {
  encodeShareBytes,
  decodeShareBytes,
  encodeShareBase32,
  decodeShareBase32,
  encodeShareJSON,
  decodeShareJSON,
  type ShareJSON,
} from './share-format.js'

import type { RawShare } from './shamir.js'
import { combineSecret, splitSecret } from './shamir.js'

// ── High-level KEK API ──────────────────────────────────────────────────

export interface SplitKEKOptions {
  /** Threshold — minimum shares needed to reconstruct. Must be >= 2. */
  readonly k: number
  /** Total shares. Must satisfy k <= n <= 255. */
  readonly n: number
}

/**
 * Split the given KEK into N Shamir shares.
 *
 * The KEK must be extractable (so the raw bytes can be read for the
 * split operation). The returned `RawShare[]` contains the raw share
 * material — serialise each via `encodeShareBase32` / `encodeShareJSON`
 * before distributing.
 *
 * The caller is responsible for:
 * 1. Distributing the shares to their holders.
 * 2. Writing an audit-ledger entry recording the enrollment (including
 *    the `k`, `n`, and share x-coordinates — not the share material).
 * 3. Securely zeroing any in-memory share/secret material after
 *    serialisation.
 */
export async function splitKEK(kek: CryptoKey, options: SplitKEKOptions): Promise<RawShare[]> {
  const rawKek = await crypto.subtle.exportKey('raw', kek)
  const secret = new Uint8Array(rawKek)
  try {
    return splitSecret(secret, options.k, options.n)
  } finally {
    // Zero the secret buffer — best-effort, GC will also reclaim.
    secret.fill(0)
  }
}

/**
 * Reconstruct the KEK from K or more shares.
 *
 * Returns a non-extractable `CryptoKey` ready to use as the vault's
 * KEK. Internal secret bytes are zeroed after the CryptoKey is
 * imported.
 *
 * Throws:
 *   - if fewer than K shares are provided
 *   - if shares have mismatched lengths (likely indicating shares from
 *     different enrollments were mixed)
 *   - if duplicate x-coordinates are detected
 */
export async function combineKEK(shares: readonly RawShare[]): Promise<CryptoKey> {
  const secret = combineSecret(shares)
  try {
    return await crypto.subtle.importKey(
      'raw',
      secret as BufferSource,
      { name: 'AES-GCM', length: 256 },
      false,  // non-extractable by default
      ['encrypt', 'decrypt'],
    )
  } finally {
    secret.fill(0)
  }
}
