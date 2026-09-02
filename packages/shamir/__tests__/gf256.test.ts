import { describe, expect, it } from 'vitest'
import {
  gfAdd,
  gfDiv,
  gfInv,
  gfMul,
  gfPolyEval,
  lagrangeInterpolateAtZero,
} from '../src/gf256.js'

describe('gfAdd', () => {
  it('is XOR', () => {
    expect(gfAdd(0, 0)).toBe(0)
    expect(gfAdd(1, 1)).toBe(0)
    expect(gfAdd(0x53, 0xca)).toBe(0x53 ^ 0xca)
  })

  it('is commutative and associative', () => {
    for (const [a, b, c] of [[0x11, 0x22, 0x33], [0xff, 0x00, 0x80], [0xa5, 0x5a, 0xff]]) {
      expect(gfAdd(a!, b!)).toBe(gfAdd(b!, a!))
      expect(gfAdd(gfAdd(a!, b!), c!)).toBe(gfAdd(a!, gfAdd(b!, c!)))
    }
  })
})

describe('gfMul', () => {
  it('obeys identity and zero laws', () => {
    for (let a = 0; a < 256; a++) {
      expect(gfMul(a, 0)).toBe(0)
      expect(gfMul(0, a)).toBe(0)
      expect(gfMul(a, 1)).toBe(a)
      expect(gfMul(1, a)).toBe(a)
    }
  })

  it('is commutative', () => {
    for (const [a, b] of [[0x53, 0xca], [0x01, 0xff], [0xa5, 0x5a]]) {
      expect(gfMul(a!, b!)).toBe(gfMul(b!, a!))
    }
  })

  it('is associative', () => {
    for (const [a, b, c] of [[0x11, 0x22, 0x33], [0xff, 0x7f, 0x80], [0xa5, 0x5a, 0xff]]) {
      expect(gfMul(gfMul(a!, b!), c!)).toBe(gfMul(a!, gfMul(b!, c!)))
    }
  })

  it('known AES polynomial check — 0x53 × 0xca == 0x01', () => {
    // Canonical AES reference: 0x53 and 0xca are multiplicative inverses in GF(2^8).
    expect(gfMul(0x53, 0xca)).toBe(0x01)
  })
})

describe('gfInv', () => {
  it('throws on inversion of 0', () => {
    expect(() => gfInv(0)).toThrow(/no inverse/)
  })

  it('is self-inverting for 1 and 255 values', () => {
    for (let a = 1; a < 256; a++) {
      const inv = gfInv(a)
      expect(gfMul(a, inv)).toBe(1)
    }
  })
})

describe('gfDiv', () => {
  it('throws on divide-by-zero', () => {
    expect(() => gfDiv(1, 0)).toThrow(/division by zero/)
  })

  it('is the inverse of multiply', () => {
    for (const [a, b] of [[0x53, 0xca], [0x01, 0xff], [0xa5, 0x5a]]) {
      const product = gfMul(a!, b!)
      expect(gfDiv(product, b!)).toBe(a)
    }
  })
})

describe('gfPolyEval', () => {
  it('returns constant term at x=0', () => {
    expect(gfPolyEval([0x42, 0x11, 0x22], 0)).toBe(0x42)
    expect(gfPolyEval([0xff, 0x01], 0)).toBe(0xff)
  })

  it('evaluates Horner correctly', () => {
    // f(x) = 5 + 3x + x^2 over GF(2^8)
    // f(2) = 5 ⊕ (3 ⊗ 2) ⊕ (1 ⊗ 2 ⊗ 2)
    //      = 5 ⊕ gfMul(3,2) ⊕ gfMul(gfMul(1,2),2)
    const expected = 5 ^ gfMul(3, 2) ^ gfMul(gfMul(1, 2), 2)
    expect(gfPolyEval([5, 3, 1], 2)).toBe(expected)
  })
})

describe('lagrangeInterpolateAtZero', () => {
  it('recovers the constant term of a polynomial given k evaluation points', () => {
    // Polynomial: f(x) = 42 + 13x (degree 1 → needs 2 points)
    const coeffs = [42, 13]
    const points: [number, number][] = [
      [1, gfPolyEval(coeffs, 1)],
      [2, gfPolyEval(coeffs, 2)],
    ]
    expect(lagrangeInterpolateAtZero(points)).toBe(42)
  })

  it('recovers from any subset of enough points (degree-2 polynomial)', () => {
    const coeffs = [0x37, 0xa1, 0x5c]  // f(x) = 0x37 + 0xa1 x + 0x5c x²
    const allPoints: [number, number][] = [1, 2, 3, 4, 5].map(x => [x, gfPolyEval(coeffs, x)])
    // Pick any 3 (= k=3)
    const subsets: [number, number][][] = [
      [allPoints[0]!, allPoints[1]!, allPoints[2]!],
      [allPoints[1]!, allPoints[3]!, allPoints[4]!],
      [allPoints[0]!, allPoints[2]!, allPoints[4]!],
    ]
    for (const s of subsets) {
      expect(lagrangeInterpolateAtZero(s)).toBe(0x37)
    }
  })

  it('recovers when one y-value is zero (byte == 0 edge case)', () => {
    // f(x) = 0 (constant). All ys are 0; reconstruction gives 0.
    const points: [number, number][] = [[1, 0], [2, 0]]
    expect(lagrangeInterpolateAtZero(points)).toBe(0)
  })
})
