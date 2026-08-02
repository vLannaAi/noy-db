/**
 * Tests for `.noydb` pod header format v2 — the sig/keyId/sigAlg
 * signature fields added for #943 (Task 2, format-layer only; no
 * signing logic here).
 */

import { describe, it, expect } from 'vitest'
import {
  validateBundleHeader,
  encodeBundleHeader,
  decodeBundleHeader,
  NOYDB_BUNDLE_FORMAT_VERSION,
  NOYDB_BUNDLE_FORMAT_VERSION_SIGNED,
} from '../src/with-pod/format.js'

describe('pod header v2 — sig/keyId/sigAlg', () => {
  const baseV1 = {
    formatVersion: NOYDB_BUNDLE_FORMAT_VERSION,
    handle: '01HYABCDEFGHJKMNPQRSTVWXYZ',
    bodyBytes: 1234,
    bodySha256: 'a'.repeat(64),
  }

  const signedTuple = {
    sig: 'c29tZS1zaWduYXR1cmUtYnl0ZXM',
    keyId: '0123456789abcdef',
    sigAlg: 'ed25519' as const,
  }

  it('accepts a v2 header carrying the full sig tuple', () => {
    expect(() =>
      validateBundleHeader({
        ...baseV1,
        formatVersion: NOYDB_BUNDLE_FORMAT_VERSION_SIGNED,
        ...signedTuple,
      }),
    ).not.toThrow()
  })

  it('rejects a partial tuple (sig without keyId/sigAlg)', () => {
    expect(() =>
      validateBundleHeader({
        ...baseV1,
        formatVersion: NOYDB_BUNDLE_FORMAT_VERSION_SIGNED,
        sig: signedTuple.sig,
      }),
    ).toThrow(/present together or not at all/)
  })

  it('rejects the full tuple paired with formatVersion 1', () => {
    expect(() =>
      validateBundleHeader({
        ...baseV1,
        formatVersion: NOYDB_BUNDLE_FORMAT_VERSION,
        ...signedTuple,
      }),
    ).toThrow(/formatVersion === 2/)
  })

  it('rejects a malformed keyId', () => {
    expect(() =>
      validateBundleHeader({
        ...baseV1,
        formatVersion: NOYDB_BUNDLE_FORMAT_VERSION_SIGNED,
        ...signedTuple,
        keyId: 'not-hex',
      }),
    ).toThrow(/header\.keyId must be a 16-character lowercase hex fingerprint/)
  })

  it('still validates a plain v1 header with no sig fields', () => {
    expect(() => validateBundleHeader(baseV1)).not.toThrow()
  })

  it('round-trips a signed v2 header through encode/decode', () => {
    const header = {
      ...baseV1,
      formatVersion: NOYDB_BUNDLE_FORMAT_VERSION_SIGNED,
      ...signedTuple,
    }
    const bytes = encodeBundleHeader(header)
    const decoded = decodeBundleHeader(bytes)
    expect(decoded).toEqual(header)
  })
})
