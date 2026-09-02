/**
 * Arithmetic in the Galois field GF(2^8), represented as bytes 0..255.
 *
 * Used by Shamir Secret Sharing for byte-wise polynomial operations.
 * Addition is XOR; multiplication uses precomputed log/exp tables
 * against the primitive element 0x03 with irreducible polynomial
 * 0x11b (x^8 + x^4 + x^3 + x + 1 — the AES polynomial).
 *
 * Constant-time is NOT a goal here — for secret sharing, the threat
 * model assumes the combining device is trusted during
 * reconstruction. If that assumption is wrong, no library-level
 * constant-time hedge protects the plaintext anyway.
 */

const LOG = new Uint8Array(256)
const EXP = new Uint8Array(256)

// Build log/exp tables. Primitive element 0x03; reduction polynomial 0x11b.
// Multiplication by 3 in GF(2^8) is (x << 1) ^ x, with polynomial reduction
// when the shift carries bit 8.
{
  let x = 1
  for (let i = 0; i < 255; i++) {
    EXP[i] = x
    LOG[x] = i
    // x <- x * 3 in GF(2^8)
    let doubled = x << 1
    if (doubled & 0x100) doubled ^= 0x11b
    x = (doubled ^ x) & 0xff
  }
  // EXP cycles with period 255 — EXP[255] = EXP[0] simplifies modulo math.
  EXP[255] = EXP[0]!
  // LOG[0] is undefined (log of 0 doesn't exist) — guarded at call sites.
}

/** Addition in GF(2^8) is XOR. */
export function gfAdd(a: number, b: number): number {
  return (a ^ b) & 0xff
}

/** Multiplication in GF(2^8). Returns 0 if either operand is 0. */
export function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0
  const s = (LOG[a]! + LOG[b]!) % 255
  return EXP[s]!
}

/** Multiplicative inverse in GF(2^8). Throws on 0 (no inverse exists). */
export function gfInv(a: number): number {
  if (a === 0) throw new Error('gf256: no inverse for 0')
  return EXP[(255 - LOG[a]!) % 255]!
}

/** Division in GF(2^8). Throws on divide-by-zero. */
export function gfDiv(a: number, b: number): number {
  if (b === 0) throw new Error('gf256: division by zero')
  if (a === 0) return 0
  const s = (LOG[a]! + 255 - LOG[b]!) % 255
  return EXP[s]!
}

/**
 * Evaluate a polynomial with coefficients `coeffs[0] + coeffs[1]*x + ...`
 * at point `x` in GF(2^8) via Horner's method.
 */
export function gfPolyEval(coeffs: readonly number[], x: number): number {
  let y = 0
  for (let i = coeffs.length - 1; i >= 0; i--) {
    y = gfAdd(gfMul(y, x), coeffs[i]!)
  }
  return y
}

/**
 * Lagrange interpolation at x=0, given k distinct points `(xi, yi)`.
 *
 * Returns the constant term of the unique degree-(k-1) polynomial
 * through those points — equal to the original secret byte for
 * Shamir's construction.
 */
export function lagrangeInterpolateAtZero(points: readonly [number, number][]): number {
  let result = 0
  for (let i = 0; i < points.length; i++) {
    const [xi, yi] = points[i]!
    // Li(0) = ∏_{j≠i} xj / (xi XOR xj)   (in GF(2^8), -x == x)
    let numerator = 1
    let denominator = 1
    for (let j = 0; j < points.length; j++) {
      if (i === j) continue
      const [xj] = points[j]!
      numerator = gfMul(numerator, xj)
      denominator = gfMul(denominator, gfAdd(xi, xj))
    }
    const basis = gfDiv(numerator, denominator)
    result = gfAdd(result, gfMul(yi, basis))
  }
  return result
}
