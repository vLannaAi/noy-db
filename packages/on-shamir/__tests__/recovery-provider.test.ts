import { describe, it, expect } from 'vitest'
import { shamirRecoveryProvider } from '../src/index.js'

describe('shamirRecoveryProvider', () => {
  it('round-trips a secret through split/combine (2-of-3)', () => {
    const p = shamirRecoveryProvider()
    const secret = new Uint8Array(32).map((_, i) => i + 1)
    const shares = p.splitToShares(secret, 2, 3)
    expect(shares).toHaveLength(3)
    expect(p.combineShares([shares[0]!, shares[2]!])).toEqual(secret)
  })

  it('throws when below threshold / on garbage', () => {
    const p = shamirRecoveryProvider()
    expect(() => p.combineShares(['not-a-share'])).toThrow()
  })
})
