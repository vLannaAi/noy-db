import { describe, expect, it } from 'vitest'
import { combineKEK, splitKEK } from '../src/index.js'

async function freshKEK(extractable = true): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    extractable,
    ['encrypt', 'decrypt'],
  )
}

async function assertSameKey(original: CryptoKey, candidate: CryptoKey): Promise<void> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const plaintext = new TextEncoder().encode('shamir-equivalence-probe')
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    original,
    plaintext as BufferSource,
  )
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    candidate,
    ct,
  )
  expect(new TextDecoder().decode(pt)).toBe('shamir-equivalence-probe')
}

describe('splitKEK + combineKEK', () => {
  it('k=2 n=3 — any 2 shares reconstruct a functionally-equivalent KEK', async () => {
    const kek = await freshKEK()
    const shares = await splitKEK(kek, { k: 2, n: 3 })
    expect(shares).toHaveLength(3)

    // Any combination of 2 shares reconstructs
    for (const pair of [[0, 1], [0, 2], [1, 2]] as const) {
      const [i, j] = pair
      const reconstructed = await combineKEK([shares[i]!, shares[j]!])
      await assertSameKey(kek, reconstructed)
    }
  })

  it('k=3 n=5 — reconstructs from any 3', async () => {
    const kek = await freshKEK()
    const shares = await splitKEK(kek, { k: 3, n: 5 })
    const reconstructed = await combineKEK([shares[0]!, shares[2]!, shares[4]!])
    await assertSameKey(kek, reconstructed)
  })

  it('returns a non-extractable KEK', async () => {
    const kek = await freshKEK()
    const shares = await splitKEK(kek, { k: 2, n: 3 })
    const reconstructed = await combineKEK([shares[0]!, shares[1]!])
    // Attempting to export raw should fail — reconstructed key is non-extractable.
    await expect(crypto.subtle.exportKey('raw', reconstructed)).rejects.toThrow()
  })

  it('rejects insufficient shares at combine time', async () => {
    const kek = await freshKEK()
    const shares = await splitKEK(kek, { k: 3, n: 5 })
    await expect(combineKEK([shares[0]!, shares[1]!])).rejects.toThrow(/insufficient shares/)
  })
})
