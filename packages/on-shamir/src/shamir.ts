/**
 * Shamir Secret Sharing over GF(2^8), byte-wise.
 *
 * For each byte of the secret, construct a random polynomial of
 * degree k-1 whose constant term is the byte. Each share is a value
 * of that polynomial at a distinct x-coordinate in 1..255. Any K of
 * the N shares recombines the original bytes via Lagrange interpolation
 * at x=0.
 *
 * x=0 is reserved (it would directly reveal the secret). x-coordinates
 * are chosen from 1..255 ensuring distinctness.
 */

import { gfPolyEval, lagrangeInterpolateAtZero } from './gf256.js'

/**
 * Split a secret into N shares. Any K of them reconstructs the secret;
 * fewer than K leaks zero bits.
 *
 * @param secret - The bytes to share (e.g., a 32-byte KEK).
 * @param k - Threshold (min shares needed to reconstruct). Must be >= 2.
 * @param n - Total shares to produce. Must be >= k and <= 255.
 * @param randomBytes - RNG function returning N random bytes. Defaults to
 *   `crypto.getRandomValues`. Injectable for deterministic tests.
 * @returns An array of `n` shares. Each share has an x-coordinate + y-bytes
 *   parallel to the secret bytes.
 */
export function splitSecret(
  secret: Uint8Array,
  k: number,
  n: number,
  randomBytes: (count: number) => Uint8Array = defaultRandomBytes,
): RawShare[] {
  assertSplitArgs(k, n, secret.length)

  // Choose n distinct x-coordinates in 1..255.
  const xCoords = pickXCoords(n)

  // For each byte of the secret, build a polynomial of degree k-1 with
  // the byte as the constant term and random coefficients for x^1..x^(k-1).
  // Evaluate at each xCoord to get the share's y-byte for that position.
  const shares: RawShare[] = xCoords.map(x => ({
    x,
    y: new Uint8Array(secret.length),
    k,
    n,
  }))

  for (let byteIdx = 0; byteIdx < secret.length; byteIdx++) {
    const coeffs: number[] = [secret[byteIdx]!]
    const rand = randomBytes(k - 1)
    for (let j = 0; j < k - 1; j++) {
      coeffs.push(rand[j]!)
    }
    for (let shareIdx = 0; shareIdx < n; shareIdx++) {
      shares[shareIdx]!.y[byteIdx] = gfPolyEval(coeffs, xCoords[shareIdx]!)
    }
  }

  return shares
}

/**
 * Reconstruct a secret from K or more shares.
 *
 * Uses the first K shares provided; additional shares are ignored.
 * Shares must agree on secret length and x-coordinates must be
 * distinct (checked; throws on mismatch).
 */
export function combineSecret(shares: readonly RawShare[]): Uint8Array {
  if (shares.length === 0) {
    throw new Error('on-shamir: no shares provided')
  }
  const k = shares[0]!.k
  if (shares.length < k) {
    throw new Error(`on-shamir: insufficient shares — need ${k}, got ${shares.length}`)
  }
  const byteLength = shares[0]!.y.length
  for (const s of shares) {
    if (s.y.length !== byteLength) {
      throw new Error('on-shamir: share lengths disagree — incompatible enrollment')
    }
  }
  const selected = shares.slice(0, k)
  const xs = selected.map(s => s.x)
  if (new Set(xs).size !== xs.length) {
    throw new Error('on-shamir: duplicate x-coordinates among provided shares')
  }

  const secret = new Uint8Array(byteLength)
  for (let byteIdx = 0; byteIdx < byteLength; byteIdx++) {
    const points: [number, number][] = selected.map(s => [s.x, s.y[byteIdx]!])
    secret[byteIdx] = lagrangeInterpolateAtZero(points)
  }
  return secret
}

/** A raw Shamir share before serialisation. */
export interface RawShare {
  /** x-coordinate in GF(2^8), 1..255. Zero is disallowed (it would reveal the secret). */
  readonly x: number
  /** y-bytes — one per byte of the secret. */
  readonly y: Uint8Array
  /** Threshold used at split time. */
  readonly k: number
  /** Total shares at split time. */
  readonly n: number
}

// ── internals ──────────────────────────────────────────────────────────

function assertSplitArgs(k: number, n: number, secretLen: number): void {
  if (!Number.isInteger(k) || k < 2) {
    throw new Error(`on-shamir: k must be an integer >= 2 (got ${k})`)
  }
  if (!Number.isInteger(n) || n < k || n > 255) {
    throw new Error(`on-shamir: n must satisfy k <= n <= 255 (got k=${k} n=${n})`)
  }
  if (!Number.isInteger(secretLen) || secretLen < 1) {
    throw new Error(`on-shamir: secret must be at least 1 byte`)
  }
}

function pickXCoords(n: number): number[] {
  // Use 1..n as x-coordinates. Simple, deterministic, well-distributed.
  // (For applications where share-position anonymity matters, shuffle at
  // serialisation time; the crypto doesn't care about the labels.)
  const result: number[] = []
  for (let i = 1; i <= n; i++) result.push(i)
  return result
}

function defaultRandomBytes(count: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(count))
}
