import { describe, expect, it } from 'vitest'
import { combineSecret, splitSecret } from '../src/shamir.js'

// Helper — iterate every k-subset of an n-set and reconstruct.
function* kSubsets<T>(items: readonly T[], k: number): Generator<readonly T[]> {
  if (k < 1) return
  if (k === 1) {
    for (const x of items) yield [x]
    return
  }
  for (let i = 0; i <= items.length - k; i++) {
    const head = items[i]!
    for (const tail of kSubsets(items.slice(i + 1), k - 1)) {
      yield [head, ...tail]
    }
  }
}

describe('splitSecret / combineSecret', () => {
  it('k=2, n=3 — any 2 shares reconstruct the secret', () => {
    const secret = new Uint8Array([0x37, 0xa1, 0x5c, 0x00, 0xff, 0xab])
    const shares = splitSecret(secret, 2, 3)
    expect(shares).toHaveLength(3)

    // Every 2-subset reconstructs
    for (const subset of kSubsets(shares, 2)) {
      const recovered = combineSecret(subset)
      expect(Array.from(recovered)).toEqual(Array.from(secret))
    }
  })

  it('k=3, n=5 — any 3 of 5 reconstruct', () => {
    const secret = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    const shares = splitSecret(secret, 3, 5)
    let subsetCount = 0
    for (const subset of kSubsets(shares, 3)) {
      const recovered = combineSecret(subset)
      expect(Array.from(recovered)).toEqual(Array.from(secret))
      subsetCount++
    }
    // C(5, 3) = 10
    expect(subsetCount).toBe(10)
  })

  it('k = n — requires every share', () => {
    const secret = new Uint8Array([42])
    const shares = splitSecret(secret, 3, 3)
    const recovered = combineSecret(shares)
    expect(Array.from(recovered)).toEqual([42])
  })

  it('handles a 32-byte KEK-sized secret', () => {
    const secret = crypto.getRandomValues(new Uint8Array(32))
    const shares = splitSecret(secret, 2, 3)
    for (const subset of kSubsets(shares, 2)) {
      const recovered = combineSecret(subset)
      expect(Array.from(recovered)).toEqual(Array.from(secret))
    }
  })

  it('handles an all-zero secret', () => {
    const secret = new Uint8Array(16)
    const shares = splitSecret(secret, 2, 3)
    for (const subset of kSubsets(shares, 2)) {
      const recovered = combineSecret(subset)
      expect(Array.from(recovered)).toEqual(Array.from(secret))
    }
  })

  it('handles a secret with high bytes (tests reduction polynomial)', () => {
    const secret = new Uint8Array([0xff, 0xfe, 0xfd, 0x80, 0x7f, 0x00])
    const shares = splitSecret(secret, 3, 4)
    for (const subset of kSubsets(shares, 3)) {
      const recovered = combineSecret(subset)
      expect(Array.from(recovered)).toEqual(Array.from(secret))
    }
  })

  it('throws when fewer than k shares are provided', () => {
    const shares = splitSecret(new Uint8Array([1, 2, 3]), 3, 5)
    expect(() => combineSecret(shares.slice(0, 2))).toThrow(/insufficient shares/)
  })

  it('throws on mismatched share lengths (incompatible enrollments)', () => {
    const sharesA = splitSecret(new Uint8Array([1, 2]), 2, 3)
    const sharesB = splitSecret(new Uint8Array([1, 2, 3]), 2, 3)
    expect(() => combineSecret([sharesA[0]!, sharesB[0]!])).toThrow(/share lengths disagree/)
  })

  it('throws on duplicate x-coordinates', () => {
    const shares = splitSecret(new Uint8Array([1, 2]), 2, 3)
    expect(() => combineSecret([shares[0]!, shares[0]!])).toThrow(/duplicate x-coordinates/)
  })

  it('throws on empty share list', () => {
    expect(() => combineSecret([])).toThrow(/no shares/)
  })

  it('rejects invalid k or n at split time', () => {
    expect(() => splitSecret(new Uint8Array([1]), 1, 3)).toThrow(/k must be/)
    expect(() => splitSecret(new Uint8Array([1]), 5, 3)).toThrow(/n must satisfy/)
    expect(() => splitSecret(new Uint8Array([1]), 2, 256)).toThrow(/n must satisfy/)
  })

  it('rejects an empty secret', () => {
    expect(() => splitSecret(new Uint8Array(0), 2, 3)).toThrow(/at least 1 byte/)
  })

  it('different randomness produces different shares but same reconstruction', () => {
    // Use injectable randomness to make the test deterministic
    const det = (val: number) => (count: number) => new Uint8Array(count).fill(val)
    const secret = new Uint8Array([0x10, 0x20, 0x30])

    const sharesA = splitSecret(secret, 2, 3, det(0xaa))
    const sharesB = splitSecret(secret, 2, 3, det(0xbb))

    // Y bytes differ
    expect(Array.from(sharesA[0]!.y)).not.toEqual(Array.from(sharesB[0]!.y))
    // But both reconstruct the same secret
    expect(Array.from(combineSecret([sharesA[0]!, sharesA[1]!]))).toEqual(Array.from(secret))
    expect(Array.from(combineSecret([sharesB[0]!, sharesB[1]!]))).toEqual(Array.from(secret))
  })
})
