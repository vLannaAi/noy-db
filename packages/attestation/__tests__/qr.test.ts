import { describe, it, expect } from 'vitest'
import { encodeQr, decodeQr } from '../src/qr.js'
import type { QrPayload } from '../src/qr.js'
import { bytesToB64url, utf8 } from '../src/encoding.js'

const payload: QrPayload = {
  v: 1, docId: '01J0ABCDEF', salt: 'c2FsdA', alg: 'ed25519', keyId: 'abcdef0123456789',
  fieldHashes: ['aaa', 'bbb'], sig: 'c2ln',
}

describe('QR codec', () => {
  it('encode → decode round-trips', () => {
    expect(decodeQr(encodeQr(payload))).toEqual(payload)
  })
  it('encoded string is url-safe', () => {
    expect(encodeQr(payload)).not.toMatch(/[+/=]/)
  })
  it('rejects a non-v1 payload on decode', () => {
    const bad = encodeQr({ ...payload, v: 2 as unknown as 1 })
    expect(() => decodeQr(bad)).toThrow(/version/)
  })
  it('rejects structurally invalid payloads', () => {
    expect(() => decodeQr('not-base64url!!!')).toThrow(/invalid/)
    const missing = encodeQr({ ...payload, sig: undefined as unknown as string })
    expect(() => decodeQr(missing)).toThrow(/sig|invalid/)
  })
  it('rejects non-object JSON (null / array) with a controlled error, not a raw TypeError', () => {
    expect(() => decodeQr(bytesToB64url(utf8('null')))).toThrow(/invalid/)
    expect(() => decodeQr(bytesToB64url(utf8('[1,2,3]')))).toThrow(/invalid/)
  })
})
