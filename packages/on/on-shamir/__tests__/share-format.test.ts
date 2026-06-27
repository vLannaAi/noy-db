import { describe, expect, it } from 'vitest'
import {
  decodeShareBase32,
  decodeShareBytes,
  decodeShareJSON,
  encodeShareBase32,
  encodeShareBytes,
  encodeShareJSON,
} from '../src/share-format.js'
import { splitSecret } from '../src/shamir.js'

describe('encode/decode share bytes', () => {
  it('round-trips through binary serialisation', () => {
    const shares = splitSecret(new Uint8Array([0x37, 0xa1, 0x5c]), 2, 3)
    for (const share of shares) {
      const bytes = encodeShareBytes(share)
      const decoded = decodeShareBytes(bytes)
      expect(decoded.x).toBe(share.x)
      expect(decoded.k).toBe(share.k)
      expect(decoded.n).toBe(share.n)
      expect(Array.from(decoded.y)).toEqual(Array.from(share.y))
    }
  })

  it('throws on truncated bytes', () => {
    expect(() => decodeShareBytes(new Uint8Array([1, 2]))).toThrow(/too short/)
  })

  it('throws on wrong version', () => {
    const bytes = new Uint8Array([99, 1, 2, 3, 0, 0])  // version = 99
    expect(() => decodeShareBytes(bytes)).toThrow(/unsupported share version/)
  })

  it('throws on x=0', () => {
    const bytes = new Uint8Array([1, 0, 2, 3, 0, 1, 0xaa])
    expect(() => decodeShareBytes(bytes)).toThrow(/x=0/)
  })

  it('throws on length mismatch', () => {
    const bytes = new Uint8Array([1, 1, 2, 3, 0, 10, 0xaa, 0xbb])  // says length 10, only 2 bytes
    expect(() => decodeShareBytes(bytes)).toThrow(/length mismatch/)
  })
})

describe('encode/decode share Base32', () => {
  it('round-trips through Base32 strings', () => {
    const shares = splitSecret(new Uint8Array([0x37, 0xa1, 0x5c, 0xff, 0x00, 0x80]), 3, 5)
    for (const share of shares) {
      const str = encodeShareBase32(share)
      const decoded = decodeShareBase32(str)
      expect(decoded.x).toBe(share.x)
      expect(decoded.k).toBe(share.k)
      expect(decoded.n).toBe(share.n)
      expect(Array.from(decoded.y)).toEqual(Array.from(share.y))
    }
  })

  it('produces strings containing the x-coordinate prefix for eye-readability', () => {
    const shares = splitSecret(new Uint8Array([0x00, 0x01]), 2, 3)
    const str = encodeShareBase32(shares[1]!)  // x=2
    expect(str).toMatch(/^SHAMIR_S2_K2N3__/)
  })

  it('tolerates whitespace, lowercase, and stripped hyphens', () => {
    const share = splitSecret(new Uint8Array([0xff, 0x80]), 2, 3)[0]!
    const str = encodeShareBase32(share)
    const uglified = str.toLowerCase().replace(/-/g, '').split('').join(' ')
    const decoded = decodeShareBase32(uglified)
    expect(Array.from(decoded.y)).toEqual(Array.from(share.y))
  })
})

describe('encode/decode share JSON', () => {
  it('round-trips through JSON form', () => {
    const share = splitSecret(new Uint8Array([0x01, 0x02, 0x03, 0x04]), 2, 3)[0]!
    const json = encodeShareJSON(share)
    expect(json.v).toBe(1)
    expect(json.x).toBe(share.x)
    expect(json.k).toBe(share.k)
    expect(json.n).toBe(share.n)
    expect(typeof json.y).toBe('string')

    const decoded = decodeShareJSON(json)
    expect(decoded.x).toBe(share.x)
    expect(Array.from(decoded.y)).toEqual(Array.from(share.y))
  })

  it('rejects wrong version on decode', () => {
    expect(() => decodeShareJSON({ v: 99 as unknown as 1, x: 1, k: 2, n: 3, y: '' })).toThrow(/unsupported share version/)
  })
})
