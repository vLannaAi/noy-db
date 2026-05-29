import { describe, it, expect } from 'vitest'
import { canonicalJson, sha256Hex, sha256Bytes, bytesToHex, bytesToB64url, b64urlToBytes, utf8 } from '../src/encoding.js'

describe('canonicalJson', () => {
  it('sorts object keys and is deterministic regardless of literal order', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
    expect(canonicalJson({ a: 2, b: 1 })).toBe('{"a":2,"b":1}')
  })
  it('encodes arrays in order and nests', () => {
    expect(canonicalJson([1, 'x', { z: true }])).toBe('[1,"x",{"z":true}]')
  })
  it('matches a fixed conformance vector (shared contract with the ledger)', () => {
    expect(canonicalJson(['s4lt', 'total', '123450'])).toBe('["s4lt","total","123450"]')
  })
  it('throws on non-finite numbers and undefined', () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(/non-finite/)
    expect(() => canonicalJson(undefined)).toThrow(/undefined/)
  })
  it('conformance: object keys are sorted (the load-bearing difference vs JSON.stringify), and nested undefined throws', () => {
    expect(canonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}')
    expect(canonicalJson({ z: { y: 1, x: 2 } })).toBe('{"z":{"x":2,"y":1}}')
    expect(() => canonicalJson({ a: undefined })).toThrow(/undefined/)
  })
})

describe('sha256', () => {
  it('sha256Hex matches a known vector for the empty string', async () => {
    expect(await sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })
  it('sha256Hex matches a known vector for "abc"', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
  it('sha256Bytes returns 32 bytes', async () => {
    expect((await sha256Bytes('abc')).length).toBe(32)
  })
})

describe('hex + base64url round-trips', () => {
  it('bytesToHex of a known buffer', () => {
    expect(bytesToHex(new Uint8Array([0, 1, 254, 255]))).toBe('0001feff')
  })
  it('base64url round-trips arbitrary bytes and is url-safe (no +,/,=)', () => {
    const b = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255])
    const enc = bytesToB64url(b)
    expect(enc).not.toMatch(/[+/=]/)
    expect([...b64urlToBytes(enc)]).toEqual([...b])
  })
  it('utf8 encodes to bytes', () => {
    expect([...utf8('A')]).toEqual([65])
  })
  it('base64url round-trips 1-byte and 2-byte inputs (padding restoration)', () => {
    expect([...b64urlToBytes(bytesToB64url(new Uint8Array([0xab])))]).toEqual([0xab])
    expect([...b64urlToBytes(bytesToB64url(new Uint8Array([0xab, 0xcd])))]).toEqual([0xab, 0xcd])
  })
})
